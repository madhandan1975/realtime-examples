import { registerPlugin } from "@capacitor/core";
import type { VoiceCallSessionPlugin } from "./definitions";

const VoiceCallSession = registerPlugin<VoiceCallSessionPlugin>(
  "VoiceCallSession",
  {
    web: () => import("./web").then((module) => new module.VoiceCallSessionWeb()),
  },
);

export * from "./definitions";
export { VoiceCallSession };
