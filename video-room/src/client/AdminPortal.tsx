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

type AdminRecordingRow = {
  bytes: number;
  downloadFilename: string | null;
  downloadable: boolean;
  expiresAt: number | null;
  format: "ogg/opus" | "pcm/wav" | "unknown";
  hasManifest: boolean;
  hasOgg: boolean;
  lastError: string | null;
  modifiedAt: string | null;
  objectCount: number;
  pcmChunks: number;
  recordingId: string;
  roomId: string;
  startedAt: number | null;
  status: string | null;
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
  const ext = status.format === "ogg/opus" ? "ogg" : "wav";
  if (status.startedAt) {
    const date = new Date(status.startedAt);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}.${ext}`;
  }
  return `recording.${ext}`;
}

function adminRowFilename(row: AdminRecordingRow): string {
  if (row.downloadFilename) return row.downloadFilename;
  const ext = row.format === "ogg/opus" ? "ogg" : "wav";
  if (row.startedAt) {
    const date = new Date(row.startedAt);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${row.roomId}-${y}-${m}-${d}.${ext}`;
  }
  return `${row.roomId}-${row.recordingId.slice(0, 8)}.${ext}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatWhen(value: number | string | null): string {
  if (value == null) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
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
  const [recordings, setRecordings] = useState<AdminRecordingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [message, setMessage] = useState(
    "Enter a room name and its password to look up the recording.",
  );
  const [listMessage, setListMessage] = useState(
    "Enter the host create key, then refresh to list every take in R2.",
  );
  const [endCallMessage, setEndCallMessage] = useState(
    "Stop a live room without rejoining: room name + password + host create key.",
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

  const refreshList = async () => {
    const secret = createSecret.trim();
    if (!secret) {
      setListMessage("Enter the host create key to list recordings.");
      return;
    }
    setListBusy(true);
    setListMessage("Loading recordings from R2…");
    try {
      const response = await fetch("/api/admin/recordings", {
        credentials: "same-origin",
        headers: { "x-room-create-secret": secret },
      });
      const payload = (await response.json().catch(() => null)) as {
        count?: number;
        recordings?: AdminRecordingRow[];
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setRecordings([]);
        setListMessage(
          payload?.error?.message ?? `List failed (${response.status}).`,
        );
        return;
      }
      const rows = payload?.recordings ?? [];
      setRecordings(rows);
      setListMessage(
        rows.length === 0
          ? "No recordings found in the bucket."
          : `Found ${rows.length} recording${rows.length === 1 ? "" : "s"}.`,
      );
    } catch {
      setRecordings([]);
      setListMessage("Could not reach the recordings list endpoint.");
    } finally {
      setListBusy(false);
    }
  };

  const downloadListed = async (row: AdminRecordingRow) => {
    const secret = createSecret.trim();
    if (!secret) {
      setListMessage("Enter the host create key to download.");
      return;
    }
    setListBusy(true);
    setListMessage(`Preparing ${row.roomId}…`);
    try {
      const response = await fetch(
        `/api/admin/recordings/download?room=${encodeURIComponent(row.roomId)}&recordingId=${encodeURIComponent(row.recordingId)}`,
        {
          credentials: "same-origin",
          headers: { "x-room-create-secret": secret },
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setListMessage(
          payload?.error?.message ??
            `Download failed for ${row.roomId} (${response.status}).`,
        );
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = adminRowFilename(row);
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setListMessage(`Download started for ${row.roomId}.`);
    } catch {
      setListMessage(`Download failed for ${row.roomId}.`);
    } finally {
      setListBusy(false);
    }
  };

  const deleteListed = async (row: AdminRecordingRow) => {
    const secret = createSecret.trim();
    if (!secret) {
      setListMessage("Enter the host create key to delete.");
      return;
    }
    if (
      !confirm(
        `Delete recording for room "${row.roomId}" (${row.recordingId.slice(0, 8)}…)? This removes it from R2 and cannot be undone.`,
      )
    ) {
      return;
    }
    setListBusy(true);
    setListMessage(`Deleting ${row.roomId}…`);
    try {
      const response = await fetch("/api/admin/recordings/delete", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-room-create-secret": secret,
        },
        body: JSON.stringify({
          room: row.roomId,
          recordingId: row.recordingId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        deletedObjects?: number;
        error?: { message?: string };
        ok?: boolean;
      } | null;
      if (!response.ok) {
        setListMessage(
          payload?.error?.message ??
            `Delete failed for ${row.roomId} (${response.status}).`,
        );
        return;
      }
      setRecordings((current) =>
        current.filter(
          (item) =>
            !(
              item.roomId === row.roomId &&
              item.recordingId === row.recordingId
            ),
        ),
      );
      if (
        status?.recordingId &&
        status.recordingId === row.recordingId &&
        roomId.trim().toLowerCase() === row.roomId
      ) {
        setStatus(null);
      }
      setListMessage(
        `Deleted ${row.roomId} (${payload?.deletedObjects ?? 0} object(s)).`,
      );
    } catch {
      setListMessage(`Delete failed for ${row.roomId}.`);
    } finally {
      setListBusy(false);
    }
  };

  const endLiveCall = async () => {
    const room = roomId.trim().toLowerCase();
    const secret = createSecret.trim();
    if (!ROOM_ID.test(room)) {
      setEndCallMessage("Enter a valid room name above.");
      return;
    }
    if (password.length < 8) {
      setEndCallMessage("Enter the room password above.");
      return;
    }
    if (!secret) {
      setEndCallMessage("Enter the host create key to end a live call.");
      return;
    }
    if (
      !confirm(
        `End the live call for everyone in "${room}" and stop recording? Guests will be disconnected.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setEndCallMessage("Ending live call…");
    try {
      const response = await fetch("/api/admin/end-call", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-room-create-secret": secret,
        },
        body: JSON.stringify({ room, password }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
        ok?: boolean;
      } | null;
      if (!response.ok) {
        setEndCallMessage(
          payload?.error?.message ?? `End call failed (${response.status}).`,
        );
        return;
      }
      setEndCallMessage(
        `Live call ended for ${room}. Guests were disconnected and recording finalize was requested.`,
      );
    } catch {
      setEndCallMessage("Could not reach the end-call endpoint.");
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
      setRecordings([]);
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
      setListMessage("Recording list cleared after purge.");
    } catch {
      setPurgeMessage("Could not reach the purge endpoint.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
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
          Look up a room by password, list every take in R2 with the host create
          key, and download OGG or WAV. Recordings are deleted automatically
          after 7 days.
        </p>
      </header>

      <form
        className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <h2 className="text-base font-semibold text-stone-900">Room lookup</h2>
        <label className="mt-4 block text-sm font-medium text-stone-800" htmlFor="admin-room">
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
            disabled={busy || listBusy}
            type="submit"
          >
            Look up
          </button>
          <button
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || listBusy || !status?.downloadable}
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

      <section className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 className="text-base font-semibold text-amber-950">
          End live call
        </h2>
        <p className="mt-2 text-sm leading-6 text-amber-950/80">
          Use this when the host closed the browser and cannot rejoin. Uses the
          room name and password from the lookup form plus the host create key.
          Same effect as in-room End call: disconnect everyone and finalize
          recording.
        </p>
        <button
          className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-amber-800 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || listBusy}
          onClick={() => void endLiveCall()}
          type="button"
        >
          End live call for room
        </button>
        <p className="mt-3 text-sm text-amber-950" role="status">
          {endCallMessage}
        </p>
      </section>

      <section className="mt-8 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-stone-900">
          All recordings
        </h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Lists every room/recording take stored in the recordings bucket.
          Requires the host create key (same as purge).
        </p>

        <label
          className="mt-4 block text-sm font-medium text-stone-800"
          htmlFor="admin-list-secret"
        >
          Host create key
        </label>
        <input
          id="admin-list-secret"
          autoComplete="off"
          className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm"
          placeholder="ROOM_CREATE_SECRET"
          type="password"
          value={createSecret}
          onChange={(event) => setCreateSecret(event.target.value)}
        />

        <button
          className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || listBusy}
          onClick={() => void refreshList()}
          type="button"
        >
          Refresh list
        </button>

        <p className="mt-3 text-sm text-stone-700" role="status">
          {listMessage}
        </p>

        {recordings.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200 text-left text-sm">
              <thead className="bg-stone-50 text-stone-600">
                <tr>
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Format</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium"> </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 bg-white">
                {recordings.map((row) => (
                  <tr key={`${row.roomId}/${row.recordingId}`}>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-stone-900">{row.roomId}</div>
                      <div className="truncate text-xs text-stone-500" title={row.recordingId}>
                        {row.recordingId.slice(0, 8)}…
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-stone-800">
                      {formatWhen(row.startedAt ?? row.modifiedAt)}
                    </td>
                    <td className="px-3 py-2 align-top text-stone-800">
                      {formatBytes(row.bytes)}
                      {row.pcmChunks > 0 ? (
                        <div className="text-xs text-stone-500">
                          {row.pcmChunks} PCM
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top text-stone-800">
                      {row.format === "ogg/opus"
                        ? "OGG"
                        : row.format === "pcm/wav"
                          ? "WAV"
                          : "—"}
                    </td>
                    <td className="px-3 py-2 align-top text-stone-800">
                      {row.status ?? "—"}
                      {row.lastError ? (
                        <div className="max-w-[14rem] text-xs text-red-700">
                          {row.lastError}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={busy || listBusy || !row.downloadable}
                          onClick={() => void downloadListed(row)}
                          type="button"
                        >
                          Download
                        </button>
                        <button
                          className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={busy || listBusy}
                          onClick={() => void deleteListed(row)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 className="text-base font-semibold text-red-900">
          Delete all rooms &amp; recordings
        </h2>
        <p className="mt-2 text-sm leading-6 text-red-900/80">
          Removes every object in the recordings bucket and resets RoomDO,
          RecordingDO, and VideoRoom for rooms found in R2 plus any rooms listed
          below or remembered in this browser. Uses the host create key above.
        </p>

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
          disabled={busy || listBusy}
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
