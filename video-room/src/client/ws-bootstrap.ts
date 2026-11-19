/**
 * Patch WebSocket/fetch before any room code opens sockets.
 * AUTH_MODE=skip requires a guest UUID on every control-plane WebSocket.
 * Import this module first from main.tsx (side effect runs on load).
 */
export function installRoomPasswordPropagation(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (requestUrl.origin !== location.origin) return originalFetch(input, init);
    const roomId = roomIdFromRequestUrl(requestUrl);
    if (!roomId) return originalFetch(input, init);
    const password = sessionStorage.getItem(passwordStorageKey(roomId));
    const createSecret = sessionStorage.getItem(createSecretStorageKey(roomId));
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("x-room-guest-id", guestIdentity(roomId));
    if (password) headers.set("x-room-password", password);
    if (createSecret) headers.set("x-room-create-secret", createSecret);
    return originalFetch(input, { ...init, headers });
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const requestUrl = new URL(String(args[0]), location.href);
      if (requestUrl.origin === location.origin) {
        const roomId = roomIdFromRequestUrl(requestUrl);
        if (roomId) {
          requestUrl.searchParams.set("guest", guestIdentity(roomId));
          const password = sessionStorage.getItem(passwordStorageKey(roomId));
          if (password) requestUrl.searchParams.set("password", password);
        }
      }
      return Reflect.construct(
        target,
        [requestUrl.toString(), ...args.slice(1)],
        newTarget,
      ) as WebSocket;
    },
  });
}

export function passwordStorageKey(roomId: string): string {
  return `video-room-password-${roomId}`;
}

export function createSecretStorageKey(roomId: string): string {
  return `video-room-create-secret-${roomId}`;
}

function roomIdFromRequestUrl(url: URL): string | undefined {
  const apiMatch = /^\/api\/rooms\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/.exec(
    url.pathname,
  );
  if (apiMatch?.[1]) return apiMatch[1];
  if (
    url.pathname === "/api/recording/status" ||
    url.pathname === "/api/recording/finalize" ||
    url.pathname === "/api/recording/pcm" ||
    url.pathname === "/recording" ||
    url.pathname === "/ws/room" ||
    url.pathname === "/ws/recording"
  ) {
    return url.searchParams.get("room") ?? undefined;
  }
  return undefined;
}

export function guestIdentity(roomId: string): string {
  const key = `video-room-guest-${roomId}`;
  const existing = sessionStorage.getItem(key);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

/** Telegram-style invite: `/rooms/{id}#invite={base64url(password)}`. */
export function encodeInviteToken(password: string): string {
  const bytes = new TextEncoder().encode(password);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

export function decodeInviteToken(token: string): string | null {
  try {
    const paddedBase =
      token.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (token.length % 4)) % 4);
    const binary = atob(paddedBase);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const password = new TextDecoder().decode(bytes);
    return password.length >= 8 && password.length <= 128 ? password : null;
  } catch {
    return null;
  }
}

export function buildInviteUrl(roomId: string, password: string): string {
  const url = new URL(`/rooms/${roomId}`, location.href);
  url.hash = `invite=${encodeInviteToken(password)}`;
  return url.toString();
}

/**
 * Consume `#invite=` or legacy `?password=` into sessionStorage and strip from the URL.
 * Returns the unlocked password when one was applied for the current room path.
 */
export function consumeRoomInviteFromLocation(): string | undefined {
  const url = new URL(location.href);
  const match = /^\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(url.pathname);
  if (!match?.[1]) return undefined;
  const roomId = match[1];

  let password: string | undefined;
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);
  const inviteToken = hashParams.get("invite");
  if (inviteToken) {
    password = decodeInviteToken(inviteToken) ?? undefined;
  }
  if (!password) {
    const queryPassword = url.searchParams.get("password");
    if (queryPassword && queryPassword.length >= 8 && queryPassword.length <= 128) {
      password = queryPassword;
    }
  }
  if (!password) {
    return sessionStorage.getItem(passwordStorageKey(roomId)) ?? undefined;
  }

  sessionStorage.setItem(passwordStorageKey(roomId), password);
  url.searchParams.delete("password");
  url.hash = "";
  history.replaceState(history.state, "", url);
  return password;
}

installRoomPasswordPropagation();
