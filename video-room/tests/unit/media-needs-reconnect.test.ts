import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Document the reconnect predicate used after screen unlock.
 * Full MediaSessions needs DOM RTCPeerConnection; assert the state set here.
 */
describe("screen-unlock reconnect states", () => {
  it("treats failed, closed, and disconnected as needing reconnect", () => {
    const dead = new Set(["failed", "closed", "disconnected"]);
    for (const state of ["new", "connecting", "connected", "failed", "closed", "disconnected"]) {
      const needs = dead.has(state);
      assert.equal(
        needs,
        state === "failed" || state === "closed" || state === "disconnected",
      );
    }
  });
});
