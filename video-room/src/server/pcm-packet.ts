/**
 * Minimal protobuf decoder for Cloudflare Calls Packet messages.
 * Fields: sequenceNumber=1, timestamp=2, payload=5 (bytes).
 */
export function extractPcmFromSfuPacket(
  packetData: ArrayBuffer,
): ArrayBuffer | null {
  try {
    const bytes = new Uint8Array(packetData);
    let pos = 0;
    let payload: Uint8Array | null = null;
    while (pos < bytes.length) {
      const tag = readVarint(bytes, pos);
      pos = tag.next;
      const fieldNo = tag.value >>> 3;
      const wireType = tag.value & 7;
      if (wireType === 0) {
        pos = readVarint(bytes, pos).next;
      } else if (wireType === 2) {
        const length = readVarint(bytes, pos);
        pos = length.next;
        const end = pos + length.value;
        if (end > bytes.length) return null;
        const data = bytes.subarray(pos, end);
        pos = end;
        if (fieldNo === 5) payload = data;
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 1) {
        pos += 8;
      } else {
        return null;
      }
    }
    if (!payload || payload.byteLength === 0) return null;
    let view = payload;
    if (view.byteLength % 2 !== 0) {
      view = view.subarray(0, view.byteLength - 1);
    }
    return new Uint8Array(view).buffer;
  } catch {
    return null;
  }
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { next: number; value: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos]!;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { next: pos, value };
    shift += 7;
    if (shift > 35) throw new Error("Varint too long.");
  }
  throw new Error("Unexpected end of buffer.");
}
