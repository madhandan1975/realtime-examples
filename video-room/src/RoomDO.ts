import { DurableObject } from "cloudflare:workers";

type Role = "admin" | "participant";
type Participant = {
  disconnectedAt?: number;
  displayName: string;
  handRaised: boolean;
  id: string;
  joinedAt: number;
  media?: { sessionId: string; trackName: string };
  muted: boolean;
  role: Role;
  sessions: Record<string, "publisher" | "subscriber">;
  speaking: boolean;
  subject: string;
};
type RoomState = {
  knownSubjects: string[];
  participants: Participant[];
  ended: boolean;
  passwordSalt?: string;
  passwordHash?: string;
};
type SocketAttachment = {
  id: string;
  subject: string;
};

const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,47}$/u;
const REACTIONS = new Set(["👍", "❤️", "👏", "🔥"]);
const RECONNECT_GRACE_MS = 30_000;

export class RoomDO extends DurableObject {
  private state: RoomState = { knownSubjects: [], participants: [], ended: false };
  private ready: Promise<void>;
  private mutations = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state =
        (await ctx.storage.get<RoomState>("room")) ??
        { knownSubjects: [], participants: [], ended: false };
      this.state.knownSubjects ??= this.state.participants.map((item) => item.subject);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/socket" && request.method === "GET") {
      return this.openSocket(request);
    }
    if (url.pathname === "/password" && request.method === "POST") {
      return this.setOrVerifyPassword(request);
    }
    if (url.pathname === "/register-session" && request.method === "POST") {
      return this.registerSession(request);
    }
    if (url.pathname === "/authorize-session" && request.method === "POST") {
      return this.authorizeSession(request);
    }
    if (url.pathname === "/authorize-member" && request.method === "POST") {
      return this.authorizeMember(request);
    }
    if (url.pathname === "/authorize-download" && request.method === "POST") {
      return this.authorizeDownload(request);
    }
    if (url.pathname === "/authorize-admin" && request.method === "POST") {
      return this.authorizeAdmin(request);
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.serial(async () => {
      const now = Date.now();
      const before = this.state.participants.length;
      this.state.participants = this.state.participants.filter((participant) => {
        if (!participant.disconnectedAt) return true;
        return now - participant.disconnectedAt < RECONNECT_GRACE_MS;
      });
      if (this.state.participants.length !== before) {
        if (
          !this.state.participants.some((item) => item.role === "admin") &&
          this.state.participants.length > 0
        ) {
          this.promoteNextAdmin();
        }
        await this.persist();
        this.broadcastState();
      }
      const nextExpiry = this.state.participants
        .map((item) => item.disconnectedAt)
        .filter((value): value is number => typeof value === "number")
        .map((value) => value + RECONNECT_GRACE_MS)
        .sort((a, b) => a - b)[0];
      if (nextExpiry) await this.ctx.storage.setAlarm(nextExpiry);
    });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    await this.ready;
    await this.serial(async () => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) return socket.close(1008, "Join the room first.");
      let message: unknown;
      try {
        const text =
          typeof data === "string"
            ? data
            : new TextDecoder().decode(data);
        if (text.length > 8_192) throw new Error("Message too large.");
        message = JSON.parse(text);
      } catch {
        socket.close(1003, "Invalid room message.");
        return;
      }
      if (!isRecord(message) || typeof message.type !== "string") return;

      const participant = this.state.participants.find(
        (item) => item.id === attachment.id,
      );
      if (message.type === "join") {
        if (this.state.ended) {
          socket.close(1008, "The room cannot be joined.");
          return;
        }
        const displayName =
          typeof message.displayName === "string" &&
          DISPLAY_NAME.test(message.displayName.trim())
            ? message.displayName.trim()
            : "Guest";

        if (participant) {
          participant.displayName = displayName;
          participant.disconnectedAt = undefined;
          socket.serializeAttachment(attachment);
          await this.persist();
          this.broadcastState();
          return;
        }

        const joined: Participant = {
          displayName,
          handRaised: false,
          id: attachment.id,
          joinedAt: Date.now(),
          muted: false,
          role: this.state.participants.some((item) => item.role === "admin")
            ? "participant"
            : "admin",
          sessions: {},
          speaking: false,
          subject: attachment.subject,
        };
        this.state.participants.push(joined);
        if (!this.state.knownSubjects.includes(attachment.subject)) {
          this.state.knownSubjects.push(attachment.subject);
        }
        socket.serializeAttachment(attachment);
        await this.persist();
        this.broadcast({ type: "chime", sound: "join" });
        this.broadcastState();
        return;
      }
      if (!participant) {
        socket.close(1008, "Join the room first.");
        return;
      }
      if (this.state.ended) return;
      participant.disconnectedAt = undefined;

      switch (message.type) {
        case "ping":
          this.sendTo(participant.id, { type: "pong", at: Date.now() });
          break;
        case "mute-status":
          if (typeof message.muted !== "boolean") return;
          participant.muted = message.muted;
          this.broadcast({
            muted: participant.muted,
            participantId: participant.id,
            type: "mute-status",
          });
          break;
        case "hand":
          if (typeof message.raised !== "boolean") return;
          participant.handRaised = message.raised;
          this.broadcast({
            participantId: participant.id,
            raised: participant.handRaised,
            type: "hand",
          });
          break;
        case "speaking":
          if (typeof message.speaking !== "boolean") return;
          participant.speaking = message.speaking && !participant.muted;
          this.broadcast({
            participantId: participant.id,
            speaking: participant.speaking,
            type: "speaking",
          });
          break;
        case "reaction":
          if (typeof message.emoji !== "string" || !REACTIONS.has(message.emoji)) return;
          this.broadcast({
            emoji: message.emoji,
            participantId: participant.id,
            type: "reaction",
          });
          break;
        case "media":
          if (
            typeof message.sessionId !== "string" ||
            typeof message.trackName !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(message.sessionId) ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(message.trackName)
          ) return;
          participant.media = {
            sessionId: message.sessionId,
            trackName: message.trackName,
          };
          await this.persist();
          this.broadcastState();
          break;
        case "force-mute":
        case "force-unmute":
          if (!this.isAdmin(participant)) return;
          this.setForcedMute(message.participantId, message.type === "force-mute");
          break;
        case "kick":
          if (!this.isAdmin(participant) || typeof message.participantId !== "string") return;
          if (message.participantId === participant.id) return;
          this.kick(message.participantId);
          break;
        case "transfer-admin":
          if (!this.isAdmin(participant) || typeof message.participantId !== "string") return;
          this.transferAdmin(participant, message.participantId);
          break;
        case "end-call":
          if (!this.isAdmin(participant)) return;
          this.state.ended = true;
          await this.persist();
          this.broadcast({ type: "end-call" });
          for (const client of this.ctx.getWebSockets()) {
            client.close(1000, "Call ended.");
          }
          break;
      }
      await this.persist();
      this.broadcastState();
    });
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.ready;
    await this.serial(async () => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) return;
      const participant = this.state.participants.find(
        (item) => item.id === attachment.id,
      );
      if (!participant) return;
      // Keep membership briefly so brief network blips can reconnect.
      participant.disconnectedAt = Date.now();
      participant.speaking = false;
      await this.persist();
      this.broadcastState();
      await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    });
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Room socket error.");
  }

  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const subject = request.headers.get("x-room-subject");
    if (!subject) return new Response("Unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = await stableParticipantId(subject);
    const existing = this.state.participants.find((item) => item.subject === subject);
    const attachment = { id: existing?.id ?? id, subject };
    // Replace any prior socket for this participant.
    for (const socket of this.ctx.getWebSockets()) {
      const current = socket.deserializeAttachment() as SocketAttachment | null;
      if (current?.id === attachment.id) socket.close(4000, "Replaced by reconnect.");
    }
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async setOrVerifyPassword(request: Request): Promise<Response> {
    let body: { password?: unknown; create?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response("A room password is required.", { status: 400 });
    }
    if (typeof body.password !== "string" || body.password.length > 128) {
      return new Response("A valid room password is required.", { status: 400 });
    }
    const password = body.password;

    return this.serial(async () => {
      if (!this.state.passwordHash) {
        if (body.create !== true) {
          return new Response("This room has no password yet.", { status: 409 });
        }
        if (password.length < 8) {
          return new Response("Room passwords must be at least 8 characters.", { status: 400 });
        }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        this.state.passwordSalt = bytesToHex(salt);
        this.state.passwordHash = await hashPassword(this.state.passwordSalt, password);
        await this.persist();
        return new Response(null, { status: 204 });
      }

      if (!password || !this.state.passwordSalt) {
        return new Response("Room password is incorrect.", { status: 401 });
      }
      const suppliedHash = await hashPassword(this.state.passwordSalt, password);
      if (!constantTimeEqual(suppliedHash, this.state.passwordHash)) {
        return new Response("Room password is incorrect.", { status: 401 });
      }
      return new Response(null, { status: 204 });
    });
  }

  private async registerSession(request: Request): Promise<Response> {
    const body = await request.json<{
      kind?: unknown;
      sessionId?: unknown;
      subject?: unknown;
    }>();
    const subject = trustedSubject(request);
    if (
      !subject ||
      subject !== body.subject ||
      (body.kind !== "publisher" && body.kind !== "subscriber") ||
      typeof body.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId)
    ) return new Response("Invalid session registration", { status: 400 });
    const participant = this.state.participants.find((item) => item.subject === subject);
    if (!participant) return new Response("Join the room first", { status: 403 });
    participant.sessions[body.sessionId] = body.kind;
    await this.persist();
    return Response.json({ ok: true });
  }

  private async authorizeSession(request: Request): Promise<Response> {
    const subject = trustedSubject(request);
    if (!subject) return new Response("Unauthorized", { status: 401 });
    const body = await request.json<{ remoteSessionId?: unknown; sessionId?: unknown }>();
    const owner = this.state.participants.find((item) => item.subject === subject);
    const ownKind =
      owner && typeof body.sessionId === "string"
        ? owner.sessions[body.sessionId]
        : undefined;
    if (!ownKind) return new Response("Forbidden", { status: 403 });
    if (body.remoteSessionId !== undefined) {
      const isPublishedByActiveMember = this.state.participants.some(
        (item) =>
          item.sessions[String(body.remoteSessionId)] === "publisher" &&
          item.id !== owner?.id,
      );
      if (!isPublishedByActiveMember) return new Response("Forbidden", { status: 403 });
    }
    return Response.json({ ok: true });
  }

  private async authorizeMember(request: Request): Promise<Response> {
    const subject = trustedSubject(request);
    if (!subject || !this.state.participants.some((item) => item.subject === subject)) {
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json({ ok: true });
  }

  private async authorizeDownload(request: Request): Promise<Response> {
    const subject = trustedSubject(request);
    if (!subject || !this.state.knownSubjects.includes(subject)) {
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json({ ok: true });
  }

  private async authorizeAdmin(request: Request): Promise<Response> {
    const subject = trustedSubject(request);
    if (!subject || !this.state.participants.some(
      (item) => item.subject === subject && item.role === "admin",
    )) return new Response("Forbidden", { status: 403 });
    return Response.json({ ok: true });
  }

  private setForcedMute(id: unknown, muted: boolean): void {
    if (typeof id !== "string") return;
    const participant = this.state.participants.find((item) => item.id === id);
    if (!participant) return;
    participant.muted = muted;
    participant.speaking = false;
    this.sendTo(id, { muted, type: muted ? "force-mute" : "force-unmute" });
    this.broadcast({
      muted,
      participantId: id,
      type: "mute-status",
    });
  }

  private kick(id: string): void {
    const participant = this.state.participants.find((item) => item.id === id);
    if (!participant || participant.role === "admin") return;
    this.sendTo(id, { type: "kicked" });
    const socket = this.socketFor(id);
    if (socket) socket.close(4001, "Removed from the room.");
    this.state.participants = this.state.participants.filter((item) => item.id !== id);
    this.broadcast({ participantId: id, type: "chime", sound: "leave" });
  }

  private transferAdmin(current: Participant, id: string): void {
    const target = this.state.participants.find((item) => item.id === id);
    if (!target) return;
    current.role = "participant";
    target.role = "admin";
  }

  private promoteNextAdmin(): void {
    const next = this.state.participants
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) next.role = "admin";
  }

  private isAdmin(participant: Participant): boolean {
    return participant.role === "admin";
  }

  private socketFor(id: string): WebSocket | undefined {
    return this.ctx.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment?.id === id;
    });
  }

  private sendTo(id: string, message: unknown): void {
    const socket = this.socketFor(id);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private broadcast(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(serialized);
    }
  }

  private broadcastState(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      socket.send(JSON.stringify({
        adminId: this.state.participants.find((item) => item.role === "admin")?.id ?? null,
        participants: this.state.participants.map(publicParticipant),
        selfId: attachment.id,
        type: "room-state",
      }));
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("room", this.state);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation, operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }
}

function publicParticipant(participant: Participant) {
  return {
    disconnected: Boolean(participant.disconnectedAt),
    displayName: participant.displayName,
    handRaised: participant.handRaised,
    id: participant.id,
    media: participant.media,
    muted: participant.muted,
    role: participant.role,
    speaking: participant.speaking,
  };
}

function trustedSubject(request: Request): string | undefined {
  return request.headers.get("x-room-subject") ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function stableParticipantId(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject),
  );
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

async function hashPassword(salt: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
