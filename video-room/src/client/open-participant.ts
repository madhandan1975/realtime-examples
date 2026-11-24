import { buildInviteUrl, passwordStorageKey } from "./ws-bootstrap";

export function openAnotherParticipant(
  url = typeof location !== "undefined" ? location.href : "",
  open: typeof window.open = typeof window !== "undefined"
    ? window.open.bind(window)
    : (() => null),
): void {
  const base =
    typeof location !== "undefined" ? location.href : "https://localhost/";
  const match = /^\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(
    new URL(url, base).pathname,
  );
  const roomId = match?.[1];
  const password =
    roomId && typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(passwordStorageKey(roomId))
      : null;
  const target =
    roomId && password && password.length >= 8
      ? buildInviteUrl(roomId, password)
      : url;
  open(target, "_blank", "noopener");
}
