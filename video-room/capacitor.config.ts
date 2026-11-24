import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Native shells load the deployed Worker SPA so API/WS stay same-origin.
 * `webDir` is a required Capacitor placeholder used when `server.url` is unset.
 */
const config: CapacitorConfig = {
  appId: "com.voiceroom.app",
  appName: "Voice Room",
  webDir: "mobile/www",
  server: {
    url: "https://voice-room-sfu.madhan1975.workers.dev",
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#fafaf9",
  },
  ios: {
    backgroundColor: "#fafaf9",
    contentInset: "automatic",
  },
  plugins: {
    VoiceCallSession: {},
  },
};

export default config;
