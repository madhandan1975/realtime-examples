import { buildInviteUrl, passwordStorageKey } from "./ws-bootstrap";

export function openAnotherParticipant(
  url = location.href,
  open: typeof window.open = window.open.bind(window),
): void {
  const match = /^\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(
    new URL(url, location.href).pathname,
  );
  const roomId = match?.[1];
  const password = roomId
    ? sessionStorage.getItem(passwordStorageKey(roomId))
    : null;
  const target =
    roomId && password && password.length >= 8
      ? buildInviteUrl(roomId, password)
      : url;
  open(target, "_blank", "noopener");
}
