import { useState } from "react";

type RecordingStatus = {
  adapters?: number;
  bytesRecorded: number;
  chunkCount: number;
  downloadable: boolean;
  elapsedMs: number;
  expiresAt?: number | null;
  finalized: boolean;
  lastError?: string | null;
  packetsReceived?: number;
  packetsRejected?: number;
  recordingId: string | null;
  retentionDays?: number;
  status: string;
  tracks?: number;
};

const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function AdminPortal() {
  const [roomId, setRoomId] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Enter a room name and its password to look up the recording.");

  const lookup = async () => {
    const room = roomId.trim().toLowerCase();
    if (!ROOM_ID.test(room)) {
      setMessage("Room names use lowercase letters, numbers, and hyphens.");
      setStatus(null);
      return;
    }
    if (password.length < 8) {
      setMessage("Room password must be at least 8 characters.");
      setStatus(null);
      return;
    }
    setBusy(true);
    setMessage("Looking up recording…");
    try {
      const response = await fetch(
        `/api/recording/status?room=${encodeURIComponent(room)}`,
        {
          credentials: "same-origin",
          headers: { "x-room-password": password },
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | RecordingStatus
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setStatus(null);
        setMessage(
          payload && "error" in payload && payload.error?.message
            ? payload.error.message
            : `Lookup failed (${response.status}).`,
        );
        return;
      }
      const next = payload as RecordingStatus;
      setStatus(next);
      setMessage(
        next.downloadable
          ? "Recording found. You can download the WAV."
          : next.lastError
            ? `No downloadable audio (${next.status}): ${next.lastError}`
            : `No downloadable audio yet (status: ${next.status}). Join a new call to start a fresh recording.`,
      );
    } catch {
      setStatus(null);
      setMessage("Could not reach the recording service.");
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    const room = roomId.trim().toLowerCase();
    setBusy(true);
    setMessage("Preparing download…");
    try {
      const response = await fetch(
        `/recording?room=${encodeURIComponent(room)}`,
        {
          credentials: "same-origin",
          headers: { "x-room-password": password },
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setMessage(
          payload?.error?.message ?? `Download failed (${response.status}).`,
        );
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${room}-recording.wav`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("Download started.");
    } catch {
      setMessage("Download failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="text-sm font-medium text-orange-800">
          <a className="hover:underline" href="/">
            Voice room
          </a>
          <span className="mx-2 text-stone-400">/</span>
          Admin
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-900">
          Recording admin
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Look up a room by name and password, then download the server WAV.
          Recordings are deleted automatically after 7 days.
        </p>
      </header>

      <form
        className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <label className="block text-sm font-medium text-stone-800" htmlFor="admin-room">
          Room name
        </label>
        <input
          id="admin-room"
          autoComplete="off"
          className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm"
          placeholder="my-room"
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
        />

        <label
          className="mt-4 block text-sm font-medium text-stone-800"
          htmlFor="admin-password"
        >
          Room password
        </label>
        <input
          id="admin-password"
          autoComplete="current-password"
          className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm"
          placeholder="Room password (8+ characters)"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-orange-700 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-orange-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            type="submit"
          >
            Look up
          </button>
          <button
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || !status?.downloadable}
            onClick={() => void download()}
            type="button"
          >
            Download WAV
          </button>
        </div>
      </form>

      <p className="mt-4 text-sm text-stone-700" role="status">
        {message}
      </p>

      {status && (
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm">
          <div>
            <dt className="text-stone-500">Status</dt>
            <dd className="font-medium text-stone-900">{status.status}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Chunks</dt>
            <dd className="font-medium text-stone-900">{status.chunkCount}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Stored</dt>
            <dd className="font-medium text-stone-900">
              {(status.bytesRecorded / 1_000_000).toFixed(1)} MB
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Adapters</dt>
            <dd className="font-medium text-stone-900">
              {status.adapters ?? 0}/{status.tracks ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Packets</dt>
            <dd className="font-medium text-stone-900">
              {status.packetsReceived ?? 0} recv / {status.packetsRejected ?? 0}{" "}
              bad
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Recording ID</dt>
            <dd className="truncate font-medium text-stone-900">
              {status.recordingId ?? "—"}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-stone-500">Deletes</dt>
            <dd className="font-medium text-stone-900">
              {status.expiresAt
                ? new Date(status.expiresAt).toLocaleString()
                : `After ${status.retentionDays ?? 7} days from finalize`}
            </dd>
          </div>
          {status.lastError && (
            <div className="col-span-2">
              <dt className="text-stone-500">Last error</dt>
              <dd className="font-medium text-red-700">{status.lastError}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
