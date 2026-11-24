import { Capacitor, registerPlugin } from "@capacitor/core";

type VoiceCallSessionPlugin = {
  start(options: { roomId: string; title?: string }): Promise<void>;
  stop(): Promise<void>;
};

const VoiceCallSession = registerPlugin<VoiceCallSessionPlugin>(
  "VoiceCallSession",
);

/** True when running inside the Capacitor iOS/Android shell. */
export function isNativeVoiceShell(): boolean {
  return Capacitor.isNativePlatform();
}

/** Start OS background call session (FGS / AVAudioSession). No-op on web. */
export async function startVoiceCallSession(
  roomId: string,
  title = "Voice Room",
): Promise<void> {
  if (!isNativeVoiceShell()) return;
  try {
    await VoiceCallSession.start({ roomId, title });
  } catch (error) {
    console.warn("VoiceCallSession.start failed", error);
  }
}

/** Stop OS background call session. No-op on web. */
export async function stopVoiceCallSession(): Promise<void> {
  if (!isNativeVoiceShell()) return;
  try {
    await VoiceCallSession.stop();
  } catch (error) {
    console.warn("VoiceCallSession.stop failed", error);
  }
}
