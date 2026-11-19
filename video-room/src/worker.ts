import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { requestId } from "hono/request-id";
import type { z } from "zod";

import {
  assertSameOrigin,
  authenticateRequest,
  RequestError,
  type AuthEnv,
  type AuthenticatedPrincipal,
} from "./server/auth";
import { errorResponse, jsonResponse, rpcResponse } from "./server/http";
import type { RealtimeEnv } from "./server/realtime";
import { type RoomRpcContext, VideoRoom } from "./server/video-room";
import { RecordingDO } from "./RecordingDO";
import { RoomDO } from "./RoomDO";
import {
  API_HEADER_MEMBER_TOKEN,
  joinRequestSchema,
  publishRequestSchema,
  reconnectRequestSchema,
  renegotiateRequestSchema,
  roomIdSchema,
  subscribeRequestSchema,
} from "./shared/protocol";

export { RecordingDO, RoomDO, VideoRoom };

type WorkerEnv = Env &
  AuthEnv &
  RealtimeEnv & {
    ROOM_CREATE_SECRET?: string;
    ROOM_PASSWORD_REQUIRED?: string;
  };
type ExtendedWorkerEnv = WorkerEnv & {
  AI?: Ai;
  RECORDINGS?: R2Bucket;
  RECORDING_DO?: DurableObjectNamespace<RecordingDO>;
  ROOM_DO?: DurableObjectNamespace<RoomDO>;
  WORKER_HOSTNAME?: string;
};
type RoomEnv = {
  Bindings: WorkerEnv;
  Variables: {
    requestId: string;
    roomId: string;
    rpc: RoomRpcContext;
    room: DurableObjectStub<VideoRoom>;
  };
};

const MAX_BODY_BYTES = 1_100_000;
const roomRoute = "/:action";
const app = new Hono<RoomEnv>().basePath("/api/rooms/:roomId");

app.use(
  roomRoute,
  requestId({
    // Do not trust a caller's X-Request-Id or mutate WebSocket upgrade headers.
    headerName: "",
    generator: (c) => {
      const ray = c.req.header("cf-ray");
      return ray && /^[\w-]{1,255}$/.test(ray) ? ray : crypto.randomUUID();
    },
  }),
);
app.use(roomRoute, async (c, next) => {
  const roomId = roomIdSchema.safeParse(c.req.param("roomId"));
  if (!roomId.success) {
    throw new RequestError(
      400,
      "room_id_invalid",
      "Room names use lowercase letters, numbers, and hyphens.",
    );
  }
  c.set("roomId", roomId.data);

  if (c.req.method === "GET" && c.req.param("action") === "socket") {
    assertSameOrigin(c.req.raw);
    await checkRoomPassword(
      c.env,
      roomId.data,
      c.req.query("password"),
      false,
    );
    return next();
  }
  if (c.req.method !== "GET") assertSameOrigin(c.req.raw);
  const principal = await authenticateApplicationRequest(c.req.raw, c.env);
  const action = c.req.param("action");
  if (action !== "join" && action !== "create") {
    await checkRoomPassword(
      c.env,
      roomId.data,
      c.req.header("x-room-password"),
      false,
    );
  }
  c.set("rpc", {
    memberToken: c.req.header(API_HEADER_MEMBER_TOKEN) ?? null,
    principal,
    requestId: c.get("requestId"),
  });
  // Preserve the API's explicit methods instead of Hono's automatic GET-to-HEAD fallback.
  if (c.req.method === "HEAD") throw routeNotFound();
  if (c.req.method !== "GET") {
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) throw bodyTooLarge();
    // Hono caches these bytes for JSON decoding. Check actual size even when a
    // Content-Length header is present, including bodies ignored by an operation.
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) throw bodyTooLarge();
  }
  c.set("room", c.env.ROOMS.getByName(roomId.data));
  await next();
});

app.get("/socket", (c) => {
  const headers = new Headers({
    upgrade: "websocket",
    "x-request-id": c.get("requestId"),
  });
  const protocol = c.req.header("sec-websocket-protocol");
  if (protocol) headers.set("sec-websocket-protocol", protocol);
  return c.env.ROOMS.getByName(c.get("roomId")).fetch(
    "https://video-room.internal/socket",
    { headers },
  );
});

app.post("/create", async (c) => {
  await checkRoomPassword(
    c.env,
    c.get("roomId"),
    c.req.header("x-room-password"),
    true,
    c.req.header("x-room-create-secret"),
    c.get("rpc").principal.subject,
  );
  return jsonResponse({ ok: true as const }, 200, c.get("requestId"));
});
app.post("/join", jsonRequest(joinRequestSchema, withDisplayHint), async (c) => {
  await checkRoomPassword(
    c.env,
    c.get("roomId"),
    c.req.header("x-room-password"),
    false,
  );
  return rpcResponse(
    await c.get("room").join(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
    201,
  );
});
app.post(
  "/reconnect",
  jsonRequest(reconnectRequestSchema, withDisplayHint),
  async (c) =>
    rpcResponse(
      await c.get("room").reconnect(c.get("rpc"), c.req.valid("json")),
      c.get("requestId"),
    ),
);
app.post("/publish", jsonRequest(publishRequestSchema), async (c) =>
  rpcResponse(
    await c.get("room").publish(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
  ),
);
app.post("/subscribe", jsonRequest(subscribeRequestSchema), async (c) =>
  rpcResponse(
    await c.get("room").subscribe(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
  ),
);
app.post("/renegotiate", jsonRequest(renegotiateRequestSchema), async (c) =>
  rpcResponse(
    await c.get("room").renegotiate(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
  ),
);
app.get("/snapshot", async (c) =>
  rpcResponse(
    await c.get("room").getSnapshot(c.get("rpc")),
    c.get("requestId"),
  ),
);
app.post("/heartbeat", async (c) =>
  rpcResponse(await c.get("room").heartbeat(c.get("rpc")), c.get("requestId")),
);
app.post("/socket-ticket", async (c) =>
  rpcResponse(
    await c.get("room").issueSocketTicket(c.get("rpc")),
    c.get("requestId"),
  ),
);
app.post("/leave", async (c) =>
  rpcResponse(await c.get("room").leave(c.get("rpc")), c.get("requestId")),
);
app.post("/terminate", async (c) =>
  rpcResponse(await c.get("room").terminate(c.get("rpc")), c.get("requestId")),
);
app.all(roomRoute, () => {
  throw routeNotFound();
});
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) =>
  errorResponse(error, c.get("requestId") ?? crypto.randomUUID()),
);

type RootEnv = { Bindings: ExtendedWorkerEnv };
const worker = new Hono<RootEnv>();
worker.all("*", async (c) => {
  const response = await handleExtendedRoute(c.req.raw, c.env);
  if (response) return response;
  return app.fetch(c.req.raw, c.env);
});
worker.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
worker.onError((error) => errorResponse(error, crypto.randomUUID()));

export default worker;

async function handleExtendedRoute(
  request: Request,
  env: ExtendedWorkerEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const roomBinding = () => {
    if (!env.ROOM_DO) {
      throw new RequestError(503, "room_binding_missing", "Room services are not configured.");
    }
    return env.ROOM_DO.getByName(validRoom(url.searchParams.get("room")));
  };
  const recordingBinding = () => {
    if (!env.RECORDING_DO) {
      throw new RequestError(503, "recording_binding_missing", "Recording services are not configured.");
    }
    return env.RECORDING_DO.getByName(validRoom(url.searchParams.get("room")));
  };

  if (url.pathname === "/ws/room" && request.method === "GET") {
    assertSameOrigin(request);
    const principal = await authenticateWebSocket(request, env);
    const room = validRoom(url.searchParams.get("room"));
    await checkRoomPassword(
      env,
      room,
      url.searchParams.get("password"),
      false,
    );
    return roomBinding().fetch(
      new Request("https://room.internal/socket", {
        headers: {
          upgrade: "websocket",
          "x-room-subject": principal.subject,
        },
      }),
    );
  }

  if (url.pathname === "/ws/recording" && request.method === "GET") {
    assertSameOrigin(request);
    const principal = await authenticateWebSocket(request, env);
    const room = validRoom(url.searchParams.get("room"));
    await checkRoomPassword(
      env,
      room,
      url.searchParams.get("password"),
      false,
    );
    await authorizeRoom(env, room, principal.subject, "member");
    return recordingBinding().fetch(
      new Request("https://recording.internal/socket", {
        headers: { upgrade: "websocket", "x-room-id": room },
      }),
    );
  }

  if (url.pathname === "/api/recording/pcm" && request.method === "GET") {
    const room = validRoom(url.searchParams.get("room"));
    return recordingBinding().fetch(
      new Request(
        `https://recording.internal/pcm?sessionId=${encodeURIComponent(url.searchParams.get("sessionId") ?? "")}&trackName=${encodeURIComponent(url.searchParams.get("trackName") ?? "")}`,
        request,
      ),
    );
  }

  if (url.pathname === "/api/recording/status" && request.method === "GET") {
    const room = validRoom(url.searchParams.get("room"));
    await authorizeRecordingAccess(request, env, room, url);
    return recordingBinding().fetch("https://recording.internal/status");
  }

  if (
    url.pathname === "/api/recording/finalize" &&
    request.method === "POST"
  ) {
    assertSameOrigin(request);
    const room = validRoom(url.searchParams.get("room"));
    // Room password is enough to stop recording (cuts SFU adapter egress).
    await authorizeRecordingAccess(request, env, room, url);
    return recordingBinding().fetch(
      new Request("https://recording.internal/finalize", { method: "POST" }),
    );
  }

  if (url.pathname === "/recording" && request.method === "GET") {
    const room = validRoom(url.searchParams.get("room"));
    await authorizeRecordingAccess(request, env, room, url);
    return recordingBinding().fetch("https://recording.internal/download/audio");
  }

  if (url.pathname === "/api/admin/purge-all" && request.method === "POST") {
    assertSameOrigin(request);
    return purgeAllRoomsAndRecordings(request, env);
  }

  return undefined;
}

async function purgeAllRoomsAndRecordings(
  request: Request,
  env: ExtendedWorkerEnv,
): Promise<Response> {
  const expected = env.ROOM_CREATE_SECRET?.trim() ?? "";
  const provided = (request.headers.get("x-room-create-secret") ?? "").trim();
  if (!expected || !provided || !constantTimeEqual(expected, provided)) {
    throw new RequestError(
      403,
      "room_create_forbidden",
      "Purging rooms requires the host create key.",
    );
  }
  if (!env.RECORDINGS || !env.ROOM_DO || !env.RECORDING_DO || !env.ROOMS) {
    throw new RequestError(
      503,
      "purge_unavailable",
      "Room or recording storage is not configured.",
    );
  }

  let bodyRooms: string[] = [];
  try {
    const body = (await request.json()) as { rooms?: unknown };
    if (Array.isArray(body.rooms)) {
      bodyRooms = body.rooms.filter(
        (item): item is string => typeof item === "string",
      );
    }
  } catch {
    // Empty body is fine — discover rooms from R2.
  }

  const roomIds = new Set<string>();
  for (const raw of bodyRooms) {
    const parsed = roomIdSchema.safeParse(raw.trim().toLowerCase());
    if (parsed.success) roomIds.add(parsed.data);
  }

  // Empty the bound recordings bucket completely. Keep looping until the list
  // is empty or we hit a wall-clock budget (Worker CPU/time limits used to
  // stop early and leave large PCM dumps behind).
  const deleteStarted = Date.now();
  const DELETE_BUDGET_MS = 20_000;
  let deletedObjects = 0;
  let remainingObjects = 0;
  let bucketClear = false;
  for (;;) {
    let cursor: string | undefined;
    let batchDeleted = 0;
    do {
      const listed = await env.RECORDINGS.list({ cursor, limit: 1000 });
      for (const object of listed.objects) {
        const room = object.key.split("/")[0];
        const parsed = roomIdSchema.safeParse(room);
        if (parsed.success) roomIds.add(parsed.data);
      }
      if (listed.objects.length > 0) {
        await env.RECORDINGS.delete(listed.objects.map((object) => object.key));
        deletedObjects += listed.objects.length;
        batchDeleted += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
      if (Date.now() - deleteStarted > DELETE_BUDGET_MS) break;
    } while (cursor);

    const check = await env.RECORDINGS.list({ limit: 1 });
    remainingObjects = check.objects.length;
    bucketClear = remainingObjects === 0 && !check.truncated;
    if (bucketClear || batchDeleted === 0 || Date.now() - deleteStarted > DELETE_BUDGET_MS) {
      break;
    }
  }

  const purgedRooms: string[] = [];
  const failures: Array<{ room: string; error: string }> = [];
  for (const room of roomIds) {
    try {
      await Promise.all([
        env.ROOM_DO.getByName(room).fetch(
          new Request("https://room.internal/purge", { method: "POST" }),
        ),
        env.RECORDING_DO.getByName(room).fetch(
          new Request("https://recording.internal/purge", { method: "POST" }),
        ),
        env.ROOMS.getByName(room).fetch(
          new Request("https://video-room.internal/purge", { method: "POST" }),
        ),
      ]);
      purgedRooms.push(room);
    } catch (error) {
      failures.push({
        room,
        error: error instanceof Error ? error.message : "purge failed",
      });
    }
  }

  return jsonResponse(
    {
      bucketClear,
      deletedObjects,
      failures,
      ok: true as const,
      purgedRooms,
      remainingObjects,
    },
    200,
    crypto.randomUUID(),
  );
}

/** Password is enough after leave; guest ACL is only for passwordless rooms. */
async function authorizeRecordingAccess(
  request: Request,
  env: ExtendedWorkerEnv,
  room: string,
  url: URL,
): Promise<void> {
  const password =
    request.headers.get("x-room-password") ?? url.searchParams.get("password");
  if (env.ROOM_PASSWORD_REQUIRED === "true") {
    await checkRoomPassword(env, room, password, false);
    return;
  }
  const principal = await authenticateApplicationRequest(request, env);
  await authorizeRoom(env, room, principal.subject, "download");
}

async function authenticateWebSocket(
  request: Request,
  env: ExtendedWorkerEnv,
): Promise<AuthenticatedPrincipal> {
  const url = new URL(request.url);
  if (env.AUTH_MODE === "skip") {
    return guestPrincipal(url.searchParams.get("guest"));
  }
  const identity = url.searchParams.get("identity");
  if (
    env.AUTH_MODE === "local" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]") &&
    identity
  ) {
    const headers = new Headers(request.headers);
    headers.set("x-video-room-local-identity", identity);
    return authenticateApplicationRequest(new Request(request, { headers }), env);
  }
  return authenticateApplicationRequest(request, env);
}

function authenticateApplicationRequest(
  request: Request,
  env: ExtendedWorkerEnv,
): Promise<AuthenticatedPrincipal> {
  if (env.AUTH_MODE !== "skip") return authenticateRequest(request, env);
  return Promise.resolve(guestPrincipal(request.headers.get("x-room-guest-id")));
}

function guestPrincipal(value: string | null): AuthenticatedPrincipal {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new RequestError(
      401,
      "guest_identity_required",
      "Refresh the page and enter the room password to join.",
    );
  }
  return { displayHint: "Guest", subject: `guest:${value.toLowerCase()}` };
}

async function authorizeRoom(
  env: ExtendedWorkerEnv,
  room: string,
  subject: string,
  role: "admin" | "member" | "download",
): Promise<void> {
  if (!env.ROOM_DO) {
    throw new RequestError(503, "room_binding_missing", "Room services are not configured.");
  }
  const response = await env.ROOM_DO.getByName(room).fetch(
    new Request(`https://room.internal/authorize-${role}`, {
      method: "POST",
      headers: { "x-room-subject": subject },
    }),
  );
  if (!response.ok) {
    throw new RequestError(
      response.status,
      "room_authorization_failed",
      role === "admin"
        ? "Room admin permission is required."
        : role === "download"
          ? "Only a previous room participant can download these files."
          : "Join the room first.",
    );
  }
}

function validRoom(value: string | null): string {
  const parsed = roomIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new RequestError(400, "room_id_invalid", "Room names use lowercase letters, numbers, and hyphens.");
  }
  return parsed.data;
}

async function checkRoomPassword(
  env: ExtendedWorkerEnv,
  roomId: string,
  password: string | null | undefined,
  create: boolean,
  createSecret?: string | null,
  creatorSubject?: string | null,
): Promise<void> {
  if (env.ROOM_PASSWORD_REQUIRED !== "true") return;
  if (create) {
    const expected = env.ROOM_CREATE_SECRET?.trim() ?? "";
    const provided =
      typeof createSecret === "string" ? createSecret.trim() : "";
    if (!expected || !provided || !constantTimeEqual(expected, provided)) {
      throw new RequestError(
        403,
        "room_create_forbidden",
        "Creating a room requires the host create key.",
      );
    }
  }
  if (!env.ROOM_DO) {
    throw new RequestError(503, "room_password_unavailable", "Room password protection is not configured.");
  }
  const response = await env.ROOM_DO.getByName(roomId).fetch(
    "https://room.internal/password",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: password ?? "",
        create,
        ...(create && creatorSubject ? { creatorSubject } : {}),
      }),
    },
  );
  if (response.ok) return;
  if (response.status === 409) {
    throw new RequestError(
      409,
      "room_password_not_initialized",
      "This room has not been created yet.",
    );
  }
  if (response.status === 400) {
    throw new RequestError(400, "room_password_invalid", "Room password must be between 8 and 128 characters.");
  }
  throw new RequestError(401, "room_password_incorrect", "The room password is incorrect.");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function jsonRequest<S extends z.ZodType<Record<string, unknown>>>(
  schema: S,
  normalize: (value: unknown, c: Context<RoomEnv>) => unknown = (value) =>
    value,
) {
  return createMiddleware<RoomEnv, string, { out: { json: z.output<S> } }>(
    async (c, next) => {
      let value: unknown;
      try {
        // Decode once, including clients that omit Content-Type. The standard
        // JSON validator skips those bodies; this API has always accepted them.
        value = await c.req.json();
      } catch {
        throw new RequestError(
          400,
          "json_invalid",
          "Send a valid JSON request.",
        );
      }
      const parsed = schema.safeParse(normalize(value, c));
      if (!parsed.success) throw invalidRequest(parsed.error, c.req.path);
      c.req.addValidatedData("json", parsed.data);
      await next();
    },
  );
}

function withDisplayHint(value: unknown, c: Context<RoomEnv>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return {
    ...body,
    displayName: body.displayName ?? c.get("rpc").principal.displayHint,
  };
}

function invalidRequest(error: z.ZodError, path: string): RequestError {
  const issue = error.issues[0];
  const field = issue?.path[0];
  if (field === undefined)
    return new RequestError(400, "body_invalid", "Send a JSON object.");
  if (field === "generation")
    return new RequestError(
      400,
      "generation_invalid",
      "A positive media generation is required.",
    );
  if (field === "sessionDescription") {
    return path.endsWith("/publish")
      ? new RequestError(
          400,
          "offer_invalid",
          "Publishing requires a valid SDP offer.",
        )
      : new RequestError(
          400,
          "answer_invalid",
          "Renegotiation requires a valid SDP answer.",
        );
  }
  if (field === "tracks" && issue?.path[2] !== "mid") {
    return new RequestError(
      400,
      "publish_tracks_invalid",
      "Publish one audio track, one video track, or both.",
    );
  }
  if (field === "trackKeys" && issue?.path.length === 1) {
    return new RequestError(400, "body_invalid", "trackKeys must be an array.");
  }
  return new RequestError(
    400,
    "input_invalid",
    "A request field is missing or invalid.",
  );
}

function bodyTooLarge(): RequestError {
  return new RequestError(
    413,
    "body_too_large",
    "The request body is too large.",
  );
}

function routeNotFound(): RequestError {
  return new RequestError(
    404,
    "route_not_found",
    "The room operation does not exist.",
  );
}
