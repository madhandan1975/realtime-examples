import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deleteRecordingFromR2,
  listRecordingsFromR2,
} from "../../src/server/admin-recordings";

class FakeR2Object {
  constructor(
    readonly key: string,
    readonly size: number,
    readonly uploaded: Date,
    private readonly body?: unknown,
  ) {}

  async json(): Promise<unknown> {
    return this.body;
  }
}

class FakeBucket {
  constructor(private readonly objects: FakeR2Object[]) {}

  async list(options?: { cursor?: string; limit?: number; prefix?: string }) {
    const filtered = options?.prefix
      ? this.objects.filter((object) => object.key.startsWith(options.prefix!))
      : this.objects;
    return {
      objects: filtered.map((object) => ({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded,
      })),
      truncated: false,
    };
  }

  async get(key: string) {
    return this.objects.find((object) => object.key === key) ?? null;
  }

  async delete(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const index = this.objects.findIndex((object) => object.key === key);
      if (index >= 0) this.objects.splice(index, 1);
    }
  }
}

describe("listRecordingsFromR2", () => {
  it("groups PCM and OGG objects by room and recording id", async () => {
    const older = new Date("2026-11-19T10:00:00.000Z");
    const newer = new Date("2026-11-20T10:00:00.000Z");
    const bucket = new FakeBucket([
      new FakeR2Object(
        "room-a/11111111-1111-1111-1111-111111111111/000001.pcm",
        1000,
        older,
      ),
      new FakeR2Object(
        "room-a/11111111-1111-1111-1111-111111111111/manifest.json",
        200,
        older,
        {
          bytesRecorded: 1000,
          format: "pcm/wav",
          startedAt: older.getTime(),
          status: "ready",
        },
      ),
      new FakeR2Object(
        "room-b/22222222-2222-2222-2222-222222222222/audio.ogg",
        5000,
        newer,
      ),
      new FakeR2Object("room-b/latest-manifest.json", 100, newer),
    ]) as unknown as R2Bucket;

    const rows = await listRecordingsFromR2(bucket);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.roomId, "room-b");
    assert.equal(rows[0]?.format, "ogg/opus");
    assert.equal(rows[0]?.downloadable, true);
    assert.equal(rows[1]?.roomId, "room-a");
    assert.equal(rows[1]?.format, "pcm/wav");
    assert.equal(rows[1]?.pcmChunks, 1);
  });

  it("deletes one take prefix and latest-manifest when it matches", async () => {
    const objects = [
      new FakeR2Object(
        "room-a/11111111-1111-1111-1111-111111111111/000001.pcm",
        1000,
        new Date("2026-11-19T10:00:00.000Z"),
      ),
      new FakeR2Object(
        "room-a/11111111-1111-1111-1111-111111111111/manifest.json",
        200,
        new Date("2026-11-19T10:00:00.000Z"),
        { recordingId: "11111111-1111-1111-1111-111111111111" },
      ),
      new FakeR2Object(
        "room-a/latest-manifest.json",
        100,
        new Date("2026-11-19T10:00:00.000Z"),
        { recordingId: "11111111-1111-1111-1111-111111111111" },
      ),
      new FakeR2Object(
        "room-a/22222222-2222-2222-2222-222222222222/audio.ogg",
        5000,
        new Date("2026-11-20T10:00:00.000Z"),
      ),
    ];
    const bucket = new FakeBucket(objects) as unknown as R2Bucket;
    const result = await deleteRecordingFromR2(
      bucket,
      "room-a",
      "11111111-1111-1111-1111-111111111111",
    );
    assert.equal(result.deletedObjects, 3);
    const remaining = await listRecordingsFromR2(bucket);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.recordingId, "22222222-2222-2222-2222-222222222222");
  });
});
