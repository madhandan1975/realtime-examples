import { DurableObject } from "cloudflare:workers";

type Role = "admin" | "participant";
type Participant = {
  disconnectedAt?: number;
  displayName: string;
  forceMuted: boolean;
  handRaised: boolean;
  id: string;
  joinedAt: number;
  media?: { sessionId: string; trackName: string };
  /** SFU VideoRoom participant id — correlates mute UI with media tiles. */
  mediaParticipantId?: string;
  muted: boolean;
  role: Role;
  sessions: Record<string, "publisher" | "subscriber">;
  speaking: boolean;
  subject: string;
};
type RoomState = {
  creatorSubject?: string | null;
  /** After Mute all, late joiners start force-muted until host clears the latch. */
  guestsForceMuted?: boolean;
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
      this.state.creatorSubject ??= null;
      this.state.guestsForceMuted ??= false;
      for (const item of this.state.participants) {
        item.forceMuted ??= false;
      }
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
    if (url.pathname === "/purge" && request.method === "POST") {
      return this.purge();
    }
    return new Response("Not found", { status: 404 });
  }

  private async purge(): Promise<Response> {
    return this.serial(async () => {
      for (const socket of [...this.ctx.getWebSockets()]) {
        try {
          socket.close(4003, "Room purged.");
        } catch {
          // Best-effort.
        }
      }
      await this.ctx.storage.deleteAll();
      this.state = {
        creatorSubject: null,
        ended: false,
        guestsForceMuted: false,
        knownSubjects: [],
        participants: [],
      };
      return Response.json({ ok: true });
    });
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.serial(async () => {
      const now = Date.now();
      if (this.state.ended && this.state.participants.length === 0) {
        this.state.ended = false;
        await this.persist();
        return;
      }
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
      else if (this.state.ended && this.state.participants.length === 0) {
        await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
      }
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
        // SFU room creator claims RoomDO sticky host so Mute all / End call authorize.
        const claimHost = message.claimHost === true;
        const latchMuted = Boolean(this.state.guestsForceMuted);
        const mediaParticipantId =
          typeof message.mediaParticipantId === "string" &&
          /^p_[a-z0-9]{8,40}$/i.test(message.mediaParticipantId)
            ? message.mediaParticipantId
            : undefined;

        if (participant) {
          participant.displayName = displayName;
          participant.disconnectedAt = undefined;
          if (mediaParticipantId) {
            participant.mediaParticipantId = mediaParticipantId;
          }
          if (latchMuted && participant.role !== "admin") {
            participant.muted = true;
            participant.forceMuted = true;
            participant.speaking = false;
          }
          if (claimHost) this.claimHost(participant);
          else this.ensureLiveAdmin(participant);
          socket.serializeAttachment(attachment);
          await this.persist();
          this.broadcastState();
          return;
        }

        const joined: Participant = {
          displayName,
          forceMuted: latchMuted,
          handRaised: false,
          id: attachment.id,
          joinedAt: Date.now(),
          mediaParticipantId,
          muted: latchMuted,
          role: "participant",
          sessions: {},
          speaking: false,
          subject: attachment.subject,
        };
        this.state.participants.push(joined);
        if (!this.state.knownSubjects.includes(attachment.subject)) {
          this.state.knownSubjects.push(attachment.subject);
        }
        if (claimHost) {
          this.claimHost(joined);
        } else {
          // First control-plane joiner becomes sticky host when unset.
          if (!this.state.creatorSubject) {
            this.state.creatorSubject = attachment.subject;
          }
          this.ensureLiveAdmin(joined);
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
          // Host force-mute locks the mic — correct the client instead of silent drop.
          if (participant.forceMuted && message.muted === false) {
            this.sendTo(participant.id, {
              forceMuted: true,
              muted: true,
              participantId: participant.id,
              type: "mute-status",
            });
            return;
          }
          participant.muted = message.muted;
          if (!message.muted) participant.forceMuted = false;
          this.broadcast({
            forceMuted: participant.forceMuted,
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
          if (
            !this.authorizeModeration(
              participant,
              message.claimHost === true,
              socket,
            )
          ) {
            this.sendTo(participant.id, {
              code: "moderation_forbidden",
              message: "Only the room host can mute participants.",
              type: "error",
            });
            return;
          }
          if (
            !this.setForcedMute(
              message.participantId,
              message.type === "force-mute",
            )
          ) {
            this.sendTo(participant.id, {
              code: "moderation_invalid",
              message: "That participant is not available to mute.",
              type: "error",
            });
            return;
          }
          if (message.type === "force-unmute") {
            // Per-person unmute does not clear the room latch for late joiners.
          }
          break;
        case "mute-all":
          // claimHost on the action itself — join-time claim was racing SFU creator id.
          if (
            !this.authorizeModeration(
              participant,
              message.claimHost === true,
              socket,
            )
          ) {
            this.sendTo(participant.id, {
              code: "moderation_forbidden",
              message: "Only the room host can mute all.",
              type: "error",
            });
            return;
          }
          {
            this.state.guestsForceMuted = true;
            let mutedCount = 0;
            for (const other of this.state.participants) {
              if (other.id === participant.id) continue;
              other.muted = true;
              other.forceMuted = true;
              other.speaking = false;
              mutedCount += 1;
            }
            // Room-wide event so every connected guest mutes immediately.
            this.broadcast({
              by: participant.id,
              type: "mute-all",
            });
            for (const other of this.state.participants) {
              if (other.id === participant.id) continue;
              this.sendTo(other.id, {
                force: true,
                muted: true,
                type: "force-mute",
              });
            }
            this.sendTo(participant.id, {
              count: mutedCount,
              type: "mute-all-ok",
            });
            await this.persist();
            this.broadcastState();
          }
          break;
        case "unmute-all":
          if (
            !this.authorizeModeration(
              participant,
              message.claimHost === true,
              socket,
            )
          ) {
            this.sendTo(participant.id, {
              code: "moderation_forbidden",
              message: "Only the room host can unmute all.",
              type: "error",
            });
            return;
          }
          {
            this.state.guestsForceMuted = false;
            let unmutedCount = 0;
            for (const other of this.state.participants) {
              if (other.id === participant.id) continue;
              other.forceMuted = false;
              other.muted = false;
              unmutedCount += 1;
              this.sendTo(other.id, {
                force: true,
                muted: false,
                type: "force-unmute",
              });
            }
            this.broadcast({
              by: participant.id,
              type: "unmute-all",
            });
            this.sendTo(participant.id, {
              count: unmutedCount,
              type: "unmute-all-ok",
            });
            await this.persist();
            this.broadcastState();
          }
          break;
        case "kick":
          if (
            !this.authorizeModeration(
              participant,
              message.claimHost === true,
              socket,
            )
          ) {
            this.sendTo(participant.id, {
              code: "moderation_forbidden",
              message: "Only the room host can remove participants.",
              type: "error",
            });
            return;
          }
          if (typeof message.participantId !== "string") {
            this.sendTo(participant.id, {
              code: "moderation_invalid",
              message: "Pick a participant to remove.",
              type: "error",
            });
            return;
          }
          if (message.participantId === participant.id) {
            this.sendTo(participant.id, {
              code: "moderation_invalid",
              message: "You cannot remove yourself.",
              type: "error",
            });
            return;
          }
          if (!this.kick(message.participantId)) {
            this.sendTo(participant.id, {
              code: "moderation_invalid",
              message: "That participant is not available to remove.",
              type: "error",
            });
            return;
          }
          break;
        case "transfer-admin":
          if (!this.canModerate(participant)) {
            this.sendTo(participant.id, {
              code: "moderation_forbidden",
              message: "Only the room host can transfer host controls.",
              type: "error",
            });
            return;
          }
          if (typeof message.participantId !== "string") {
            this.sendTo(participant.id, {
              code: "moderation_invalid",
              message: "Pick a participant to make host.",
              type: "error",
            });
            return;
          }
          if (!this.transferAdmin(participant, message.participantId)) {
            this.sendTo(participant.id, {
              code: "moderation_invalid",
              message: "That participant is not available to make host.",
              type: "error",
            });
            return;
          }
          this.sendTo(participant.id, {
            participantId: message.participantId,
            type: "transfer-admin-ok",
          });
          break;
        case "end-call":
          if (
            !this.authorizeModeration(
              participant,
              message.claimHost === true,
              socket,
            )
          ) {
            this.sendTo(participant.id, {
              code: "moderation_forbidden",
              message: "Only the room host can end the call.",
              type: "error",
            });
            return;
          }
          this.state.guestsForceMuted = false;
          this.state.ended = true;
          this.state.participants = [];
          await this.persist();
          // Deliver end-call before closing so clients leave SFU instead of reconnecting.
          this.broadcast({ type: "end-call" });
          for (const client of [...this.ctx.getWebSockets()]) {
            try {
              client.close(4002, "Call ended.");
            } catch {
              // Best-effort close.
            }
          }
          // Allow the same room URL to be reused after a short tombstone.
          await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
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
      // A replaced socket's late close must not mark the new connection offline.
      const current = this.socketFor(attachment.id);
      if (current && current !== socket) return;
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
    let body: {
      create?: unknown;
      creatorSubject?: unknown;
      password?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return new Response("A room password is required.", { status: 400 });
    }
    if (typeof body.password !== "string" || body.password.length > 128) {
      return new Response("A valid room password is required.", { status: 400 });
    }
    const password = body.password;
    const creatorSubject =
      typeof body.creatorSubject === "string" && body.creatorSubject.length > 0
        ? body.creatorSubject
        : null;

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
        if (creatorSubject) this.state.creatorSubject = creatorSubject;
        await this.persist();
        return new Response(null, { status: 204 });
      }

      // Re-create with the host key re-claims sticky host (same room URL / new browser
      // guest id used to leave creatorSubject pointing at a subject that never rejoins,
      // so Mute all / End call never got an adminId).
      if (body.create === true && creatorSubject) {
        this.state.creatorSubject = creatorSubject;
        this.state.ended = false;
        await this.persist();
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

  private setForcedMute(id: unknown, muted: boolean): boolean {
    if (typeof id !== "string") return false;
    const participant = this.state.participants.find((item) => item.id === id);
    if (!participant) return false;
    participant.muted = muted;
    participant.forceMuted = muted;
    participant.speaking = false;
    this.sendTo(id, {
      force: true,
      muted,
      type: muted ? "force-mute" : "force-unmute",
    });
    this.broadcast({
      forceMuted: participant.forceMuted,
      muted,
      participantId: id,
      type: "mute-status",
    });
    return true;
  }

  private kick(id: string): boolean {
    const participant = this.state.participants.find((item) => item.id === id);
    if (!participant || participant.role === "admin") return false;
    this.sendTo(id, { type: "kicked" });
    const socket = this.socketFor(id);
    if (socket) socket.close(4001, "Removed from the room.");
    this.state.participants = this.state.participants.filter((item) => item.id !== id);
    this.broadcast({ participantId: id, type: "chime", sound: "leave" });
    return true;
  }

  private claimHost(participant: Participant): void {
    this.state.creatorSubject = participant.subject;
    for (const item of this.state.participants) {
      item.role = item.id === participant.id ? "admin" : "participant";
    }
  }

  private transferAdmin(current: Participant, id: string): boolean {
    const target = this.state.participants.find((item) => item.id === id);
    if (!target || target.id === current.id) return false;
    current.role = "participant";
    target.role = "admin";
    // Sticky host must move with Make admin or ensureLiveAdmin undoes the transfer.
    this.state.creatorSubject = target.subject;
    return true;
  }

  private promoteNextAdmin(): void {
    const next = this.state.participants
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next) return;
    next.role = "admin";
    // Grace expired and sticky row is gone — hand sticky host to the stand-in.
    this.state.creatorSubject = next.subject;
  }

  private isLive(participant: Participant, via?: WebSocket): boolean {
    if (via) {
      const attachment = via.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.id === participant.id) return true;
    }
    return !participant.disconnectedAt && Boolean(this.socketFor(participant.id));
  }

  private inReconnectGrace(participant: Participant): boolean {
    return (
      typeof participant.disconnectedAt === "number" &&
      Date.now() - participant.disconnectedAt < RECONNECT_GRACE_MS
    );
  }

  /**
   * Prefer a *live* sticky creator.
   * - If sticky has not joined yet: nobody is admin (do not promote guests).
   * - If sticky is in reconnect grace: optional live stand-in admin, but never
   *   rewrite creatorSubject until the alarm drops the sticky row.
   * - If sticky is live: they are the sole admin.
   */
  private ensureLiveAdmin(preferred?: Participant): void {
    const sticky = this.state.creatorSubject
      ? this.state.participants.find(
          (item) => item.subject === this.state.creatorSubject,
        )
      : undefined;

    if (sticky && this.isLive(sticky)) {
      for (const item of this.state.participants) {
        item.role = item.id === sticky.id ? "admin" : "participant";
      }
      return;
    }

    // Sticky subject not in the room yet — do not crown a guest. UI may still
    // show controls via VideoRoom creator; canModerate stays false until sticky joins.
    if (this.state.creatorSubject && !sticky) {
      for (const item of this.state.participants) {
        item.role = "participant";
      }
      return;
    }

    // Sticky still inside reconnect grace — temporary live admin only, keep sticky subject.
    if (sticky && this.inReconnectGrace(sticky)) {
      const liveAdmin = this.state.participants.find(
        (item) => item.role === "admin" && this.isLive(item),
      );
      if (liveAdmin) return;
      const next =
        preferred && this.isLive(preferred) && preferred.id !== sticky.id
          ? preferred
          : this.state.participants.find(
              (item) => this.isLive(item) && item.id !== sticky.id,
            );
      if (next) {
        for (const item of this.state.participants) {
          item.role = item.id === next.id ? "admin" : "participant";
        }
      }
      return;
    }

    const liveAdmin = this.state.participants.find(
      (item) => item.role === "admin" && this.isLive(item),
    );
    if (liveAdmin) {
      if (!this.state.creatorSubject) {
        this.state.creatorSubject = liveAdmin.subject;
      }
      return;
    }

    for (const item of this.state.participants) {
      if (item.role === "admin") item.role = "participant";
    }
    const next =
      preferred && this.isLive(preferred)
        ? preferred
        : this.state.participants.find((item) => this.isLive(item));
    if (!next) return;
    next.role = "admin";
    if (!this.state.creatorSubject) {
      this.state.creatorSubject = next.subject;
    } else if (sticky && !this.inReconnectGrace(sticky) && !this.isLive(sticky)) {
      // Grace already expired but row not filtered yet — allow sticky transfer.
      this.state.creatorSubject = next.subject;
    }
  }

  private isAdmin(participant: Participant): boolean {
    return participant.role === "admin";
  }

  private canModerate(participant: Participant): boolean {
    return this.authorizeModeration(participant, false);
  }

  /**
   * Mute all / End call must succeed for the live SFU creator. The client sends
   * claimHost on those actions so a stale creatorSubject can never block them.
   */
  private authorizeModeration(
    participant: Participant,
    claimHost: boolean,
    via?: WebSocket,
  ): boolean {
    if (!this.isLive(participant, via)) return false;
    if (claimHost) {
      this.claimHost(participant);
      return true;
    }
    this.ensureLiveAdmin(participant);
    if (this.isAdmin(participant)) return true;
    return Boolean(
      this.state.creatorSubject &&
        participant.subject === this.state.creatorSubject,
    );
  }

  private socketsFor(id: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment?.id === id;
    });
  }

  private socketFor(id: string): WebSocket | undefined {
    return this.socketsFor(id)[0];
  }

  private sendTo(id: string, message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.socketsFor(id)) {
      try {
        socket.send(serialized);
      } catch {
        // Best-effort — one dead socket must not skip the guest.
      }
    }
  }

  private broadcast(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        // Best-effort.
      }
    }
  }

  private broadcastState(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      try {
        socket.send(
          JSON.stringify({
            adminId:
              this.state.participants.find((item) => item.role === "admin")?.id ??
              null,
            participants: this.state.participants.map(publicParticipant),
            selfId: attachment.id,
            type: "room-state",
          }),
        );
      } catch {
        // Best-effort.
      }
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
    forceMuted: Boolean(participant.forceMuted),
    handRaised: participant.handRaised,
    id: participant.id,
    media: participant.media,
    mediaParticipantId: participant.mediaParticipantId ?? null,
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
