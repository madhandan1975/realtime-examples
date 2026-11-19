/**
 * Strict Mute All proof (RoomDO path).
 * Cases:
 *   A — both joined, then mute-all
 *   B — mute-all before guest join (late joiner latch)
 *   C — host join+mute-all back-to-back
 *   D — guest unmute rejected while forceMuted
 *
 * Usage: SMOKE_BASE=http://127.0.0.1:8787 node scripts/smoke-mute-all.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devVars = Object.fromEntries(
  readFileSync(resolve(root, ".dev.vars"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const PASSWORD = "smoke-test-password-123";
const CREATE_SECRET = devVars.ROOM_CREATE_SECRET;

function waitFor(ws, predicate, label, ms = 8_000) {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${label}`));
    }, ms);
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      cleanup();
      resolveWait(msg);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    };
    ws.addEventListener("message", onMessage);
  });
}

function openRoomSocket(room, guestId) {
  const url = new URL("/ws/room", BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", room);
  url.searchParams.set("password", PASSWORD);
  url.searchParams.set("guest", guestId);
  return new Promise((resolveOpen, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolveOpen(ws));
    ws.addEventListener("error", () =>
      reject(new Error(`WS failed for ${guestId}`)),
    );
  });
}

async function createRoom(room, hostGuest) {
  const create = await fetch(`${BASE}/api/rooms/${room}/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      "x-room-password": PASSWORD,
      "x-room-create-secret": CREATE_SECRET,
      "x-room-guest-id": hostGuest,
    },
  });
  if (!create.ok) {
    throw new Error(`Create failed: ${create.status} ${await create.text()}`);
  }
}

function selfForceMuted(state, selfId) {
  const self = (state.participants ?? []).find((p) => p.id === selfId);
  return Boolean(self?.forceMuted && self?.muted);
}

async function caseA() {
  const ROOM = `mute-a-${Date.now().toString(36)}`;
  const hostGuest = randomUUID();
  const guestGuest = randomUUID();
  await createRoom(ROOM, hostGuest);
  const host = await openRoomSocket(ROOM, hostGuest);
  const guest = await openRoomSocket(ROOM, guestGuest);

  const guestMute = waitFor(
    guest,
    (msg) => msg.type === "force-mute" || msg.type === "mute-all",
    "A guest mute",
  );
  const hostOk = waitFor(host, (msg) => msg.type === "mute-all-ok", "A mute-all-ok");

  host.send(JSON.stringify({ type: "join", displayName: "Host", claimHost: true }));
  guest.send(JSON.stringify({ type: "join", displayName: "Guest" }));
  await waitFor(host, (msg) => msg.type === "room-state", "A host state");
  await waitFor(guest, (msg) => msg.type === "room-state", "A guest state");

  host.send(JSON.stringify({ type: "mute-all", claimHost: true }));
  const [ok] = await Promise.all([hostOk, guestMute]);
  if (typeof ok.count !== "number" || ok.count < 1) {
    throw new Error(`A: bad count ${JSON.stringify(ok)}`);
  }
  const guestState = await waitFor(
    guest,
    (msg) =>
      msg.type === "room-state" &&
      selfForceMuted(msg, msg.selfId),
    "A guest forceMuted room-state",
  );
  host.close();
  guest.close();
  return { case: "A", mutedCount: ok.count, guestForceMuted: true, selfId: guestState.selfId };
}

async function caseB() {
  const ROOM = `mute-b-${Date.now().toString(36)}`;
  const hostGuest = randomUUID();
  const guestGuest = randomUUID();
  await createRoom(ROOM, hostGuest);
  const host = await openRoomSocket(ROOM, hostGuest);
  const guest = await openRoomSocket(ROOM, guestGuest);

  host.send(JSON.stringify({ type: "join", displayName: "Host", claimHost: true }));
  await waitFor(host, (msg) => msg.type === "room-state", "B host state");

  const guestForce = waitFor(
    guest,
    (msg) =>
      (msg.type === "room-state" && selfForceMuted(msg, msg.selfId)) ||
      msg.type === "force-mute" ||
      msg.type === "mute-all",
    "B late guest muted",
  );
  host.send(JSON.stringify({ type: "mute-all", claimHost: true }));
  await waitFor(host, (msg) => msg.type === "mute-all-ok", "B mute-all-ok");
  // Guest joins AFTER mute-all — must latch forceMuted.
  guest.send(JSON.stringify({ type: "join", displayName: "Guest" }));
  await guestForce;
  host.close();
  guest.close();
  return { case: "B", lateJoinerForceMuted: true };
}

async function caseC() {
  const ROOM = `mute-c-${Date.now().toString(36)}`;
  const hostGuest = randomUUID();
  const guestGuest = randomUUID();
  await createRoom(ROOM, hostGuest);
  const host = await openRoomSocket(ROOM, hostGuest);
  const guest = await openRoomSocket(ROOM, guestGuest);

  const guestMute = waitFor(
    guest,
    (msg) => msg.type === "force-mute" || msg.type === "mute-all",
    "C guest mute",
  );
  const hostOk = waitFor(host, (msg) => msg.type === "mute-all-ok", "C mute-all-ok");

  guest.send(JSON.stringify({ type: "join", displayName: "Guest" }));
  host.send(JSON.stringify({ type: "join", displayName: "Host", claimHost: true }));
  host.send(JSON.stringify({ type: "mute-all", claimHost: true }));

  const [ok] = await Promise.all([hostOk, guestMute]);
  if (typeof ok.count !== "number" || ok.count < 1) {
    throw new Error(`C: bad count ${JSON.stringify(ok)}`);
  }
  host.close();
  guest.close();
  return { case: "C", mutedCount: ok.count };
}

async function caseD() {
  const ROOM = `mute-d-${Date.now().toString(36)}`;
  const hostGuest = randomUUID();
  const guestGuest = randomUUID();
  await createRoom(ROOM, hostGuest);
  const host = await openRoomSocket(ROOM, hostGuest);
  const guest = await openRoomSocket(ROOM, guestGuest);

  host.send(JSON.stringify({ type: "join", displayName: "Host", claimHost: true }));
  guest.send(JSON.stringify({ type: "join", displayName: "Guest" }));
  await waitFor(host, (msg) => msg.type === "room-state", "D host state");
  await waitFor(guest, (msg) => msg.type === "room-state", "D guest state");

  const guestMute = waitFor(
    guest,
    (msg) => msg.type === "force-mute" || msg.type === "mute-all",
    "D guest mute",
  );
  const hostOk = waitFor(host, (msg) => msg.type === "mute-all-ok", "D mute-all-ok");
  host.send(JSON.stringify({ type: "mute-all", claimHost: true }));
  await Promise.all([hostOk, guestMute]);

  const corrective = waitFor(
    guest,
    (msg) =>
      (msg.type === "mute-status" &&
        msg.muted === true &&
        msg.forceMuted === true) ||
      msg.type === "force-mute",
    "D corrective mute",
  );
  guest.send(JSON.stringify({ type: "mute-status", muted: false }));
  await corrective;
  host.close();
  guest.close();
  return { case: "D", unmuteRejected: true };
}

async function main() {
  const results = [];
  results.push(await caseA());
  results.push(await caseB());
  results.push(await caseC());
  results.push(await caseD());
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
