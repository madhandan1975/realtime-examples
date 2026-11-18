import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { lifecycleControlState } from "./lifecycle";
import { openAnotherParticipant } from "./open-participant";
import type {
  JoinedRoomView,
  RoomController,
  RoomViewState,
} from "./room-controller";

enforceVoiceOnlyCapture();
cacheRoomPasswordFromUrl();
installRoomPasswordPropagation();

export function App({ controller }: { controller: RoomController }) {
  const [password, setPassword] = useState(
    () => sessionStorage.getItem(passwordStorageKey(controller.roomId)) ?? "",
  );
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
            />
          ) : (
            <Lobby
              roomId={controller.roomId}
              displayName={state.displayName}
              busy={controls.joinBusy}
              nameDisabled={controls.displayNameDisabled}
              joinDisabled={controls.joinDisabled}
              password={password}
              onPasswordChange={setPassword}
              onNameChange={controller.setDisplayName}
              onJoin={() => {
                sessionStorage.setItem(
                  passwordStorageKey(controller.roomId),
                  password,
                );
                return controller.join();
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
          Copy link
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
  busy,
  nameDisabled,
  joinDisabled,
  onNameChange,
  onPasswordChange,
  onJoin,
}: {
  roomId: string;
  displayName: string;
  password: string;
  busy: boolean;
  nameDisabled: boolean;
  joinDisabled: boolean;
  onNameChange: (name: string) => void;
  onPasswordChange: (password: string) => void;
  onJoin: () => Promise<void>;
}) {
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
          Join{" "}
          <span id="lobby-room-id" className="wrap-anywhere">
            {roomId}
          </span>
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-600 sm:text-base">
          Enter your name, then allow microphone access. This room is audio
          only. The room creator's browser automatically records and transcribes
          the mixed room audio.
        </p>

        <form
          id="join-form"
          className="mt-8"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void onJoin();
          }}
        >
          <label htmlFor="display-name" className="block text-sm font-medium">
            Display name
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
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
              autoComplete="current-password"
              placeholder="Room password (8+ characters)"
              required
            />
            <button
              className="inline-flex min-h-12 cursor-pointer shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-700 px-5 py-3 text-sm font-semibold text-white shadow-xs transition-colors enabled:hover:bg-orange-800 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              type="submit"
              disabled={joinDisabled}
            >
              Join room
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
          </div>
        </form>

        <p className="mt-6 rounded-lg bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600">
          Trying this on your own? Use{" "}
          <strong className="font-medium text-stone-900">
            Open another participant
          </strong>{" "}
          to create a fresh tab. Duplicating this tab can reuse your identity.
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
  handRaised: boolean;
  id: string;
  muted: boolean;
  role: "admin" | "participant";
  speaking: boolean;
};

type RecordingStatus = {
  adapters: number;
  bytesRecorded: number;
  chunkCount: number;
  downloadable: boolean;
  elapsedMs: number;
  finalized: boolean;
  remainingMs: number;
  status: string;
  tracks: number;
};

function Room({
  roomId,
  password,
  displayName,
  room,
  busy,
  leaveDisabled,
  onLeave,
}: {
  roomId: string;
  password: string;
  displayName: string;
  room: JoinedRoomView;
  busy: boolean;
  leaveDisabled: boolean;
  onLeave: () => Promise<void>;
}) {
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [selfId, setSelfId] = useState<string>();
  const [adminId, setAdminId] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("Connecting room controls…");
  const [recordingMeta, setRecordingMeta] = useState<RecordingStatus | null>(null);
  const mutedRef = useRef(muted);
  const pushToTalkRef = useRef(false);
  const pushToTalkWasMutedRef = useRef(true);
  const socket = useRef<WebSocket | undefined>(undefined);
  const leavingRef = useRef(false);
  const selfName =
    room.snapshot.participants.find((item) => item.id === room.selfId)
      ?.displayName ?? displayName;
  const isAdmin = Boolean(selfId && adminId === selfId);
  mutedRef.current = muted;
  const leaveRoom = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    try {
      await onLeave();
    } finally {
      leavingRef.current = false;
    }
  };
  const leaveRoomRef = useRef(leaveRoom);
  leaveRoomRef.current = leaveRoom;

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
        control.send(JSON.stringify({ type: "join", displayName: selfName }));
        heartbeatTimer = window.setInterval(() => {
          if (control.readyState === WebSocket.OPEN) {
            control.send(JSON.stringify({ type: "ping" }));
          }
        }, 15_000);
      };
      control.onmessage = ({ data }) => {
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
          setSelfId(typeof message.selfId === "string" ? message.selfId : undefined);
          setAdminId(typeof message.adminId === "string" ? message.adminId : undefined);
          const self = next.find((item) => item.id === message.selfId);
          if (self) {
            setMuted(self.muted);
            setHandRaised(self.handRaised);
          }
        } else if (message.type === "chime") {
          void playRoomChime(message.sound === "leave").catch((error: unknown) => {
            setRecordingStatus(error instanceof Error ? error.message : "Room chime failed.");
          });
        } else if (message.type === "mute-status") {
          setParticipants((current) =>
            current.map((item) =>
              item.id === message.participantId && typeof message.muted === "boolean"
                ? { ...item, muted: message.muted }
                : item,
            ),
          );
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
          room.localStream.getAudioTracks().forEach((track) => {
            track.enabled = !nextMuted;
          });
          setMuted(nextMuted);
        } else if (message.type === "kicked" || message.type === "end-call") {
          void leaveRoomRef.current();
        }
      };
      control.onerror = () => setRecordingStatus("Room controls disconnected. Reconnecting…");
      control.onclose = () => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        if (socket.current === control) socket.current = undefined;
        if (disposed) return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
        reconnectAttempt += 1;
        setRecordingStatus(`Room controls reconnecting in ${Math.round(delay / 1000)}s…`);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimers();
      active?.close();
      if (socket.current === active) socket.current = undefined;
    };
  }, [roomId, password, room.selfId, selfName, room.localStream]);

  useEffect(() => {
    let disposed = false;
    const applyStatus = (status: RecordingStatus) => {
      setRecordingMeta(status);
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
    }
  };
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
      event.preventDefault();
      pushToTalkRef.current = true;
      pushToTalkWasMutedRef.current = mutedRef.current;
      room.localStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      setMuted(false);
      send({ type: "mute-status", muted: false });
    };
    const release = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !pushToTalkRef.current) return;
      pushToTalkRef.current = false;
      const restoreMuted = pushToTalkWasMutedRef.current;
      room.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !restoreMuted;
      });
      setMuted(restoreMuted);
      send({ type: "mute-status", muted: restoreMuted });
    };
    window.addEventListener("keydown", press);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", press);
      window.removeEventListener("keyup", release);
    };
  }, [room.localStream]);

  const toggleMute = () => {
    const next = !muted;
    room.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
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

  const participantFor = (name: string) =>
    participants.find((item) => item.displayName === name);
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
            const control = participantFor(participant.displayName);
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
                onForceMute={(id) => send({ type: "force-mute", participantId: id })}
                onForceUnmute={(id) => send({ type: "force-unmute", participantId: id })}
                onKick={(id) => send({ type: "kick", participantId: id })}
                onTransfer={(id) => send({ type: "transfer-admin", participantId: id })}
                speaking={control?.speaking ?? false}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Room controls">
        <button id="mute" onClick={toggleMute} className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium" type="button" aria-pressed={muted}>
          {muted ? "Unmute" : "Mute"}
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
        <button id="leave" disabled={leaveDisabled} onClick={() => void leaveRoom()} className="inline-flex min-h-11 cursor-pointer grow items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:grow-0" type="button">
          Leave
        </button>
        {isAdmin && (
          <button
            onClick={() =>
              void (async () => {
                try {
                  const headers = new Headers();
                  addLocalIdentity(headers);
                  await fetch(
                    `/api/recording/finalize?room=${encodeURIComponent(roomId)}`,
                    { method: "POST", headers, credentials: "same-origin" },
                  );
                } catch {
                  // End call even if finalize fails; chunks remain in R2.
                }
                send({ type: "end-call" });
                await leaveRoom();
              })()
            }
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700"
            type="button"
          >
            End call
          </button>
        )}
        <button
          disabled={!recordingMeta?.downloadable}
          onClick={() => void download("/recording", "room-recording.wav")}
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
          Audio is captured on Cloudflare from the SFU (not your browser). Partial WAV download works while the meeting is still live. Max length is 3 hours. Files are deleted automatically after 7 days.
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
    return () => {
      audio.srcObject = null;
    };
  }, [stream]);
  return (
    <figure className={`video-tile relative overflow-hidden rounded-lg border bg-stone-800 ${speaking ? "border-emerald-400" : "border-white/10"}`} data-participant={id}>
      <div className="flex aspect-video w-full items-center justify-center bg-stone-800">
        <span className="flex size-20 items-center justify-center rounded-full bg-orange-700 text-3xl font-semibold text-white" aria-hidden="true">
          {name.trim().slice(0, 1).toLocaleUpperCase()}
        </span>
      </div>
      <audio ref={ref} className="sr-only" autoPlay muted={self} />
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
  const [available, setAvailable] = useState(false);
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
        const payload = (await response.json()) as { downloadable?: boolean };
        if (!disposed) setAvailable(Boolean(payload.downloadable));
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
  if (!available) return null;

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
        onClick={() => void download("/recording", "room-recording.wav")}
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
    (value.role === "admin" || value.role === "participant")
  );
}

function passwordStorageKey(roomId: string): string {
  return `video-room-password-${roomId}`;
}

function cacheRoomPasswordFromUrl(): void {
  const url = new URL(location.href);
  const password = url.searchParams.get("password");
  const match = /^\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(url.pathname);
  if (!password || !match?.[1]) return;
  sessionStorage.setItem(passwordStorageKey(match[1]), password);
  url.searchParams.delete("password");
  history.replaceState(history.state, "", url);
}

function installRoomPasswordPropagation(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (requestUrl.origin !== location.origin) return originalFetch(input, init);
    const roomId = roomIdFromRequestUrl(requestUrl);
    if (!roomId) return originalFetch(input, init);
    const password = sessionStorage.getItem(passwordStorageKey(roomId));
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const guestId = guestIdentity(roomId);
    headers.set("x-room-guest-id", guestId);
    if (password) headers.set("x-room-password", password);
    return originalFetch(input, { ...init, headers });
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const requestUrl = new URL(String(args[0]), location.href);
      if (requestUrl.origin === location.origin) {
        const roomId = roomIdFromRequestUrl(requestUrl);
        if (roomId) requestUrl.searchParams.set("guest", guestIdentity(roomId));
        const password = roomId
          ? sessionStorage.getItem(passwordStorageKey(roomId))
          : null;
        if (password) requestUrl.searchParams.set("password", password);
      }
      return Reflect.construct(
        target,
        [requestUrl.toString(), ...args.slice(1)],
        newTarget,
      ) as WebSocket;
    },
  });
}

function roomIdFromRequestUrl(url: URL): string | undefined {
  const apiMatch = /^\/api\/rooms\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/.exec(
    url.pathname,
  );
  if (apiMatch?.[1]) return apiMatch[1];
  if (
    url.pathname === "/api/recording/status" ||
    url.pathname === "/api/recording/finalize" ||
    url.pathname === "/api/recording/pcm" ||
    url.pathname === "/recording" ||
    url.pathname === "/ws/room" ||
    url.pathname === "/ws/recording"
  ) {
    return url.searchParams.get("room") ?? undefined;
  }
  return undefined;
}

function guestIdentity(roomId: string): string {
  const key = `video-room-guest-${roomId}`;
  const existing = sessionStorage.getItem(key);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
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
