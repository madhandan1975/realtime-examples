import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildInviteUrl,
  decodeInviteToken,
  encodeInviteToken,
} from "../../src/client/ws-bootstrap";

describe("listener invite links", () => {
  it("encodes and decodes invite tokens", () => {
    const password = "room-password-demo";
    const token = encodeInviteToken(password);
    assert.equal(decodeInviteToken(token), password);
  });

  it("adds listen=1 for listener invites", () => {
    const original = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://voice.example/rooms/demo"),
    });
    try {
      const speaker = buildInviteUrl("demo", "room-password-demo");
      const listener = buildInviteUrl("demo", "room-password-demo", {
        listenOnly: true,
      });
      assert.match(speaker, /#invite=/);
      assert.doesNotMatch(speaker, /listen=1/);
      assert.match(listener, /listen=1/);
      assert.match(listener, /invite=/);
    } finally {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: original,
      });
    }
  });
});
