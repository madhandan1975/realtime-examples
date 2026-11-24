import { roomIdSchema } from "../shared/protocol";

export type AdminRecordingSummary = {
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

type ManifestJson = {
  bytesRecorded?: number;
  chunkCount?: number;
  chunks?: Array<{ key: string; samples: number }>;
  downloadFilename?: string | null;
  downloadKey?: string | null;
  expiresAt?: number | null;
  format?: string | null;
  lastError?: string | null;
  recordingId?: string;
  startedAt?: number;
  status?: string;
};

type TakeAccumulator = {
  bytes: number;
  hasManifest: boolean;
  hasOgg: boolean;
  modifiedAt: string | null;
  objectCount: number;
  pcmChunks: number;
  pcmKeys: string[];
  recordingId: string;
  roomId: string;
};

/** Scan the recordings bucket and return one row per room/recording take. */
export async function listRecordingsFromR2(
  bucket: R2Bucket,
): Promise<AdminRecordingSummary[]> {
  const takes = new Map<string, TakeAccumulator>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    for (const object of listed.objects) {
      const parsed = parseRecordingObjectKey(object.key);
      if (!parsed) continue;
      const id = `${parsed.roomId}/${parsed.recordingId}`;
      const current =
        takes.get(id) ??
        ({
          bytes: 0,
          hasManifest: false,
          hasOgg: false,
          modifiedAt: null,
          objectCount: 0,
          pcmChunks: 0,
          pcmKeys: [],
          recordingId: parsed.recordingId,
          roomId: parsed.roomId,
        } satisfies TakeAccumulator);
      current.bytes += object.size;
      current.objectCount += 1;
      const modified = object.uploaded.toISOString();
      if (!current.modifiedAt || modified > current.modifiedAt) {
        current.modifiedAt = modified;
      }
      if (parsed.kind === "ogg") current.hasOgg = true;
      if (parsed.kind === "manifest") current.hasManifest = true;
      if (parsed.kind === "pcm") {
        current.pcmChunks += 1;
        current.pcmKeys.push(object.key);
      }
      takes.set(id, current);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const summaries: AdminRecordingSummary[] = [];
  for (const take of takes.values()) {
    let manifest: ManifestJson | null = null;
    if (take.hasManifest) {
      const object = await bucket.get(
        `${take.roomId}/${take.recordingId}/manifest.json`,
      );
      if (object) {
        try {
          manifest = (await object.json()) as ManifestJson;
        } catch {
          manifest = null;
        }
      }
    }

    const format =
      take.hasOgg || manifest?.format === "ogg/opus"
        ? "ogg/opus"
        : take.pcmChunks > 0 || (manifest?.chunks?.length ?? 0) > 0
          ? "pcm/wav"
          : "unknown";
    const downloadable = take.hasOgg || take.pcmChunks > 0;
    summaries.push({
      bytes: manifest?.bytesRecorded ?? take.bytes,
      downloadFilename:
        manifest?.downloadFilename ??
        defaultFilename(manifest?.startedAt ?? null, format),
      downloadable,
      expiresAt:
        typeof manifest?.expiresAt === "number" ? manifest.expiresAt : null,
      format,
      hasManifest: take.hasManifest,
      hasOgg: take.hasOgg,
      lastError: manifest?.lastError ?? null,
      modifiedAt: take.modifiedAt,
      objectCount: take.objectCount,
      pcmChunks: take.pcmChunks,
      recordingId: take.recordingId,
      roomId: take.roomId,
      startedAt:
        typeof manifest?.startedAt === "number" ? manifest.startedAt : null,
      status: manifest?.status ?? (downloadable ? "stored" : "empty"),
    });
  }

  summaries.sort((left, right) => {
    const leftTime =
      left.startedAt ?? (Date.parse(left.modifiedAt ?? "") || 0);
    const rightTime =
      right.startedAt ?? (Date.parse(right.modifiedAt ?? "") || 0);
    return rightTime - leftTime;
  });
  return summaries;
}

/** Delete one take prefix and clear latest-manifest when it pointed at that take. */
export async function deleteRecordingFromR2(
  bucket: R2Bucket,
  roomId: string,
  recordingId: string,
): Promise<{ deletedObjects: number; roomId: string; recordingId: string }> {
  const room = roomIdSchema.safeParse(roomId);
  if (!room.success || !/^[0-9a-f-]{36}$/i.test(recordingId)) {
    throw new Error("Invalid room or recording id.");
  }

  const prefix = `${room.data}/${recordingId}/`;
  let deletedObjects = 0;
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ cursor, limit: 1000, prefix });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
      deletedObjects += listed.objects.length;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  const latestKey = `${room.data}/latest-manifest.json`;
  const latest = await bucket.get(latestKey);
  if (latest) {
    try {
      const parsed = (await latest.json()) as { recordingId?: string };
      if (parsed.recordingId === recordingId) {
        await bucket.delete(latestKey);
        deletedObjects += 1;
      }
    } catch {
      // Leave a corrupt latest-manifest alone; prefix objects are already gone.
    }
  }

  return { deletedObjects, roomId: room.data, recordingId };
}

/** Stream a specific take as OGG (preferred) or WAV PCM. */
export async function downloadRecordingFromR2(
  bucket: R2Bucket,
  roomId: string,
  recordingId: string,
): Promise<Response> {
  const room = roomIdSchema.safeParse(roomId);
  if (!room.success || !/^[0-9a-f-]{36}$/i.test(recordingId)) {
    return new Response("Invalid room or recording id.", { status: 400 });
  }

  const oggKey = `${room.data}/${recordingId}/audio.ogg`;
  const ogg = await bucket.get(oggKey);
  if (ogg) {
    const headers = new Headers();
    headers.set("cache-control", "no-store");
    headers.set("content-type", "audio/ogg");
    headers.set(
      "content-disposition",
      `attachment; filename="${defaultFilename(null, "ogg/opus")}"`,
    );
    if (typeof ogg.size === "number") {
      headers.set("content-length", String(ogg.size));
    }
    return new Response(ogg.body, { headers });
  }

  const pcmKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      cursor,
      limit: 1000,
      prefix: `${room.data}/${recordingId}/`,
    });
    for (const object of listed.objects) {
      if (/\d+\.pcm$/.test(object.key)) pcmKeys.push(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  pcmKeys.sort();
  if (pcmKeys.length === 0) {
    return new Response("Recording not found.", { status: 404 });
  }

  const chunks: Array<{ key: string; samples: number }> = [];
  for (const key of pcmKeys) {
    const head = await bucket.head(key);
    const samples = Number(head?.customMetadata?.samples ?? 0);
    if (!head || !Number.isFinite(samples) || samples <= 0) continue;
    chunks.push({ key, samples });
  }
  if (chunks.length === 0) {
    return new Response("Recording PCM metadata missing.", { status: 404 });
  }

  return streamWav(bucket, chunks, 48_000);
}

function parseRecordingObjectKey(
  key: string,
): { roomId: string; recordingId: string; kind: "ogg" | "pcm" | "manifest" | "other" } | null {
  const parts = key.split("/");
  if (parts.length < 3) return null;
  const roomId = parts[0]!;
  const recordingId = parts[1]!;
  if (!roomIdSchema.safeParse(roomId).success) return null;
  if (recordingId === "latest-manifest.json") return null;
  if (!/^[0-9a-f-]{36}$/i.test(recordingId)) return null;
  const name = parts.slice(2).join("/");
  if (name === "audio.ogg") {
    return { roomId, recordingId, kind: "ogg" };
  }
  if (name === "manifest.json") {
    return { roomId, recordingId, kind: "manifest" };
  }
  if (/^\d+\.pcm$/.test(name)) {
    return { roomId, recordingId, kind: "pcm" };
  }
  return { roomId, recordingId, kind: "other" };
}

function defaultFilename(
  startedAt: number | null,
  format: "ogg/opus" | "pcm/wav" | "unknown",
): string {
  const ext = format === "ogg/opus" ? "ogg" : "wav";
  if (startedAt) {
    const date = new Date(startedAt);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}.${ext}`;
  }
  return `recording.${ext}`;
}

function streamWav(
  bucket: R2Bucket,
  chunks: Array<{ key: string; samples: number }>,
  sampleRate: number,
): Response {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.samples, 0);
  const dataBytes = totalSamples * 2;
  const header = wavHeader(sampleRate, dataBytes, 2);
  let index = 0;
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
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="recording.wav"',
      "content-type": "audio/wav",
    },
  });
}

function wavHeader(
  sampleRate: number,
  dataBytes: number,
  channels: number,
): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}
