import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RoomApi } from "./api";
import { lifecycleControlState } from "./lifecycle";
import { openAnotherParticipant } from "./open-participant";
import type {
  JoinedRoomView,
  RoomController,
  RoomViewState,
} from "./room-controller";
import {
  consumeRoomInviteFromLocation,
  createSecretStorageKey,
  guestIdentity,
  passwordStorageKey,
} from "./ws-bootstrap";

enforceVoiceOnlyCapture();
const invitePasswordFromUrl = consumeRoomInviteFromLocation();

export function App({ controller }: { controller: RoomController }) {
  const [password, setPassword] = useState(
    () =>
      invitePasswordFromUrl ??
      sessionStorage.getItem(passwordStorageKey(controller.roomId)) ??
      "",
  );
  const [createSecret, setCreateSecret] = useState(
    () =>
      sessionStorage.getItem(createSecretStorageKey(controller.roomId)) ?? "",
  );
  const [lobbyMode, setLobbyMode] = useState<"join" | "create">("join");
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const controls = lifecycleControlState(state.transition, Boolean(state.room));
  return (
    <>
      <a
        className="fixed top-3 left-3 z-10 -translate-y-20 rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white focus-visible:translate-y-0"
        href="#main-content"
      >
        Skip to room workspace
      </a>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <RoomHeader
          roomId={controller.roomId}
          onCopyLink={controller.copyLink}
        />
        <main
          id="main-content"
          className="group overflow-hidden rounded-b-xl border-x border-b border-stone-200 bg-white shadow-sm"
          tabIndex={-1}
        >
          {state.room ? (
            <Room
              roomId={controller.roomId}
              password={password}
              displayName={state.displayName}
              room={state.room}
              busy={controls.roomBusy}
              leaveDisabled={controls.leaveDisabled}
              onLeave={controller.leave}
              onSetMicMuted={controller.setMicMuted}
            />
          ) : (
            <Lobby
              roomId={controller.roomId}
              displayName={state.displayName}
              busy={controls.joinBusy}
              nameDisabled={controls.displayNameDisabled}
              joinDisabled={controls.joinDisabled}
              password={password}
              createSecret={createSecret}
              mode={lobbyMode}
              onModeChange={setLobbyMode}
              onPasswordChange={setPassword}
              onCreateSecretChange={setCreateSecret}
              onNameChange={controller.setDisplayName}
              onJoin={async () => {
                sessionStorage.setItem(
                  passwordStorageKey(controller.roomId),
                  password,
                );
                if (lobbyMode === "create") {
                  // Fresh room claim — drop old membership so Create owns host.
                  sessionStorage.removeItem("video-room-joined");
                  sessionStorage.removeItem("video-room-token");
                  sessionStorage.removeItem("video-room-pending-token");
                  sessionStorage.setItem(
                    createSecretStorageKey(controller.roomId),
                    createSecret,
                  );
                  await new RoomApi(
                    controller.roomId,
                    guestIdentity(controller.roomId),
                  ).create();
                }
                // Keep member token on Join so resume works; server also
                // takes over if the token was lost but this guest is still active.
                await controller.join();
              }}
            />
          )}
          <StatusBar {...state.status} />
        </main>
      </div>
    </>
  );
}

function RoomHeader({
  roomId,
  onCopyLink,
}: {
  roomId: string;
  onCopyLink: () => Promise<void>;
}) {
  return (
    <header className="grid gap-4 rounded-t-xl border border-stone-200 bg-white p-4 sm:flex sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <a
          className="flex shrink-0 items-center gap-2.5 text-sm font-semibold hover:text-orange-700"
          href="/"
          title="Create a new room"
        >
          <span
            className="flex size-9 items-center justify-center rounded-lg bg-orange-50 text-orange-700"
            aria-hidden="true"
          >
            <svg
              className="size-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="6" width="12" height="12" rx="3" />
              <path d="m15 10 6-3v10l-6-3" />
            </svg>
          </span>
          Realtime
        </a>
        <span className="text-stone-300" aria-hidden="true">
          /
        </span>
        <strong
          id="room-id"
          className="truncate font-mono text-xs font-normal text-stone-600"
        >
          {roomId}
        </strong>
      </div>
      <div
        className="flex flex-wrap items-center gap-2 sm:shrink-0"
        role="group"
        aria-label="Room utilities"
      >
        <button
          id="copy-link"
          onClick={() => void onCopyLink()}
          className="inline-flex min-h-11 cursor-pointer grow items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 motion-reduce:transition-none sm:grow-0"
          type="button"
        >
          <svg
            className="size-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </svg>
          Copy invite link
        </button>
        <button
          id="open-participant"
          onClick={() => openAnotherParticipant()}
          className="inline-flex min-h-11 cursor-pointer grow items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-stone-50 motion-reduce:transition-none sm:grow-0"
          type="button"
        >
          Open another participant
        </button>
      </div>
    </header>
  );
}

function Lobby({
  roomId,
  displayName,
  password,
  createSecret,
  mode,
  busy,
  nameDisabled,
  joinDisabled,
  onModeChange,
  onNameChange,
  onPasswordChange,
  onCreateSecretChange,
  onJoin,
}: {
  roomId: string;
  displayName: string;
  password: string;
  createSecret: string;
  mode: "join" | "create";
  busy: boolean;
  nameDisabled: boolean;
  joinDisabled: boolean;
  onModeChange: (mode: "join" | "create") => void;
  onNameChange: (name: string) => void;
  onPasswordChange: (password: string) => void;
  onCreateSecretChange: (secret: string) => void;
  onJoin: () => Promise<void>;
}) {
  const creating = mode === "create";
  const passwordUnlocked = !creating && password.length >= 8;
  const [lobbyError, setLobbyError] = useState("");
  const submit = async () => {
    setLobbyError("");
    try {
      await onJoin();
    } catch (error) {
      setLobbyError(
        error instanceof Error ? error.message : "Could not join the room.",
      );
    }
  };
  return (
    <section
      id="lobby"
      className="px-5 py-10 sm:px-10 sm:py-14"
      aria-labelledby="lobby-title"
      aria-describedby="status"
    >
      <div className="max-w-xl">
        <h1
          id="lobby-title"
          className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl"
        >
          {creating ? "Create" : "Join"}{" "}
          <span id="lobby-room-id" className="wrap-anywhere">
            {roomId}
          </span>
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-600 sm:text-base">
          {creating
            ? "Set a room password and your host create key. Guests join with the invite link."
            : passwordUnlocked
              ? "Invite unlocked — enter your name to join. This room is audio only."
              : "Enter your name and the room password, or open an invite link. This room is audio only."}
        </p>

        <div
          className="mt-6 inline-flex rounded-lg border border-stone-300 p-1"
          role="group"
          aria-label="Lobby mode"
        >
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              !creating
                ? "bg-stone-900 text-white"
                : "text-stone-700 hover:bg-stone-100"
            }`}
            aria-pressed={!creating}
            onClick={() => onModeChange("join")}
          >
            Join
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              creating
                ? "bg-stone-900 text-white"
                : "text-stone-700 hover:bg-stone-100"
            }`}
            aria-pressed={creating}
            onClick={() => onModeChange("create")}
          >
            Create room
          </button>
        </div>

        <form
          id="join-form"
          className="mt-8 space-y-3"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="display-name" className="block text-sm font-medium">
            Display name
          </label>
          <input
            id="display-name"
            value={displayName}
            onChange={(event) => onNameChange(event.currentTarget.value)}
            disabled={nameDisabled}
            className="min-h-12 w-full min-w-0 rounded-lg border border-stone-500 bg-white px-3.5 py-2.5 text-base shadow-xs placeholder:text-stone-500 enabled:hover:border-stone-600 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-500"
            name="display-name"
            maxLength={48}
            autoComplete="name"
            placeholder="Your name"
            required
          />
          {passwordUnlocked ? (
            <p
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-900"
              role="status"
            >
              Invite unlocked — room password applied from the link.
            </p>
          ) : (
            <>
              <label htmlFor="room-password" className="block text-sm font-medium">
                Room password
              </label>
              <input
                id="room-password"
                value={password}
                onChange={(event) => onPasswordChange(event.currentTarget.value)}
                disabled={nameDisabled}
                className="min-h-12 w-full min-w-0 rounded-lg border border-stone-500 bg-white px-3.5 py-2.5 text-base shadow-xs placeholder:text-stone-500 enabled:hover:border-stone-600 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-500"
                name="room-password"
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete={creating ? "new-password" : "current-password"}
                placeholder="Room password (8+ characters)"
                required
              />
            </>
          )}
          {creating && (
            <>
              <label
                htmlFor="host-create-key"
                className="block text-sm font-medium"
              >
                Host create key
              </label>
              <input
                id="host-create-key"
                value={createSecret}
                onChange={(event) =>
                  onCreateSecretChange(event.currentTarget.value)
                }
                disabled={nameDisabled}
                className="min-h-12 w-full min-w-0 rounded-lg border border-stone-500 bg-white px-3.5 py-2.5 text-base shadow-xs placeholder:text-stone-500 enabled:hover:border-stone-600 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-500"
                name="host-create-key"
                type="password"
                minLength={8}
                maxLength={256}
                autoComplete="off"
                placeholder="Private host create key"
                required
              />
            </>
          )}
          <button
            className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-orange-700 px-5 py-3 text-sm font-semibold text-white shadow-xs transition-colors enabled:hover:bg-orange-800 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:w-auto"
            type="submit"
            disabled={joinDisabled}
          >
            {creating ? "Create and join" : "Join room"}
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14m-5-5 5 5-5 5" />
            </svg>
          </button>
          {lobbyError && (
            <p className="text-sm text-red-700" role="alert">
              {lobbyError}
            </p>
          )}
        </form>

        <p className="mt-6 rounded-lg bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600">
          Use <strong className="font-medium text-stone-800">Copy invite link</strong>{" "}
          so guests only enter a name. Only the host create key can open a new room.
        </p>
        <RoomDownloads roomId={roomId} />
        <p className="mt-4 text-center text-xs text-stone-500">
          <a className="underline-offset-2 hover:text-stone-800 hover:underline" href="/admin">
            Recording admin
          </a>
        </p>
      </div>
    </section>
  );
}

type RoomParticipant = {
  displayName: string;
  forceMuted?: boolean;
  handRaised: boolean;
  id: string;
  mediaParticipantId?: string | null;
  muted: boolean;
  role: "admin" | "participant";
  speaking: boolean;
};

type RecordingStatus = {
  adapters: number;
  bytesRecorded: number;
  chunkCount: number;
  downloadFilename?: string | null;
  downloadable: boolean;
  elapsedMs: number;
  finalized: boolean;
  format?: string | null;
  remainingMs: number;
  startedAt?: number | null;
  status: string;
  tracks: number;
};

function recordingDownloadFilename(
  meta: Pick<RecordingStatus, "downloadFilename" | "format" | "startedAt"> | null,
): string {
  if (meta?.downloadFilename) return meta.downloadFilename;
  const ext = meta?.format === "ogg/opus" ? "ogg" : "wav";
  if (meta?.startedAt) {
    const date = new Date(meta.startedAt);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}.${ext}`;
  }
  return `recording.${ext}`;
}

function Room({
  roomId,
  password,
  displayName,
  room,
  busy,
  leaveDisabled,
  onLeave,
  onSetMicMuted,
}: {
  roomId: string;
  password: string;
  displayName: string;
  room: JoinedRoomView;
  busy: boolean;
  leaveDisabled: boolean;
  onLeave: () => Promise<void>;
  onSetMicMuted: (muted: boolean) => void;
}) {
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [selfId, setSelfId] = useState<string>();
  const [adminId, setAdminId] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [forceMuted, setForceMuted] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [endingCall, setEndingCall] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("Connecting room controls…");
  const [recordingMeta, setRecordingMeta] = useState<RecordingStatus | null>(null);
  const mutedRef = useRef(muted);
  const forceMutedRef = useRef(forceMuted);
  const selfIdRef = useRef<string | undefined>(undefined);
  const isAdminRef = useRef(false);
  const pushToTalkRef = useRef(false);
  const pushToTalkWasMutedRef = useRef(true);
  const socket = useRef<WebSocket | undefined>(undefined);
  const leavingRef = useRef(false);
  const callEndedRef = useRef(false);
  const endingCallRef = useRef(false);
  const pendingMuteAllRef = useRef(false);
  const hostActionStatusUntilRef = useRef(0);
  const selfName =
    room.snapshot.participants.find((item) => item.id === room.selfId)
      ?.displayName ?? displayName;
  // Host chrome: RoomDO admin, SFU creator, or this browser holds the create key.
  const isRoomDoAdmin = Boolean(selfId && adminId && adminId === selfId);
  const isVideoRoomCreator =
    room.snapshot.creatorParticipantId !== null &&
    room.snapshot.creatorParticipantId === room.selfId;
  const isCreateKeyHolder = Boolean(
    sessionStorage.getItem(createSecretStorageKey(roomId)),
  );
  const isAdmin = isRoomDoAdmin || isVideoRoomCreator || isCreateKeyHolder;
  mutedRef.current = muted;
  forceMutedRef.current = forceMuted;
  isAdminRef.current = isAdmin;
  const applyMicMuted = (nextMuted: boolean) => {
    // Keep mic tracks enabled — SFU GC's publications that go silent via enabled=false.
    room.localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    onSetMicMuted(nextMuted);
    setMuted(nextMuted);
    mutedRef.current = nextMuted;
  };
  const applyHostForceMute = (forced: boolean) => {
    forceMutedRef.current = forced;
    setForceMuted(forced);
    if (forced) {
      pushToTalkRef.current = false;
      applyMicMuted(true);
    } else {
      // Silent-track unmute only — full media refresh races session generation.
      applyMicMuted(false);
    }
  };
  const setHostActionStatus = (text: string, holdMs = 15_000) => {
    hostActionStatusUntilRef.current = Date.now() + holdMs;
    setRecordingStatus(text);
  };
  const leaveRoom = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    callEndedRef.current = true;
    try {
      await onLeave();
    } finally {
      leavingRef.current = false;
    }
  };
  const leaveRoomRef = useRef(leaveRoom);
  leaveRoomRef.current = leaveRoom;

  const endCall = async () => {
    if (endingCall || leavingRef.current) return;
    if (!isAdmin) {
      setRecordingStatus("Only the room host can end the call.");
      return;
    }
    if (!confirm("End the call for everyone and stop server recording?")) return;
    setEndingCall(true);
    endingCallRef.current = true;
    setRecordingStatus("Ending call…");
    if (socket.current?.readyState === WebSocket.OPEN) {
      // Prefer RoomDO end-call (kicks everyone). Finalize runs on end-call / 4002.
      socket.current.send(
        JSON.stringify({ type: "end-call", claimHost: true }),
      );
      // If RoomDO never acks, don't leave the host stuck on "Ending…".
      window.setTimeout(() => {
        if (!endingCallRef.current || callEndedRef.current) return;
        setRecordingStatus(
          "Host controls did not confirm — ending this session and stopping recording…",
        );
        void finalizeThenLeaveRef.current();
      }, 2_500);
      return;
    }
    setRecordingStatus(
      "Room controls offline — stopping recording and leaving…",
    );
    await finalizeThenLeaveRef.current();
  };

  const finalizeThenLeave = async () => {
    const headers = new Headers();
    addLocalIdentity(headers);
    await fetch(
      `/api/recording/finalize?room=${encodeURIComponent(roomId)}`,
      { method: "POST", headers, credentials: "same-origin" },
    ).catch(() => undefined);
    await leaveRoomRef.current();
    endingCallRef.current = false;
    setEndingCall(false);
  };
  const finalizeThenLeaveRef = useRef(finalizeThenLeave);
  finalizeThenLeaveRef.current = finalizeThenLeave;

  useEffect(() => {
    const onPageHide = () => {
      // Stop RoomDO reconnect loops and drop control presence immediately.
      callEndedRef.current = true;
      const ws = socket.current;
      socket.current = undefined;
      try {
        ws?.close(1000, "page-hide");
      } catch {
        // Page is unloading.
      }
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let active: WebSocket | undefined;

    const clearTimers = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      reconnectTimer = undefined;
      heartbeatTimer = undefined;
    };

    const connect = () => {
      if (disposed) return;
      const control = new WebSocket(socketUrl("/ws/room", roomId, password));
      active = control;
      socket.current = control;
      control.onopen = () => {
        reconnectAttempt = 0;
        setRecordingStatus("Room controls connected.");
        const claimHost =
          (room.snapshot.creatorParticipantId !== null &&
            room.snapshot.creatorParticipantId === room.selfId) ||
          Boolean(sessionStorage.getItem(createSecretStorageKey(roomId)));
        control.send(
          JSON.stringify({
            type: "join",
            displayName: selfName,
            claimHost,
            mediaParticipantId: room.selfId,
          }),
        );
        if (pendingMuteAllRef.current) {
          pendingMuteAllRef.current = false;
          control.send(JSON.stringify({ type: "mute-all", claimHost: true }));
          setHostActionStatus("Mute all sent…");
        }
        heartbeatTimer = window.setInterval(() => {
          if (control.readyState === WebSocket.OPEN) {
            control.send(JSON.stringify({ type: "ping" }));
          }
        }, 15_000);
      };
      control.onmessage = ({ data }) => {
        if (control !== socket.current) return;
        let message: unknown;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!isMessage(message)) return;
        if (message.type === "room-state" && Array.isArray(message.participants)) {
          const next = message.participants.filter(isRoomParticipant);
          setParticipants(next);
          const nextSelfId =
            typeof message.selfId === "string" ? message.selfId : undefined;
          selfIdRef.current = nextSelfId;
          setSelfId(nextSelfId);
          setAdminId(typeof message.adminId === "string" ? message.adminId : undefined);
          const self = next.find((item) => item.id === message.selfId);
          if (self) {
            const forced = Boolean(self.forceMuted);
            forceMutedRef.current = forced;
            setForceMuted(forced);
            applyMicMuted(self.muted || forced);
            setHandRaised(self.handRaised);
          }
        } else if (message.type === "mute-all") {
          // Host must never apply force-mute to themselves (selfId can race).
          if (
            isAdminRef.current ||
            (typeof message.by === "string" &&
              message.by === selfIdRef.current)
          ) {
            if (
              typeof message.by === "string" &&
              message.by === selfIdRef.current
            ) {
              setHostActionStatus("Muted all participants.");
            }
            return;
          }
          applyHostForceMute(true);
          setHostActionStatus("Muted by host.");
        } else if (message.type === "unmute-all") {
          if (
            isAdminRef.current ||
            (typeof message.by === "string" &&
              message.by === selfIdRef.current)
          ) {
            return;
          }
          applyHostForceMute(false);
          setHostActionStatus("Host unmuted everyone — you can speak.");
        } else if (message.type === "chime") {
          void playRoomChime(message.sound === "leave").catch((error: unknown) => {
            setRecordingStatus(error instanceof Error ? error.message : "Room chime failed.");
          });
        } else if (message.type === "mute-status") {
          setParticipants((current) =>
            current.map((item) =>
              item.id === message.participantId && typeof message.muted === "boolean"
                ? {
                    ...item,
                    muted: message.muted,
                    forceMuted:
                      typeof message.forceMuted === "boolean"
                        ? message.forceMuted
                        : item.forceMuted,
                    speaking: message.muted ? false : item.speaking,
                  }
                : item,
            ),
          );
          if (
            typeof message.participantId === "string" &&
            message.participantId === selfIdRef.current &&
            typeof message.muted === "boolean"
          ) {
            const forced =
              typeof message.forceMuted === "boolean"
                ? message.forceMuted
                : forceMutedRef.current && message.muted;
            forceMutedRef.current = Boolean(forced);
            setForceMuted(Boolean(forced));
            applyMicMuted(message.muted || Boolean(forced));
          }
        } else if (message.type === "hand") {
          setParticipants((current) =>
            current.map((item) =>
              item.id === message.participantId && typeof message.raised === "boolean"
                ? { ...item, handRaised: message.raised }
                : item,
            ),
          );
        } else if (message.type === "speaking") {
          setParticipants((current) =>
            current.map((item) =>
              item.id === message.participantId && typeof message.speaking === "boolean"
                ? { ...item, speaking: message.speaking }
                : item,
            ),
          );
        } else if (
          message.type === "reaction" &&
          typeof message.participantId === "string" &&
          typeof message.emoji === "string"
        ) {
          setReactions((current) => ({
            ...current,
            [message.participantId as string]: message.emoji as string,
          }));
          window.setTimeout(() => {
            setReactions((current) => {
              const next = { ...current };
              delete next[message.participantId as string];
              return next;
            });
          }, 4_000);
        } else if (message.type === "force-mute" || message.type === "force-unmute") {
          const nextMuted = message.type === "force-mute";
          applyHostForceMute(nextMuted);
          if (!nextMuted) applyMicMuted(false);
          setRecordingStatus(
            nextMuted ? "Muted by host." : "Host unmuted you — you can speak.",
          );
        } else if (message.type === "mute-all-ok") {
          const count =
            typeof message.count === "number" ? message.count : undefined;
          setHostActionStatus(
            typeof count === "number"
              ? `Muted ${count} participant${count === 1 ? "" : "s"}.`
              : "Mute all applied.",
          );
        } else if (message.type === "unmute-all-ok") {
          const count =
            typeof message.count === "number" ? message.count : undefined;
          setHostActionStatus(
            typeof count === "number"
              ? `Unmuted ${count} participant${count === 1 ? "" : "s"}.`
              : "Unmute all applied.",
          );
        } else if (message.type === "transfer-admin-ok") {
          setHostActionStatus("Host controls transferred.");
        } else if (message.type === "error") {
          const detail =
            typeof message.message === "string"
              ? message.message
              : "Room control request failed.";
          setHostActionStatus(detail);
          if (endingCallRef.current) {
            endingCallRef.current = false;
            setEndingCall(false);
          }
        } else if (message.type === "kicked" || message.type === "end-call") {
          callEndedRef.current = true;
          if (message.type === "end-call") {
            setRecordingStatus("Call ended. Finalizing recording…");
            void finalizeThenLeaveRef.current();
          } else {
            void leaveRoomRef.current();
          }
        }
      };
      control.onerror = () => {
        if (!callEndedRef.current) {
          setHostActionStatus(
            "Room controls failed to connect. Hard-refresh, then Create the room again with the host key if you purged rooms.",
            20_000,
          );
        }
      };
      control.onclose = (event) => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        if (socket.current === control) socket.current = undefined;
        if (disposed) return;
        // Call ended / kicked: leave media and do not reconnect the control socket.
        if (
          callEndedRef.current ||
          event.code === 4001 ||
          event.code === 4002 ||
          event.reason === "Call ended."
        ) {
          callEndedRef.current = true;
          if (event.code === 4002 || event.reason === "Call ended.") {
            void finalizeThenLeaveRef.current();
          } else {
            void leaveRoomRef.current();
          }
          return;
        }
        // Avoid infinite reconnect spam when the room was purged / not created.
        if (reconnectAttempt >= 5) {
          setHostActionStatus(
            "Room controls keep failing. Leave, Create the room with the host key, then join again.",
            30_000,
          );
          return;
        }
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
        reconnectAttempt += 1;
        setRecordingStatus(
          `Room controls reconnecting in ${Math.round(delay / 1000)}s…`,
        );
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimers();
      active?.close(1000, "room-controls-refresh");
      if (socket.current === active) socket.current = undefined;
    };
    // Reconnect when SFU creator identity settles so claimHost can be sent.
  }, [
    roomId,
    password,
    selfName,
    room.selfId,
    room.snapshot.creatorParticipantId,
  ]);

  useEffect(() => {
    let disposed = false;
    const applyStatus = (status: RecordingStatus) => {
      setRecordingMeta(status);
      // Keep Mute all / host action text visible; do not overwrite for 15s.
      if (Date.now() < hostActionStatusUntilRef.current) return;
      if (status.status === "recording") {
        const minutes = Math.floor(status.elapsedMs / 60_000);
        const remaining = Math.ceil(status.remainingMs / 60_000);
        setRecordingStatus(
          `Server recording active · ${status.chunkCount} chunks · ${minutes}m elapsed · ${remaining}m left · ${status.adapters}/${status.tracks} adapters`,
        );
      } else if (status.status === "ready") {
        setRecordingStatus("Recording ready to download.");
      } else if (status.status === "finalizing") {
        setRecordingStatus("Finalizing server recording…");
      } else if (status.status === "failed") {
        setRecordingStatus("Recording failed. Partial audio may still download.");
      } else {
        setRecordingStatus("Waiting for publishers so server recording can start…");
      }
    };

    const poll = async () => {
      try {
        const headers = new Headers();
        addLocalIdentity(headers);
        const response = await fetch(
          `/api/recording/status?room=${encodeURIComponent(roomId)}`,
          { headers, credentials: "same-origin" },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as RecordingStatus;
        if (!disposed) applyStatus(payload);
      } catch {
        if (!disposed) setRecordingStatus("Recording status unavailable.");
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [roomId]);

  const send = (message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(message));
      return true;
    }
    setHostActionStatus(
      "Room controls not connected yet. Wait a moment and retry.",
    );
    return false;
  };

  const lastMuteAllClickRef = useRef(0);
  const muteAll = () => {
    const now = Date.now();
    if (now - lastMuteAllClickRef.current < 400) return;
    lastMuteAllClickRef.current = now;
    pendingMuteAllRef.current = true;
    const open = socket.current?.readyState === WebSocket.OPEN;
    if (!open) {
      setHostActionStatus(
        "Mute all queued — sending as soon as room controls connect…",
      );
      return;
    }
    pendingMuteAllRef.current = false;
    const sent = send({ type: "mute-all", claimHost: true });
    setHostActionStatus(
      sent ? "Mute all sent…" : "Mute all failed to send — retry in a moment.",
    );
  };
  const muteAllRef = useRef(muteAll);
  muteAllRef.current = muteAll;

  const unmuteAll = () => {
    const sent = send({ type: "unmute-all", claimHost: true });
    setHostActionStatus(
      sent ? "Unmute all sent…" : "Unmute all failed — retry in a moment.",
    );
  };

  // Native DOM listener — React root delegation alone shows “no listeners” on
  // the button in DevTools; this binds a real click action on #mute-all.
  useEffect(() => {
    if (!isAdmin) return;
    const button = document.getElementById("mute-all");
    if (!button) return;
    const onClick = () => {
      muteAllRef.current();
    };
    button.addEventListener("click", onClick);
    return () => button.removeEventListener("click", onClick);
  }, [isAdmin, selfId, adminId]);
  useEffect(() => {
    const tracks = room.localStream.getAudioTracks();
    if (!tracks.length) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream(tracks));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let lastSpeaking = false;
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const value = (sample - 128) / 128;
        energy += value * value;
      }
      const speaking =
        !muted &&
        tracks.some((track) => track.enabled) &&
        Math.sqrt(energy / samples.length) > 0.035;
      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        send({ type: "speaking", speaking });
      }
    }, 250);
    void context.resume();
    return () => {
      window.clearInterval(timer);
      source.disconnect();
      void context.close();
      send({ type: "speaking", speaking: false });
    };
  }, [room.localStream, muted]);

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isTextInputTarget(event.target) || pushToTalkRef.current) return;
      if (forceMutedRef.current) return;
      event.preventDefault();
      pushToTalkRef.current = true;
      pushToTalkWasMutedRef.current = mutedRef.current;
      applyMicMuted(false);
      send({ type: "mute-status", muted: false });
    };
    const release = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !pushToTalkRef.current) return;
      pushToTalkRef.current = false;
      // Host may have force-muted during the hold — never unmute on release.
      if (forceMutedRef.current) {
        applyMicMuted(true);
        send({ type: "mute-status", muted: true });
        return;
      }
      const restoreMuted = pushToTalkWasMutedRef.current;
      applyMicMuted(restoreMuted);
      send({ type: "mute-status", muted: restoreMuted });
    };
    window.addEventListener("keydown", press);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", press);
      window.removeEventListener("keyup", release);
    };
  }, [room.localStream]);

  // Re-apply mute after SFU media republish/reconnect.
  useEffect(() => {
    onSetMicMuted(muted || forceMuted);
  }, [room.selfId, room.localStream, muted, forceMuted, onSetMicMuted]);

  const toggleMute = () => {
    const next = !muted;
    if (forceMutedRef.current && !next) {
      if (isAdminRef.current) {
        // Clear a stuck self force-mute (Mute all selfId race).
        applyHostForceMute(false);
        send({ type: "mute-status", muted: false });
        return;
      }
      setRecordingStatus("Muted by host — wait for the host to unmute you.");
      return;
    }
    applyMicMuted(next);
    send({ type: "mute-status", muted: next });
  };
  const toggleHand = () => {
    const next = !handRaised;
    setHandRaised(next);
    send({ type: "hand", raised: next });
  };
  const download = async (path: string, filename: string) => {
    try {
      const headers = new Headers();
      addLocalIdentity(headers);
      const response = await fetch(
        `${path}?room=${encodeURIComponent(roomId)}`,
        { headers, credentials: "same-origin" },
      );
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setRecordingStatus(error instanceof Error ? error.message : "Download failed.");
    }
  };

  const controlForMediaId = (mediaId: string, displayName: string) =>
    participants.find((item) => item.mediaParticipantId === mediaId) ??
    participants.find((item) => item.displayName === displayName);
  return (
    <section
      id="room"
      className="p-3 sm:p-5"
      aria-busy={busy}
      aria-label="Audio room"
      aria-describedby="status"
    >
      <div className="rounded-xl bg-stone-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-stone-200">In this room</h2>
          <p className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-xs text-stone-200">
            {room.snapshot.participants.length} {room.snapshot.participants.length === 1 ? "participant" : "participants"}
          </p>
        </div>
        <div
          id="tiles"
          className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-3"
          aria-live="polite"
        >
          {room.snapshot.participants.map((participant) => {
            const control = controlForMediaId(
              participant.id,
              participant.displayName,
            );
            return (
              <ParticipantTile
                key={participant.id}
                id={participant.id}
                name={participant.displayName}
                self={participant.id === room.selfId}
                muted={participant.id === room.selfId ? muted : control?.muted ?? false}
                handRaised={participant.id === room.selfId ? handRaised : control?.handRaised ?? false}
                reaction={control ? reactions[control.id] : undefined}
                stream={participant.id === room.selfId ? room.localStream : room.remoteStreams.get(participant.id)}
                admin={isAdmin && control?.id !== selfId ? control?.id : undefined}
                onForceMute={(id) =>
                  send({ type: "force-mute", participantId: id, claimHost: true })
                }
                onForceUnmute={(id) =>
                  send({ type: "force-unmute", participantId: id, claimHost: true })
                }
                onKick={(id) => send({ type: "kick", participantId: id })}
                onTransfer={(id) => send({ type: "transfer-admin", participantId: id })}
                speaking={control?.speaking ?? false}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Room controls">
        <button id="mute" onClick={toggleMute} className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium" type="button" aria-pressed={muted} disabled={forceMuted && muted && !isAdmin}>
          {forceMuted && !isAdmin ? "Muted by host" : muted ? "Unmute" : "Mute"}
        </button>
        <button id="raise-hand" onClick={toggleHand} className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium" type="button" aria-pressed={handRaised}>
          {handRaised ? "Lower hand" : "Raise hand"}
        </button>
        <div className="flex gap-1" role="group" aria-label="Send a reaction">
          {["👍", "❤️", "👏", "🔥"].map((emoji) => (
            <button key={emoji} onClick={() => send({ type: "reaction", emoji })} className="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg border border-stone-300 bg-white text-lg" type="button" aria-label={`React ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
        <button id="leave" disabled={leaveDisabled || endingCall} onClick={() => void leaveRoom()} className="inline-flex min-h-11 cursor-pointer grow items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:grow-0" type="button">
          Leave
        </button>
        {isAdmin && (
          <button
            id="mute-all"
            data-action="mute-all"
            onClick={muteAll}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium"
            type="button"
          >
            Mute all
          </button>
        )}
        {isAdmin && (
          <button
            id="unmute-all"
            data-action="unmute-all"
            onClick={unmuteAll}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium"
            type="button"
          >
            Unmute all
          </button>
        )}
        {isAdmin && (
          <button
            id="end-call"
            disabled={leaveDisabled || endingCall || busy}
            onClick={() => void endCall()}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
          >
            {endingCall ? "Ending…" : "End call"}
          </button>
        )}
        <button
          disabled={!recordingMeta?.downloadable}
          onClick={() =>
            void download("/recording", recordingDownloadFilename(recordingMeta))
          }
          className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          type="button"
        >
          Download recording
        </button>
      </div>
      <p className="mt-2 text-right text-xs text-stone-600">
        Hold Space to talk; the microphone returns to its previous mute state when released.
      </p>
      <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Server recording</h2>
          <span className="text-right text-xs text-stone-600">
            {recordingMeta
              ? `${(recordingMeta.bytesRecorded / 1_000_000).toFixed(1)} MB stored`
              : "—"}
          </span>
        </div>
        <p className="mt-2 text-sm text-stone-700">{recordingStatus}</p>
        <p className="mt-2 text-xs text-stone-500">
          Audio is captured on Cloudflare from the SFU (not your browser). After the call ends, the recording is compressed to OGG Opus (~15 MB/hour). Max length is 3 hours. Files are deleted automatically after 7 days.
        </p>
      </div>
    </section>
  );
}

function ParticipantTile({
  id,
  name,
  self,
  muted,
  handRaised,
  reaction,
  stream,
  admin,
  speaking,
  onForceMute,
  onForceUnmute,
  onKick,
  onTransfer,
}: {
  id: string;
  name: string;
  self: boolean;
  muted: boolean;
  handRaised: boolean;
  reaction?: string;
  stream?: MediaStream;
  admin?: string;
  speaking: boolean;
  onForceMute: (id: string) => void;
  onForceUnmute: (id: string) => void;
  onKick: (id: string) => void;
  onTransfer: (id: string) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.srcObject = stream ?? null;
    if (stream && !self) {
      void audio.play().catch(() => undefined);
    }
    return () => {
      audio.srcObject = null;
    };
  }, [stream, self]);
  return (
    <figure className={`video-tile relative overflow-hidden rounded-lg border bg-stone-800 ${speaking ? "border-emerald-400" : "border-white/10"}`} data-participant={id}>
      <div className="flex aspect-video w-full items-center justify-center bg-stone-800">
        <span className="flex size-20 items-center justify-center rounded-full bg-orange-700 text-3xl font-semibold text-white" aria-hidden="true">
          {name.trim().slice(0, 1).toLocaleUpperCase()}
        </span>
      </div>
      <audio ref={ref} className="sr-only" autoPlay playsInline muted={self} />
      {(muted || handRaised || reaction) && (
        <span className="absolute top-3 right-3 flex items-center gap-2 rounded-md bg-stone-950/80 px-2 py-1 text-sm text-white">
          {muted && <span>Muted</span>}
          {handRaised && <span aria-label="Hand raised">✋</span>}
          {reaction && <span aria-label={`Reaction ${reaction}`}>{reaction}</span>}
        </span>
      )}
      <figcaption className="tile-label absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-md bg-stone-950/80 px-2.5 py-1.5 text-xs font-medium text-white">
        {self ? `${name} (you)` : name}
      </figcaption>
      {admin && (
        <div className="absolute right-2 bottom-2 flex gap-1">
          <button onClick={() => muted ? onForceUnmute(admin) : onForceMute(admin)} className="rounded bg-white px-2 py-1 text-xs" type="button">
            {muted ? "Unmute" : "Mute"}
          </button>
          <button onClick={() => onKick(admin)} className="rounded bg-red-100 px-2 py-1 text-xs text-red-800" type="button">
            Remove
          </button>
          <button onClick={() => onTransfer(admin)} className="rounded bg-amber-100 px-2 py-1 text-xs" type="button">
            Make admin
          </button>
        </div>
      )}
    </figure>
  );
}

function StatusBar({ message, tone }: RoomViewState["status"]) {
  return (
    <div className="flex min-h-12 items-start gap-2.5 border-t border-stone-200 bg-stone-50 px-5 py-3 text-sm sm:px-6">
      <span
        className="mt-1.5 size-2 shrink-0 rounded-full bg-stone-400 group-has-[[data-tone=error]]:bg-red-700 group-has-[[data-tone=ok]]:bg-emerald-700 group-has-[[data-tone=warning]]:bg-amber-700 motion-safe:group-has-[[aria-busy=true]]:animate-pulse"
        aria-hidden="true"
      ></span>
      <span className="font-medium text-stone-700" aria-hidden="true">
        Status
      </span>
      <p
        id="status"
        className="min-w-0 wrap-anywhere text-stone-600 data-[tone=error]:font-medium data-[tone=error]:text-red-700 data-[tone=ok]:text-emerald-700 data-[tone=warning]:text-amber-700"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-tone={tone}
      >
        {message}
      </p>
    </div>
  );
}

function RoomDownloads({ roomId }: { roomId: string }) {
  const [meta, setMeta] = useState<RecordingStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const headers = new Headers();
        addLocalIdentity(headers);
        const response = await fetch(
          `/api/recording/status?room=${encodeURIComponent(roomId)}`,
          { headers, credentials: "same-origin" },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as RecordingStatus;
        if (!disposed) setMeta(payload.downloadable ? payload : null);
      } catch {
        // Lobby download is best-effort.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [roomId]);
  if (!meta) return null;

  const download = async (path: string, filename: string) => {
    try {
      const headers = new Headers();
      addLocalIdentity(headers);
      const response = await fetch(
        `${path}?room=${encodeURIComponent(roomId)}`,
        { headers, credentials: "same-origin" },
      );
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setError("");
    } catch (downloadError) {
      setError(
        downloadError instanceof Error ? downloadError.message : "Download failed.",
      );
    }
  };

  return (
    <div className="mt-6 flex flex-wrap gap-2" aria-live="polite">
      <button
        onClick={() =>
          void download("/recording", recordingDownloadFilename(meta))
        }
        className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium"
        type="button"
      >
        Download recording
      </button>
      {error && <p className="w-full text-sm text-red-700" role="status">{error}</p>}
    </div>
  );
}

function enforceVoiceOnlyCapture(): void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
  const mediaDevices = navigator.mediaDevices;
  const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  Object.defineProperty(mediaDevices, "getUserMedia", {
    configurable: true,
    value: () =>
      nativeGetUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          sampleRate: 48_000,
        },
        video: false,
      }),
  });
}

function socketUrl(path: string, roomId: string, password: string): string {
  const url = new URL(path, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", roomId);
  url.searchParams.set("password", password);
  // Required for AUTH_MODE=skip — do not rely only on the WebSocket Proxy.
  url.searchParams.set("guest", guestIdentity(roomId));
  if (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]"
  ) {
    const identity = sessionStorage.getItem("video-room-local-identity");
    if (identity) url.searchParams.set("identity", identity);
  }
  return url.toString();
}

function addLocalIdentity(headers: Headers): void {
  if (
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1" &&
    location.hostname !== "[::1]"
  ) return;
  const identity = sessionStorage.getItem("video-room-local-identity");
  if (identity) headers.set("x-video-room-local-identity", identity);
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRoomParticipant(value: unknown): value is RoomParticipant {
  if (!isMessage(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.muted === "boolean" &&
    typeof value.handRaised === "boolean" &&
    typeof value.speaking === "boolean" &&
    (value.role === "admin" || value.role === "participant") &&
    (value.forceMuted === undefined || typeof value.forceMuted === "boolean") &&
    (value.mediaParticipantId === undefined ||
      value.mediaParticipantId === null ||
      typeof value.mediaParticipantId === "string")
  );
}

function isTextInputTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches("input, textarea, select, [role='textbox']"))
  );
}

async function playRoomChime(leaving: boolean): Promise<void> {
  const context = new AudioContext();
  try {
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = leaving ? 440 : 660;
    gain.gain.setValueAtTime(0.12, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
    await new Promise<void>((resolve) => {
      oscillator.onended = () => resolve();
    });
  } finally {
    await context.close();
  }
}
