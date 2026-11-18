import { DurableObject } from "cloudflare:workers";

import { extractPcmFromSfuPacket } from "./server/pcm-packet";
import { RealtimeSfuClient, type RealtimeEnv } from "./server/realtime";

export type RecordingTrack = {
  sessionId: string;
  trackName: string;
};

type RecordingEnvironment = RealtimeEnv & {
  RECORDINGS: R2Bucket;
  WORKER_HOSTNAME?: string;
};

type AdapterState = {
  adapterId: string;
  sessionId: string;
  trackName: string;
};

type RecordingState = {
  adapters: AdapterState[];
  bytesRecorded: number;
  chunkCount: number;
  chunks: Array<{ bytes: number; key: string; samples: number }>;
  desiredTracks: RecordingTrack[];
  expiresAt: number | null;
  finalized: boolean;
  lastError: string | null;
  maxEndsAt: number;
  packetsReceived: number;
  packetsRejected: number;
  recordingId: string;
  roomId: string;
  sampleRate: number;
  startedAt: number;
  status: "idle" | "recording" | "finalizing" | "ready" | "failed";
};

type PcmSocketAttachment = {
  sessionId: string;
  trackName: string;
};

const FLUSH_INTERVAL_MS = 15_000;
const MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SAMPLE_RATE = 48_000;
const MAX_PENDING_BYTES = 4_000_000;
const ADAPTER_HEAL_MS = 5_000;

export class RecordingDO extends DurableObject<RecordingEnvironment> {
  private state: RecordingState = emptyState("");
  private ready: Promise<void>;
  private mutations = Promise.resolve();
  private pendingByTrack = new Map<string, Int16Array[]>();
  private pendingSamples = 0;

  constructor(ctx: DurableObjectState, env: RecordingEnvironment) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const roomId = ctx.id.name ?? "";
      this.state = (await ctx.storage.get<RecordingState>("recording")) ?? emptyState(roomId);
      if (!this.state.roomId) this.state.roomId = roomId;
      this.state.expiresAt ??= null;
      this.state.lastError ??= null;
      this.state.packetsReceived ??= 0;
      this.state.packetsRejected ??= 0;
      if (
        this.state.expiresAt &&
        this.state.expiresAt > Date.now() &&
        (this.state.status === "ready" || this.state.status === "failed")
      ) {
        await this.ctx.storage.setAlarm(this.state.expiresAt);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/pcm" && request.method === "GET") {
      return this.acceptPcmSocket(request, url);
    }
    if (url.pathname === "/sync-tracks" && request.method === "POST") {
      return this.syncTracks(request);
    }
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json(this.publicStatus());
    }
    if (url.pathname === "/finalize" && request.method === "POST") {
      return this.finalize();
    }
    if (url.pathname === "/download/audio" && request.method === "GET") {
      return this.downloadAudio();
    }
    if (url.pathname === "/socket" && request.method === "GET") {
      return this.openStatusSocket(request);
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.serial(async () => {
      if (this.state.status === "recording") {
        if (Date.now() >= this.state.maxEndsAt) {
          await this.flushPending(true);
          await this.finalizeLocked("max_duration");
          return;
        }
        await this.flushPending(false);
        await this.healAdapters();
        await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
      } else if (this.state.status === "finalizing") {
        await this.finalizeLocked("alarm");
      } else if (
        this.state.expiresAt &&
        Date.now() >= this.state.expiresAt &&
        (this.state.status === "ready" || this.state.status === "failed")
      ) {
        await this.purgeExpired();
      }
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const attachment = socket.deserializeAttachment() as PcmSocketAttachment | null;
    if (!attachment) {
      socket.close(1008, "Invalid recording socket.");
      return;
    }
    if (typeof message === "string") return;
    this.state.packetsReceived += 1;
    const pcm = extractPcmFromSfuPacket(message);
    if (!pcm) {
      this.state.packetsRejected += 1;
      if (!this.state.lastError) {
        this.state.lastError = "Received SFU packets that could not be decoded as PCM.";
      }
      return;
    }
    const samples = new Int16Array(pcm);
    if (!samples.length) return;
    if (this.state.lastError?.includes("could not be decoded")) {
      this.state.lastError = null;
    }
    const key = trackKey(attachment.sessionId, attachment.trackName);
    const queue = this.pendingByTrack.get(key) ?? [];
    queue.push(samples);
    this.pendingByTrack.set(key, queue);
    this.pendingSamples += samples.length;
    const pendingBytes = this.pendingSamples * 2;
    if (pendingBytes >= MAX_PENDING_BYTES) {
      await this.serial(async () => {
        await this.flushPending(false);
      });
    }
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as PcmSocketAttachment | null;
    if (!attachment) return;
    void this.serial(async () => {
      if (this.state.status !== "recording") return;
      this.state.adapters = this.state.adapters.filter(
        (item) =>
          !(
            item.sessionId === attachment.sessionId &&
            item.trackName === attachment.trackName
          ),
      );
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + ADAPTER_HEAL_MS);
    });
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Recording socket error.");
  }

  private async syncTracks(request: Request): Promise<Response> {
    return this.serial(async () => {
      let body: { roomId?: unknown; tracks?: unknown };
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const tracks = normalizeTracks(body.tracks);
      const roomId =
        typeof body.roomId === "string" && body.roomId
          ? body.roomId
          : this.state.roomId;
      this.state.roomId = roomId;
      this.state.desiredTracks = tracks;

      if (tracks.length === 0) {
        if (this.state.status === "recording") {
          await this.flushPending(true);
          await this.finalizeLocked("no_tracks");
        }
        return Response.json(this.publicStatus());
      }

      // A finished/failed session must not block the next meeting in this room.
      if (
        this.state.finalized ||
        this.state.status === "ready" ||
        this.state.status === "failed"
      ) {
        this.state = emptyState(roomId);
        this.state.desiredTracks = tracks;
      }

      if (this.state.status === "idle") {
        this.state.status = "recording";
        this.state.recordingId = crypto.randomUUID();
        this.state.startedAt = Date.now();
        this.state.maxEndsAt = this.state.startedAt + MAX_DURATION_MS;
        this.state.finalized = false;
        this.state.lastError = null;
        await this.persist();
        await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
        this.broadcastStatus();
      }

      await this.healAdapters();
      return Response.json(this.publicStatus());
    });
  }

  private async healAdapters(): Promise<void> {
    if (this.state.status !== "recording") return;
    const hostname = this.env.WORKER_HOSTNAME?.trim();
    if (!hostname) {
      this.state.lastError = "WORKER_HOSTNAME is not configured.";
      this.state.status = "failed";
      await this.persist();
      this.broadcastStatus();
      return;
    }

    const desiredKeys = new Set(
      this.state.desiredTracks.map((track) =>
        trackKey(track.sessionId, track.trackName),
      ),
    );
    const sfu = new RealtimeSfuClient(this.env);

    const nextAdapters: AdapterState[] = [];
    for (const adapter of this.state.adapters) {
      const key = trackKey(adapter.sessionId, adapter.trackName);
      if (!desiredKeys.has(key)) {
        await sfu.closeWebSocketAdapter(adapter.adapterId).catch(() => undefined);
        continue;
      }
      nextAdapters.push(adapter);
    }
    this.state.adapters = nextAdapters;

    const activeKeys = new Set(
      this.state.adapters.map((item) => trackKey(item.sessionId, item.trackName)),
    );
    for (const track of this.state.desiredTracks) {
      const key = trackKey(track.sessionId, track.trackName);
      if (activeKeys.has(key)) continue;
      const endpoint = `wss://${hostname}/api/recording/pcm?room=${encodeURIComponent(this.state.roomId)}&sessionId=${encodeURIComponent(track.sessionId)}&trackName=${encodeURIComponent(track.trackName)}`;
      try {
        const { adapterId, error } = await sfu.pullTrackToWebSocket(
          track.sessionId,
          track.trackName,
          endpoint,
          { outputCodec: "pcm" },
        );
        if (!adapterId) {
          this.state.lastError =
            error ??
            `SFU adapter create returned no adapterId for ${track.trackName}.`;
          console.error("recording adapter missing id", {
            endpointHost: hostname,
            error: this.state.lastError,
            sessionId: track.sessionId,
            trackName: track.trackName,
          });
          continue;
        }
        this.state.adapters.push({
          adapterId,
          sessionId: track.sessionId,
          trackName: track.trackName,
        });
        activeKeys.add(key);
        if (this.state.lastError?.startsWith("SFU adapter")) {
          this.state.lastError = null;
        }
      } catch (error) {
        this.state.lastError =
          error instanceof Error
            ? error.message
            : "SFU adapter create failed.";
        console.error("recording adapter create failed", {
          endpointHost: hostname,
          error:
            error instanceof Error
              ? { message: error.message, name: error.name }
              : error,
          sessionId: track.sessionId,
          trackName: track.trackName,
        });
      }
    }
    if (
      this.state.desiredTracks.length > 0 &&
      this.state.adapters.length === 0 &&
      !this.state.lastError
    ) {
      this.state.lastError =
        "No SFU WebSocket adapters are connected for published audio tracks.";
    }
    await this.persist();
    this.broadcastStatus();
  }

  private acceptPcmSocket(request: Request, url: URL): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const sessionId = url.searchParams.get("sessionId");
    const trackName = url.searchParams.get("trackName");
    if (
      !sessionId ||
      !trackName ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(trackName)
    ) {
      return new Response("Invalid track", { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      sessionId,
      trackName,
    } satisfies PcmSocketAttachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private openStatusSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ kind: "status" });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "status", ...this.publicStatus() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async flushPending(force: boolean): Promise<void> {
    if (this.state.status !== "recording" && !force) return;
    if (this.pendingByTrack.size === 0) return;

    const mixed = mixTracks(this.pendingByTrack);
    this.pendingByTrack.clear();
    this.pendingSamples = 0;
    if (!mixed.length) return;

    const ordinal = String(this.state.chunkCount + 1).padStart(6, "0");
    const key = `${this.state.roomId}/${this.state.recordingId}/${ordinal}.pcm`;
    const bytes = new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength);
    await this.env.RECORDINGS.put(key, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        samples: String(mixed.length),
        sampleRate: String(this.state.sampleRate),
      },
    });
    this.state.chunkCount += 1;
    this.state.bytesRecorded += bytes.byteLength;
    this.state.chunks.push({
      bytes: bytes.byteLength,
      key,
      samples: mixed.length,
    });
    await this.writeManifest();
    await this.persist();
    this.broadcastStatus();
  }

  private async finalize(): Promise<Response> {
    return this.serial(async () => {
      await this.flushPending(true);
      await this.finalizeLocked("manual");
      return Response.json(this.publicStatus());
    });
  }

  private async finalizeLocked(reason: string): Promise<void> {
    if (this.state.finalized && this.state.status === "ready") return;
    this.state.status = "finalizing";
    await this.persist();

    const sfu = new RealtimeSfuClient(this.env);
    for (const adapter of this.state.adapters) {
      await sfu.closeWebSocketAdapter(adapter.adapterId).catch(() => undefined);
    }
    this.state.adapters = [];
    this.state.desiredTracks = [];

    await this.writeManifest(reason);
    this.state.finalized = true;
    if (this.state.chunks.length > 0) {
      this.state.status = "ready";
    } else {
      this.state.status = "failed";
      this.state.lastError ??=
        this.state.packetsReceived > 0
          ? "Recording ended with packets but no stored audio chunks."
          : "Recording ended with no SFU audio packets (adapters never delivered PCM).";
    }
    this.state.expiresAt = Date.now() + RETENTION_MS;
    await this.persist();
    await this.ctx.storage.setAlarm(this.state.expiresAt);
    this.broadcastStatus();
  }

  private async purgeExpired(): Promise<void> {
    const roomId = this.state.roomId;
    const recordingId = this.state.recordingId;
    if (roomId && recordingId) {
      await deletePrefix(this.env.RECORDINGS, `${roomId}/${recordingId}/`);
      const latestKey = `${roomId}/latest-manifest.json`;
      const latest = await this.env.RECORDINGS.get(latestKey);
      if (latest) {
        try {
          const parsed = (await latest.json()) as { recordingId?: string };
          if (parsed.recordingId === recordingId) {
            await this.env.RECORDINGS.delete(latestKey);
          }
        } catch {
          await this.env.RECORDINGS.delete(latestKey);
        }
      }
    }
    this.pendingByTrack.clear();
    this.pendingSamples = 0;
    this.state = emptyState(roomId);
    await this.persist();
    await this.ctx.storage.deleteAlarm();
    this.broadcastStatus();
  }

  private async writeManifest(reason?: string): Promise<void> {
    const manifest = {
      bytesRecorded: this.state.bytesRecorded,
      chunkCount: this.state.chunkCount,
      chunks: this.state.chunks,
      expiresAt: this.state.expiresAt,
      finalized: this.state.finalized,
      maxEndsAt: this.state.maxEndsAt,
      reason,
      recordingId: this.state.recordingId,
      retentionDays: 7,
      roomId: this.state.roomId,
      sampleRate: this.state.sampleRate,
      startedAt: this.state.startedAt,
      status: this.state.status,
      updatedAt: new Date().toISOString(),
    };
    await this.env.RECORDINGS.put(
      `${this.state.roomId}/${this.state.recordingId}/manifest.json`,
      JSON.stringify(manifest),
      { httpMetadata: { contentType: "application/json" } },
    );
    await this.env.RECORDINGS.put(
      `${this.state.roomId}/latest-manifest.json`,
      JSON.stringify(manifest),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  private async downloadAudio(): Promise<Response> {
    if (
      typeof this.state.expiresAt === "number" &&
      this.state.expiresAt <= Date.now()
    ) {
      return new Response("Recording expired and was deleted.", { status: 410 });
    }
    const chunks = this.state.chunks;
    if (!chunks.length) {
      const latest = await this.env.RECORDINGS.get(
        `${this.state.roomId}/latest-manifest.json`,
      );
      if (!latest) return new Response("Recording not found.", { status: 404 });
      const parsed = (await latest.json()) as {
        chunks?: typeof chunks;
        expiresAt?: number | null;
      };
      if (
        typeof parsed.expiresAt === "number" &&
        parsed.expiresAt <= Date.now()
      ) {
        return new Response("Recording expired and was deleted.", {
          status: 410,
        });
      }
      if (!parsed.chunks?.length) {
        return new Response("Recording not found.", { status: 404 });
      }
      return this.streamWav(parsed.chunks, this.state.sampleRate);
    }
    return this.streamWav(chunks, this.state.sampleRate);
  }

  private streamWav(
    chunks: Array<{ key: string; samples: number }>,
    sampleRate: number,
  ): Response {
    // SFU WebSocket PCM is interleaved stereo Int16; `samples` is Int16 count.
    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.samples, 0);
    const dataBytes = totalSamples * 2;
    const header = wavHeader(sampleRate, dataBytes, 2);
    let index = 0;
    const bucket = this.env.RECORDINGS;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(header);
      },
      async pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[index]!;
        index += 1;
        const object = await bucket.get(chunk.key);
        if (!object) {
          controller.error(new Error(`Missing chunk ${chunk.key}`));
          return;
        }
        const bytes = new Uint8Array(await object.arrayBuffer());
        controller.enqueue(bytes);
      },
    });
    return new Response(stream, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="room-recording.wav"',
        "content-type": "audio/wav",
      },
    });
  }

  private publicStatus() {
    const elapsedMs = this.state.startedAt
      ? Math.max(0, Date.now() - this.state.startedAt)
      : 0;
    const expired =
      typeof this.state.expiresAt === "number" &&
      this.state.expiresAt <= Date.now();
    return {
      adapters: this.state.adapters.length,
      bytesRecorded: this.state.bytesRecorded,
      chunkCount: this.state.chunkCount,
      downloadable: this.state.chunkCount > 0 && !expired,
      elapsedMs,
      expiresAt: this.state.expiresAt,
      finalized: this.state.finalized,
      lastError: this.state.lastError,
      maxDurationMs: MAX_DURATION_MS,
      packetsReceived: this.state.packetsReceived,
      packetsRejected: this.state.packetsRejected,
      recordingId: this.state.recordingId || null,
      remainingMs: this.state.maxEndsAt
        ? Math.max(0, this.state.maxEndsAt - Date.now())
        : MAX_DURATION_MS,
      retentionDays: 7,
      status: this.state.status,
      tracks: this.state.desiredTracks.length,
    };
  }

  private broadcastStatus(): void {
    const payload = JSON.stringify({ type: "status", ...this.publicStatus() });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as
        | { kind?: string }
        | PcmSocketAttachment
        | null;
      if (
        attachment &&
        "kind" in attachment &&
        attachment.kind === "status" &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.send(payload);
      }
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("recording", this.state);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation, operation);
    this.mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function emptyState(roomId: string): RecordingState {
  return {
    adapters: [],
    bytesRecorded: 0,
    chunkCount: 0,
    chunks: [],
    desiredTracks: [],
    expiresAt: null,
    finalized: false,
    lastError: null,
    maxEndsAt: 0,
    packetsReceived: 0,
    packetsRejected: 0,
    recordingId: "",
    roomId,
    sampleRate: SAMPLE_RATE,
    startedAt: 0,
    status: "idle",
  };
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ cursor, limit: 1000, prefix });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

function trackKey(sessionId: string, trackName: string): string {
  return `${sessionId}:${trackName}`;
}

function normalizeTracks(value: unknown): RecordingTrack[] {
  if (!Array.isArray(value)) return [];
  const tracks: RecordingTrack[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const sessionId = (item as { sessionId?: unknown }).sessionId;
    const trackName = (item as { trackName?: unknown }).trackName;
    if (
      typeof sessionId !== "string" ||
      typeof trackName !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(trackName)
    ) {
      continue;
    }
    const key = trackKey(sessionId, trackName);
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ sessionId, trackName });
  }
  return tracks;
}

function mixTracks(pendingByTrack: Map<string, Int16Array[]>): Int16Array {
  const flattened: Int16Array[] = [];
  let maxLength = 0;
  for (const parts of pendingByTrack.values()) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    if (!total) continue;
    const merged = new Int16Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    flattened.push(merged);
    maxLength = Math.max(maxLength, merged.length);
  }
  if (!flattened.length || !maxLength) return new Int16Array(0);
  if (flattened.length === 1) return flattened[0]!;

  const mixed = new Int16Array(maxLength);
  for (const track of flattened) {
    for (let i = 0; i < track.length; i += 1) {
      const sample = mixed[i]! + track[i]!;
      mixed[i] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
    }
  }
  return mixed;
}

function wavHeader(
  sampleRate: number,
  dataBytes: number,
  channels = 2,
): Uint8Array {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
