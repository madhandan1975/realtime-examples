import { WebPlugin } from "@capacitor/core";
import type {
  VoiceCallSessionPlugin,
  VoiceCallSessionStartOptions,
} from "./definitions";

/** No-op on browsers — OS will still suspend WebRTC when the screen locks. */
export class VoiceCallSessionWeb
  extends WebPlugin
  implements VoiceCallSessionPlugin
{
  async start(_options: VoiceCallSessionStartOptions): Promise<void> {
    // Web cannot keep mic+playback alive with the display off.
  }

  async stop(): Promise<void> {
    // No-op.
  }
}
