import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeStereoPcmToOggOpus,
  oggDownloadFilename,
  OPUS_BITRATE_KBPS,
} from "../../src/server/opus-ogg";
import { stereoInt16ToMono } from "../../src/server/pcm-mono";

describe("pcm mono", () => {
  it("averages left and right channels", () => {
    const stereo = new Int16Array([1000, 3000, -2000, 2000]);
    const mono = stereoInt16ToMono(stereo);
    assert.equal(mono.length, 2);
    assert.equal(mono[0], 2000);
    assert.equal(mono[1], 0);
  });
});

describe("ogg download filename", () => {
  it("uses UTC calendar date from startedAt", () => {
    assert.equal(
      oggDownloadFilename(Date.UTC(2026, 10, 19, 23, 30, 0)),
      "2026-11-19.ogg",
    );
  });
});

describe("opus ogg encode", () => {
  it("encodes stereo PCM to OGG near Telegram bitrate", async () => {
    const seconds = 2;
    const sampleRate = 48_000;
    const frames = sampleRate * seconds;
    const stereo = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
      stereo[i * 2] = sample;
      stereo[i * 2 + 1] = sample;
    }
    const bytes = new Uint8Array(stereo.buffer, stereo.byteOffset, stereo.byteLength);
    const ogg = await encodeStereoPcmToOggOpus([bytes]);

    assert.ok(ogg.byteLength > 100, "expected non-empty OGG");
    assert.equal(String.fromCharCode(ogg[0]!, ogg[1]!, ogg[2]!, ogg[3]!), "OggS");

    const bytesPerSecond = ogg.byteLength / seconds;
    const kbps = (bytesPerSecond * 8) / 1000;
    // Container overhead makes short clips higher than steady-state bitrate.
    assert.ok(
      kbps < OPUS_BITRATE_KBPS * 4,
      `unexpected bitrate ${kbps.toFixed(1)} kbps for ${seconds}s`,
    );
    const projectedMbPerHour = (bytesPerSecond * 3600) / 1_000_000;
    assert.ok(
      projectedMbPerHour < 40,
      `projected ${projectedMbPerHour.toFixed(1)} MB/h is too large`,
    );
  });
});
