import { useState } from "react";

type RecordingStatus = {
  adapters?: number;
  bytesRecorded: number;
  chunkCount: number;
  downloadFilename?: string | null;
  downloadable: boolean;
  elapsedMs: number;
  expiresAt?: number | null;
  finalized: boolean;
  format?: string | null;
  lastError?: string | null;
  packetsReceived?: number;
  packetsRejected?: number;
  recordingId: string | null;
  retentionDays?: number;
  startedAt?: number | null;
  status: string;
  tracks?: number;
};

type PurgeResult = {
  bucketClear?: boolean;
  deletedObjects?: number;
  failures?: Array<{ room: string; error: string }>;
  ok?: boolean;
  purgedRooms?: string[];
  remainingObjects?: number;
  error?: { message?: string };
};

function recordingDownloadFilename(status: RecordingStatus): string {
  if (status.downloadFilename) return status.downloadFilename;
  if (status.startedAt) {
    const date = new Date(status.startedAt);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}.ogg`;
  }
  return "recording.ogg";
}

const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function knownRoomsFromSession(): string[] {
  const rooms = new Set<string>();
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (!key) continue;
    const match = /^(?:video-room-guest|video-room-password|video-room-create-secret)-(.+)$/.exec(
      key,
    );
    const room = match?.[1];
    if (room && ROOM_ID.test(room)) rooms.add(room);
  }
  return [...rooms];
}

function clearRoomSessionData(rooms: string[]): void {
  for (const room of rooms) {
    sessionStorage.removeItem(`video-room-guest-${room}`);
    sessionStorage.removeItem(`video-room-password-${room}`);
    sessionStorage.removeItem(`video-room-create-secret-${room}`);
  }
  sessionStorage.removeItem("video-room-joined");
  sessionStorage.removeItem("video-room-token");
}

export function AdminPortal() {
  const [roomId, setRoomId] = useState("");
  const [password, setPassword] = useState("");
  const [createSecret, setCreateSecret] = useState("");
  const [extraRooms, setExtraRooms] = useState("");
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "Enter a room name and its password to look up the recording.",
  );
  const [purgeMessage, setPurgeMessage] = useState(
    "Wipe every recording in R2 and reset known room Durable Objects. Requires the host create key.",
  );

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
          ? `Recording found. You can download ${recordingDownloadFilename(next)}.`
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
      anchor.download = status
        ? recordingDownloadFilename(status)
        : "recording.ogg";
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("Download started.");
    } catch {
      setMessage("Download failed.");
    } finally {
      setBusy(false);
    }
  };

  const purgeAll = async () => {
    const secret = createSecret.trim();
    if (!secret) {
      setPurgeMessage("Enter the host create key to purge.");
      return;
    }
    const typedRooms = extraRooms
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => ROOM_ID.test(item));
    const rooms = [...new Set([...knownRoomsFromSession(), ...typedRooms])];
    if (
      !confirm(
        rooms.length > 0
          ? `Delete all recordings and reset ${rooms.length} known room(s) plus any rooms found in R2? This cannot be undone.`
          : "Delete all recordings in R2 and reset any rooms found there? This cannot be undone.",
      )
    ) {
      return;
    }
    setBusy(true);
    setPurgeMessage("Purging rooms and recordings…");
    try {
      const response = await fetch("/api/admin/purge-all", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-room-create-secret": secret,
        },
        body: JSON.stringify({ rooms }),
      });
      const payload = (await response.json().catch(() => null)) as PurgeResult | null;
      if (!response.ok) {
        setPurgeMessage(
          payload?.error?.message ?? `Purge failed (${response.status}).`,
        );
        return;
      }
      clearRoomSessionData(payload?.purgedRooms ?? rooms);
      setStatus(null);
      const purged = payload?.purgedRooms?.length ?? 0;
      const objects = payload?.deletedObjects ?? 0;
      const failed = payload?.failures?.length ?? 0;
      const remaining = payload?.remainingObjects ?? 0;
      const clear = payload?.bucketClear === true;
      setPurgeMessage(
        !clear
          ? `Partial purge: deleted ${objects} object(s), ${remaining}+ still in the recordings bucket. Run Delete again.`
          : failed > 0
            ? `Recordings bucket is empty (${objects} deleted). Reset ${purged} room(s); ${failed} room reset(s) failed.`
            : `Recordings bucket is empty (${objects} deleted). Reset ${purged} room(s). You can create a fresh room now.`,
      );
      setMessage("Lookup state cleared after purge.");
    } catch {
      setPurgeMessage("Could not reach the purge endpoint.");
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
          Look up a room by name and password, then download the OGG Opus recording.
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
            Download recording
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

      <section className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 className="text-base font-semibold text-red-900">
          Delete all rooms &amp; recordings
        </h2>
        <p className="mt-2 text-sm leading-6 text-red-900/80">
          Removes every object in the recordings bucket and resets RoomDO,
          RecordingDO, and VideoRoom for rooms found in R2 plus any rooms listed
          below or remembered in this browser.
        </p>

        <label
          className="mt-4 block text-sm font-medium text-red-950"
          htmlFor="admin-create-secret"
        >
          Host create key
        </label>
        <input
          id="admin-create-secret"
          autoComplete="off"
          className="mt-1.5 w-full rounded-lg border border-red-200 bg-white px-3 py-2.5 text-sm"
          placeholder="ROOM_CREATE_SECRET"
          type="password"
          value={createSecret}
          onChange={(event) => setCreateSecret(event.target.value)}
        />

        <label
          className="mt-4 block text-sm font-medium text-red-950"
          htmlFor="admin-extra-rooms"
        >
          Extra room names (optional)
        </label>
        <input
          id="admin-extra-rooms"
          autoComplete="off"
          className="mt-1.5 w-full rounded-lg border border-red-200 bg-white px-3 py-2.5 text-sm"
          placeholder="room-one, room-two"
          value={extraRooms}
          onChange={(event) => setExtraRooms(event.target.value)}
        />

        <button
          className="mt-5 inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={() => void purgeAll()}
          type="button"
        >
          Delete all rooms &amp; recordings
        </button>

        <p className="mt-3 text-sm text-red-950" role="status">
          {purgeMessage}
        </p>
      </section>
    </div>
  );
}
