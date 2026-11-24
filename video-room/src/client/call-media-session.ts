/**
 * Advertise an ongoing call to the OS media session (helps Android keep playback).
 */
export function setCallMediaSession(active: boolean, roomId?: string): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }
  const session = navigator.mediaSession;
  if (!active) {
    session.metadata = null;
    try {
      session.playbackState = "none";
    } catch {
      // Older browsers may reject playbackState writes.
    }
    return;
  }

  try {
    session.metadata = new MediaMetadata({
      title: "Voice Room",
      artist: roomId ? `Room ${roomId}` : "In a call",
      album: "Live voice",
    });
    session.playbackState = "playing";
  } catch {
    // Media Session is best-effort.
  }
}
