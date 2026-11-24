import type {
  JoinResponse,
  RoomSnapshot,
  TrackReference,
} from "../shared/protocol";
import { ApiError, RoomApi } from "./api";
import { startRoomBackground } from "./background";
import { setCallMediaSession } from "./call-media-session";
import {
  ClientLifecycleController,
  type ClientLifecycleTransition,
  type LifecycleTransitionContext,
} from "./lifecycle";
import { MediaSessions } from "./media";
import {
  startVoiceCallSession,
  stopVoiceCallSession,
} from "./voice-call-session";
import { buildInviteUrl, passwordStorageKey } from "./ws-bootstrap";

const MEDIA_DRAIN_TIMEOUT_MS = 1_000;
const SETUP_ATTEMPTS = 3;

type ActiveRoom = {
  api: RoomApi;
  participantId: string;
  localStream: MediaStream;
  media?: MediaSessions;
};

export type JoinedRoomView = {
  snapshot: RoomSnapshot;
  selfId: string;
  localStream: MediaStream;
  remoteStreams: ReadonlyMap<string, MediaStream>;
};

export type RoomViewState = {
  displayName: string;
  transition?: ClientLifecycleTransition;
  room?: JoinedRoomView;
  status: {
    message: string;
    tone: "error" | "ok" | "warning" | "neutral";
  };
};

export type RoomController = ReturnType<typeof createRoomController>;

/** One page lifetime owns membership and media; React only subscribes to its view. */
export function createRoomController() {
  const roomId = resolveRoomId();
  const clientId = sessionValue(
    "video-room-client",
    () => `c_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  let view: RoomViewState = {
    displayName: sessionStorage.getItem("video-room-name") ?? "",
    status: { message: "Enter a name to join.", tone: "neutral" },
  };
  const listeners = new Set<() => void>();
  let activeRoom: ActiveRoom | undefined;
  let stopBackground: (() => void) | undefined;
  const streams = new Map<string, MediaStream>();
  const lifecycle = new ClientLifecycleController(handleLifecycleChange);
  let unloadBound = false;
  let visibilityBound = false;
  /** Desired mute for SFU senders — reapplied after every publish/reconnect. */
  let micMutedDesired = false;

  bindUnloadLeave();
  bindVisibilityResume();

  return {
    roomId,
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDisplayName(displayName: string) {
      updateView({ displayName });
    },
    join: () => enterRoom(false),
    leave: leaveRoom,
    terminate: terminateRoom,
    copyLink,
    setMicMuted(muted: boolean) {
      micMutedDesired = muted;
      activeRoom?.media?.setLocalAudioMuted(muted);
    },
    resume() {
      if (
        sessionStorage.getItem("video-room-joined") === "true" &&
        sessionStorage.getItem("video-room-token") &&
        view.displayName
      ) {
        void enterRoom(true);
      }
    },
  };

  /** Tab close/refresh must release SFU sessions without waiting for stale timeout. */
  function bindUnloadLeave(): void {
    if (unloadBound || typeof window === "undefined") return;
    unloadBound = true;
    const onUnload = () => {
      leaveBestEffortOnUnload();
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
  }

  /**
   * After screen unlock / app foreground, reconnect if media or signaling died.
   * Do not tear down tracks merely because the document was hidden.
   */
  function bindVisibilityResume(): void {
    if (visibilityBound || typeof document === "undefined") return;
    visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const room = activeRoom;
      if (!room || lifecycle.active !== undefined) return;
      const mediaDead = room.media?.needsReconnect?.() === true;
      if (mediaDead) {
        setStatus("Reconnecting after screen unlock…", "warning");
        void scheduleReconnect(room);
      }
    });
  }

  function leaveBestEffortOnUnload(): void {
    const room = activeRoom;
    if (!room) return;
    stopBackgroundWork();
    activeRoom = undefined;
    setCallMediaSession(false);
    void stopVoiceCallSession();
    try {
      room.media?.close();
    } catch {
      // Page is tearing down.
    }
    for (const track of room.localStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
    streams.clear();
    sessionStorage.removeItem("video-room-joined");
    // Keep member token briefly so keepalive leave can authorize; clear pending.
    sessionStorage.removeItem("video-room-pending-token");
    room.api.leaveKeepalive();
    sessionStorage.removeItem("video-room-token");
  }

  function updateView(patch: Partial<RoomViewState>): void {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  }

  async function copyLink(listenOnly = false): Promise<void> {
    const generation = lifecycle.generation;
    const idleAtStart = lifecycle.active === undefined;
    try {
      const password = sessionStorage.getItem(passwordStorageKey(roomId));
      const link =
        password && password.length >= 8
          ? buildInviteUrl(roomId, password, { listenOnly })
          : `${location.origin}/rooms/${roomId}`;
      await navigator.clipboard.writeText(link);
      if (
        idleAtStart &&
        lifecycle.isCurrentGeneration(generation) &&
        lifecycle.active === undefined
      ) {
        setStatus(
          password && password.length >= 8
            ? listenOnly
              ? "Listener invite copied (guests join muted)."
              : "Speaker invite copied (includes room access)."
            : "Room link copied. Add the room password for guests.",
          "ok",
        );
      }
    } catch (error) {
      if (idleAtStart && lifecycle.isCurrentGeneration(generation)) {
        showError(error);
      }
    }
  }

  async function enterRoom(resume: boolean): Promise<void> {
    try {
      await lifecycle.run(resume ? "resume" : "join", async (transition) => {
        const displayName = view.displayName.trim();
        if (!displayName) {
          transition.commit(() => {
            setStatus("Enter a display name before joining.", "error");
          });
          return;
        }
        await establishRoom(transition, displayName, activeRoom);
      });
    } catch (error) {
      if (isAbortError(error)) return;
      showError(error);
      if (!activeRoom) showLobby();
    }
  }

  async function establishRoom(
    transition: LifecycleTransitionContext,
    displayName: string,
    previousRoom: ActiveRoom | undefined,
  ): Promise<void> {
    const { localIdentity, pendingMemberToken } = transition.commit(() => {
      sessionStorage.setItem("video-room-name", displayName);
      return {
        localIdentity: sessionValue("video-room-local-identity", () =>
          localIdentityFor(displayName, clientId),
        ),
        pendingMemberToken: sessionValue(
          "video-room-pending-token",
          createCapability,
        ),
      };
    });
    let roomStream = previousRoom?.localStream;
    let acquiredStream = false;
    let memberToken =
      previousRoom?.api.memberToken ??
      sessionStorage.getItem("video-room-token") ??
      undefined;
    let reconnectRequestId = lifecycleRequestId();
    let committed = false;

    try {
      for (let attempt = 0; attempt < SETUP_ATTEMPTS; attempt += 1) {
        let sessionEstablished = false;
        try {
          transition.commit(() => {
            setStatus(
              setupStatus(transition.kind, attempt),
              attempt === 0 && transition.kind !== "reconnect"
                ? "neutral"
                : "warning",
            );
          });

          if (!roomStream) {
            const acquired = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false,
              },
              video: false,
            });
            if (!transition.isCurrent) {
              for (const track of acquired.getTracks()) track.stop();
              transition.throwIfSuperseded();
            }
            roomStream = acquired;
            acquiredStream = true;
          }

          const stream = roomStream;
          transition.throwIfSuperseded();
          const roomApi = new RoomApi(roomId, localIdentity);
          roomApi.memberToken = memberToken;
          const joined = roomApi.memberToken
            ? await reconnectOrJoin(
                roomApi,
                clientId,
                displayName,
                reconnectRequestId,
                pendingMemberToken,
                transition.signal,
              )
            : await roomApi.join(
                clientId,
                displayName,
                pendingMemberToken,
                transition.signal,
              );
          transition.throwIfSuperseded();
          sessionEstablished = true;
          memberToken = joined.memberToken;
          if (joined.snapshot.terminated) {
            throw new Error("The room has already been terminated.");
          }
          transition.commit(() => {
            if (previousRoom && activeRoom === previousRoom) {
              previousRoom.api = roomApi;
              previousRoom.participantId = joined.participantId;
            }
            // Membership is confirmed even if a later media setup request fails.
            sessionStorage.removeItem("video-room-pending-token");
            sessionStorage.setItem("video-room-token", joined.memberToken);
            sessionStorage.setItem("video-room-joined", "true");
          });

          const candidate: ActiveRoom = {
            api: roomApi,
            participantId: joined.participantId,
            localStream: stream,
          };
          const pendingTracks = new Map<
            string,
            { reference: TrackReference; track: MediaStreamTrack }
          >();
          const candidateMedia = new MediaSessions(
            roomApi,
            joined.generation,
            stream,
            (reference, track) => {
              if (!transition.isCurrent) return;
              if (activeRoom !== candidate) {
                pendingTracks.set(
                  `${reference.participantId}:${reference.kind}`,
                  { reference, track },
                );
                return;
              }
              attachRemoteTrack(candidate, reference, track);
            },
            () => {
              if (transition.isCurrent && activeRoom === candidate) {
                void scheduleReconnect(candidate);
              }
            },
          );
          candidate.media = candidateMedia;
          const closeCandidate = () => candidateMedia.close();
          try {
            transition.signal.addEventListener("abort", closeCandidate, {
              once: true,
            });
            await candidateMedia.publish();
            transition.throwIfSuperseded();
            // Apply mute via silent keepalive after publish — never mid-reconnect refresh.
            candidateMedia.setLocalAudioMuted(micMutedDesired);
            await candidateMedia.syncSubscriptions(
              joined.snapshot,
              joined.participantId,
            );
            transition.commit(() => {
              const replaced = activeRoom;
              if (replaced) streams.clear();
              activeRoom = candidate;
              committed = true;
              showRoom(candidate, joined.snapshot);
              for (const { reference, track } of pendingTracks.values()) {
                attachRemoteTrack(candidate, reference, track);
              }
              pendingTracks.clear();
              replaced?.media?.close();
              candidateMedia.setLocalAudioMuted(micMutedDesired);
              setStatus("Connected.", "ok");
              void startVoiceCallSession(roomId, "Voice Room");
              setCallMediaSession(true, roomId);
            });
            return;
          } finally {
            transition.signal.removeEventListener("abort", closeCandidate);
            if (activeRoom !== candidate) candidateMedia.close();
          }
        } catch (error) {
          transition.throwIfSuperseded();
          const canRetry =
            error instanceof ApiError &&
            (error.retryable || error.code === "media_generation_stale");
          if (attempt + 1 >= SETUP_ATTEMPTS || !canRetry) {
            throw error;
          }
          // Stale generation needs a new reconnect id so the server bumps sessions.
          reconnectRequestId = lifecycleRequestId();
          await delayWithSignal(250 * 2 ** attempt, transition.signal);
        }
      }
    } finally {
      if (acquiredStream && !committed && roomStream) {
        for (const track of roomStream.getTracks()) track.stop();
      }
    }
  }

  async function reconnectOrJoin(
    roomApi: RoomApi,
    currentClientId: string,
    displayName: string,
    requestId: string,
    pendingMemberToken: string,
    signal: AbortSignal,
  ): Promise<JoinResponse> {
    try {
      return await roomApi.reconnect(
        currentClientId,
        displayName,
        requestId,
        signal,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "member_token_invalid" ||
          error.code === "resume_required" ||
          error.code === "client_mismatch")
      ) {
        roomApi.memberToken = undefined;
        sessionStorage.removeItem("video-room-token");
        return roomApi.join(
          currentClientId,
          displayName,
          pendingMemberToken,
          signal,
        );
      }
      throw error;
    }
  }

  async function scheduleReconnect(room = activeRoom): Promise<void> {
    if (!room || activeRoom !== room || lifecycle.active !== undefined) {
      return;
    }
    try {
      await lifecycle.run("reconnect", async (transition) => {
        transition.throwIfSuperseded();
        if (activeRoom !== room) return;
        await detachAndDrainMedia(room, transition);
        await establishRoom(transition, view.displayName.trim(), room);
      });
    } catch (error) {
      if (isAbortError(error)) return;
      // Stale generation is recovery, not a terminal failure — retry quietly.
      if (
        error instanceof ApiError &&
        error.code === "media_generation_stale" &&
        activeRoom === room
      ) {
        setStatus("Refreshing media session…", "warning");
        window.setTimeout(() => {
          if (activeRoom === room && lifecycle.active === undefined) {
            void scheduleReconnect(room);
          }
        }, 300);
        return;
      }
      if (activeRoom === room) showError(error);
    }
  }

  async function leaveRoom(): Promise<void> {
    const room = activeRoom;
    if (!room) return;
    await runTerminalTransition(
      "leave",
      room,
      "Leaving...",
      "You left the room.",
      (signal) => room.api.leave(signal),
    );
  }

  async function terminateRoom(): Promise<void> {
    if (!confirm("Terminate this room for every participant?")) return;
    const room = activeRoom;
    if (!room) return;
    await runTerminalTransition(
      "terminate",
      room,
      "Terminating the room...",
      "Room terminated.",
      (signal) => room.api.terminate(signal),
    );
  }

  async function runTerminalTransition(
    kind: Extract<ClientLifecycleTransition, "leave" | "terminate">,
    room: ActiveRoom,
    pendingStatus: string,
    successStatus: string,
    request: (signal: AbortSignal) => Promise<RoomSnapshot>,
  ): Promise<void> {
    try {
      await lifecycle.run(kind, async (transition) => {
        transition.throwIfSuperseded();
        if (activeRoom !== room) return;
        setStatus(pendingStatus);
        await detachAndDrainMedia(room, transition);
        await request(transition.signal);
        transition.commit(() => {
          resetLocalSession(room);
          setStatus(successStatus, "ok");
        });
      });
    } catch (error) {
      if (isAbortError(error)) return;
      if (activeRoom === room) showError(error);
    }
  }

  async function observeTermination(room: ActiveRoom): Promise<void> {
    try {
      await lifecycle.run("terminate", async (transition) => {
        transition.throwIfSuperseded();
        if (activeRoom !== room) return;
        await detachAndDrainMedia(room, transition);
        transition.commit(() => {
          resetLocalSession(room);
          setStatus("The room creator terminated this room.", "error");
        });
      });
    } catch (error) {
      if (!isAbortError(error) && activeRoom === room) showError(error);
    }
  }

  async function detachAndDrainMedia(
    room: ActiveRoom,
    transition: LifecycleTransitionContext,
  ): Promise<void> {
    const media = transition.commit(() => {
      const current = room.media;
      room.media = undefined;
      return current;
    });
    await media?.closeAndWait(MEDIA_DRAIN_TIMEOUT_MS);
    transition.throwIfSuperseded();
  }

  function showRoom(room: ActiveRoom, snapshot: RoomSnapshot): void {
    if (activeRoom !== room) return;
    if (snapshot.terminated) {
      void observeTermination(room);
      return;
    }
    const activeIds = new Set(
      snapshot.participants.map((participant) => participant.id),
    );
    for (const id of streams.keys()) {
      if (!activeIds.has(id)) streams.delete(id);
    }
    updateView({
      room: {
        snapshot,
        selfId: room.participantId,
        localStream: room.localStream,
        remoteStreams: new Map(streams),
      },
    });
  }

  function showLobby(): void {
    updateView({ room: undefined });
  }

  function attachRemoteTrack(
    room: ActiveRoom,
    reference: TrackReference,
    track: MediaStreamTrack,
  ): void {
    if (activeRoom !== room || track.readyState === "ended") return;
    let stream = streams.get(reference.participantId);
    if (!stream) {
      stream = new MediaStream();
      streams.set(reference.participantId, stream);
    }
    for (const existing of stream.getTracks()) {
      if (existing.kind === track.kind || existing.readyState === "ended") {
        stream.removeTrack(existing);
      }
    }
    stream.addTrack(track);
    if (view.room) {
      updateView({ room: { ...view.room, remoteStreams: new Map(streams) } });
    }
  }

  function handleLifecycleChange(
    transition: ClientLifecycleTransition | undefined,
  ): void {
    if (transition) stopBackgroundWork();
    updateView({ transition });
    if (!transition && activeRoom) startBackgroundWork(activeRoom);
  }

  function startBackgroundWork(room: ActiveRoom): void {
    if (activeRoom !== room || lifecycle.active !== undefined) {
      return;
    }
    stopBackgroundWork();
    const generation = lifecycle.generation;
    stopBackground = startRoomBackground({
      api: room.api,
      isCurrent: () =>
        activeRoom === room &&
        lifecycle.active === undefined &&
        lifecycle.isCurrentGeneration(generation),
      onError(error) {
        if (
          error instanceof ApiError &&
          (error.retryable || error.code === "media_generation_stale")
        ) {
          // Reconnect recovers stale SFU generations; avoid sticky error spam.
          if (error.code === "media_generation_stale") {
            setStatus("Refreshing media session…", "warning");
          } else {
            showError(error);
          }
          void scheduleReconnect(room);
          return;
        }
        showError(error);
      },
      async onSnapshot(snapshot) {
        if (activeRoom !== room || !room.media) return;
        showRoom(room, snapshot);
        try {
          await room.media.syncSubscriptions(snapshot, room.participantId);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.code === "media_generation_stale"
          ) {
            setStatus("Refreshing media session…", "warning");
            void scheduleReconnect(room);
            return;
          }
          throw error;
        }
      },
      onTerminated: () => void observeTermination(room),
    });
  }

  function stopBackgroundWork(): void {
    const stop = stopBackground;
    stopBackground = undefined;
    stop?.();
  }

  function resetLocalSession(room: ActiveRoom): void {
    if (activeRoom !== room) return;
    stopBackgroundWork();
    activeRoom = undefined;
    setCallMediaSession(false);
    void stopVoiceCallSession();
    room.media?.close();
    sessionStorage.removeItem("video-room-token");
    sessionStorage.removeItem("video-room-pending-token");
    sessionStorage.removeItem("video-room-joined");
    for (const track of room.localStream.getTracks()) track.stop();
    streams.clear();
    showLobby();
  }

  function showError(error: unknown): void {
    if (error instanceof ApiError) {
      const suffix = error.requestId ? ` Request ID: ${error.requestId}.` : "";
      setStatus(`${error.message}${suffix}`, "error");
      return;
    }
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      setStatus(
        "Camera or microphone permission was denied. Allow access and try again.",
        "error",
      );
      return;
    }
    setStatus(
      error instanceof Error ? error.message : "The room operation failed.",
      "error",
    );
  }

  function setStatus(
    message: string,
    tone: "error" | "ok" | "warning" | "neutral" = "neutral",
  ): void {
    updateView({ status: { message, tone } });
  }
}

function setupStatus(
  transition: ClientLifecycleTransition,
  attempt: number,
): string {
  if (attempt > 0) {
    return `Retrying room setup (${attempt + 1}/${SETUP_ATTEMPTS})...`;
  }
  if (transition === "reconnect") {
    return "Reconnecting media…";
  }
  return transition === "resume"
    ? "Rejoining the room..."
    : "Requesting camera and microphone...";
}

function resolveRoomId(): string {
  const match = /^\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(
    location.pathname,
  );
  if (match?.[1]) return match[1];
  const generated = `room-${crypto.randomUUID().slice(0, 8)}`;
  history.replaceState(null, "", `/rooms/${generated}`);
  return generated;
}

function localIdentityFor(displayName: string, id: string): string {
  const name =
    displayName
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "local";
  return `${name}-${id.slice(-8)}`;
}

function lifecycleRequestId(): string {
  return `l_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function sessionValue(key: string, create: () => string): string {
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const value = create();
  sessionStorage.setItem(key, value);
  return value;
}

function delayWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
