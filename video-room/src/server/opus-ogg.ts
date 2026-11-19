import { stereoInt16ToMonoFloat32 } from "./pcm-mono";
import {
  loadOpusEmscriptenModule,
  type OpusEmscriptenModule,
} from "./opus-wasm";

export const OPUS_BITRATE_KBPS = 32;
export const OPUS_SAMPLE_RATE = 48_000;
export const OPUS_CHANNELS = 1;

const FRAME = 960; // 20 ms at 48 kHz
const APP = { audio: 2049, voip: 2048, lowdelay: 2051 } as const;
const SET_BITRATE = 4002;
const SET_COMPLEXITY = 4010;
const PAGE_BYTES = 4096;
const PAGE_PACKETS = 50;
const ERRORS = [
  "OK",
  "OPUS_BAD_ARG",
  "OPUS_BUFFER_TOO_SMALL",
  "OPUS_INTERNAL_ERROR",
  "OPUS_INVALID_PACKET",
  "OPUS_UNIMPLEMENTED",
  "OPUS_INVALID_STATE",
  "OPUS_ALLOC_FAIL",
];

/** UTC calendar date filename from recording startedAt, e.g. 2026-11-19.ogg */
export function oggDownloadFilename(startedAt: number): string {
  const date = new Date(startedAt > 0 ? startedAt : Date.now());
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}.ogg`;
}

/**
 * Encode interleaved stereo Int16 PCM chunks (48 kHz) to a single OGG Opus
 * bitstream: mono, VOIP application, 32 kbps — Telegram-style speech settings.
 *
 * Uses a precompiled Wasm Module so Cloudflare Workers can run libopus.
 */
export async function encodeStereoPcmToOggOpus(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const mod = await loadOpusEmscriptenModule();
  const enc = createPacketEncoder(mod, {
    application: "voip",
    bitrate: OPUS_BITRATE_KBPS,
    channels: OPUS_CHANNELS,
  });

  const serial = (Math.random() * 0xffffffff) >>> 0;
  let pageSeq = 0;
  let granule = 0;
  let total = 0;
  let pcm: Float32Array = new Float32Array(0);
  let headerSent = false;
  let queue: Uint8Array[] = [];
  let queueBytes = 0;
  const headerPages = [
    oggPage(opusHead(OPUS_CHANNELS, enc.lookahead, OPUS_SAMPLE_RATE), serial, pageSeq++, 0, 0x02),
    oggPage(opusTags(), serial, pageSeq++, 0, 0x00),
  ];

  const parts: Uint8Array[] = [];
  try {
    for await (const bytes of asAsyncIterable(chunks)) {
      if (bytes.byteLength < 4) continue;
      const stereo = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        Math.floor(bytes.byteLength / 2),
      );
      const mono = stereoInt16ToMonoFloat32(stereo);
      if (!mono.length) continue;
      parts.push(...emitPages(mono, false));
    }
    parts.push(...emitPages(new Float32Array(0), true));
  } finally {
    enc.free();
  }

  return concatUint8(parts);

  function headers(): Uint8Array[] {
    if (headerSent) return [];
    headerSent = true;
    return headerPages;
  }

  function emitPages(next: Float32Array, last: boolean): Uint8Array[] {
    const pages = headers();
    total += next.length / OPUS_CHANNELS;
    if (pcm.length) {
      const joined = new Float32Array(pcm.length + next.length);
      joined.set(pcm);
      joined.set(next, pcm.length);
      next = joined;
    }
    pcm = next;
    const frameLen = FRAME * OPUS_CHANNELS;
    let pos = 0;
    while (pcm.length - pos >= frameLen) {
      packet(pcm.subarray(pos, pos + frameLen), pages, false);
      pos += frameLen;
    }
    pcm = new Float32Array(pcm.subarray(pos));

    if (last) {
      const need = total + enc.lookahead - granule;
      const frames = Math.max(1, Math.ceil(need / FRAME));
      const padded = new Float32Array(frames * FRAME * OPUS_CHANNELS);
      padded.set(pcm);
      pcm = new Float32Array(0);
      for (let i = 0; i < frames; i += 1) {
        packet(
          padded.subarray(i * FRAME * OPUS_CHANNELS, (i + 1) * FRAME * OPUS_CHANNELS),
          pages,
          true,
        );
      }
      pages.push(oggPage(queue, serial, pageSeq++, total + enc.lookahead, 0x04));
      queue = [];
      queueBytes = 0;
    }
    return pages;
  }

  function packet(frame: Float32Array, pages: Uint8Array[], isLast: boolean) {
    const p = enc.encode(frame);
    granule += FRAME;
    queue.push(p);
    queueBytes += p.length;
    if (!isLast && (queueBytes >= PAGE_BYTES || queue.length >= PAGE_PACKETS)) {
      pages.push(oggPage(queue, serial, pageSeq++, granule, 0x00));
      queue = [];
      queueBytes = 0;
    }
  }
}

function createPacketEncoder(
  m: OpusEmscriptenModule,
  opts: {
    application: keyof typeof APP;
    bitrate: number;
    channels: number;
  },
) {
  const channels = opts.channels;
  const app = APP[opts.application];
  const handle = m._audio_opus_enc_create(OPUS_SAMPLE_RATE, channels, app);
  if (!handle) {
    throw new Error(`libopus ${errName(m._audio_opus_enc_last_error())}`);
  }
  check(m, m._audio_opus_enc_set(handle, SET_BITRATE, opts.bitrate * 1000));
  check(m, m._audio_opus_enc_set(handle, SET_COMPLEXITY, 10));
  const lookahead = check(m, m._audio_opus_enc_lookahead(handle));
  const input = m._audio_opus_enc_input(handle) >> 2;
  let h = handle;

  return {
    lookahead,
    encode(frame: Float32Array): Uint8Array {
      if (!h) throw new Error("Encoder already freed");
      if (frame.length !== FRAME * channels) {
        throw new Error(`Opus frame must hold ${FRAME} samples per channel`);
      }
      m.HEAPF32.set(frame, input);
      const n = check(m, m._audio_opus_enc_encode(h, FRAME));
      const out = m._audio_opus_enc_output(h);
      return m.HEAPU8.slice(out, out + n);
    },
    free() {
      if (!h) return;
      m._audio_opus_enc_destroy(h);
      h = 0;
    },
  };
}

function errName(code: number): string {
  return `${code} ${ERRORS[-code] || "UNKNOWN_ERROR"}`;
}

function check(m: OpusEmscriptenModule, code: number): number {
  if (code < 0) throw new Error(`libopus ${errName(code)}`);
  return code;
}

function oggPage(
  packets: Uint8Array | Uint8Array[],
  serial: number,
  seq: number,
  granule: number,
  flags: number,
): Uint8Array {
  const list = Array.isArray(packets) ? packets : [packets];
  const segs: number[] = [];
  let size = 0;
  for (const packet of list) {
    let rem = packet.length;
    while (rem >= 255) {
      segs.push(255);
      rem -= 255;
    }
    segs.push(rem);
    size += packet.length;
  }

  const hdrLen = 27 + segs.length;
  const page = new Uint8Array(hdrLen + size);
  const view = new DataView(page.buffer);
  page[0] = 0x4f;
  page[1] = 0x67;
  page[2] = 0x67;
  page[3] = 0x53;
  page[4] = 0;
  page[5] = flags;
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 0x100000000) >>> 0, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, seq, true);
  view.setUint32(22, 0, true);
  page[26] = segs.length;
  for (let i = 0; i < segs.length; i += 1) page[27 + i] = segs[i]!;
  let offset = hdrLen;
  for (const packet of list) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(channels: number, preSkip: number, inputRate: number): Uint8Array {
  const bytes = new Uint8Array(19);
  const view = new DataView(bytes.buffer);
  setAscii(bytes, 0, "OpusHead");
  bytes[8] = 1;
  bytes[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true);
  bytes[18] = 0;
  return bytes;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("voice-room-sfu");
  const size = 8 + 4 + vendor.length + 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  setAscii(bytes, 0, "OpusTags");
  let pos = 8;
  view.setUint32(pos, vendor.length, true);
  pos += 4;
  bytes.set(vendor, pos);
  pos += vendor.length;
  view.setUint32(pos, 0, true);
  return bytes;
}

function setAscii(buf: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    buf[offset + i] = value.charCodeAt(i);
  }
}

let crcTable: Uint32Array | undefined;
function oggCrc(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let r = i << 24;
      for (let j = 0; j < 8; j += 1) {
        r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        r >>>= 0;
      }
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < data.length; i += 1) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  }
  return crc;
}

function asAsyncIterable(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in chunks) {
    return chunks as AsyncIterable<Uint8Array>;
  }
  return (async function* () {
    for (const chunk of chunks as Iterable<Uint8Array>) {
      yield chunk;
    }
  })();
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
