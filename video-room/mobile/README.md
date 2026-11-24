# Voice Room native shells (Capacitor)

Telegram-like screen-off two-way audio requires the Capacitor iOS/Android apps.
The mobile browser cannot keep WebRTC mic + playback alive when the display locks.

## What this does

- Loads the deployed Worker SPA (`https://voice-room-sfu.madhan1975.workers.dev`)
- Starts `VoiceCallSession` on join:
  - **iOS:** `AVAudioSession` `.playAndRecord` + `UIBackgroundModes: audio`
  - **Android:** foreground service (`microphone|mediaPlayback`) + partial wake lock + ongoing notification
- Stops the session on leave / terminate

## Prerequisites

- Node 22+
- **Android:** Android Studio + JDK 21 + device/emulator
- **iOS:** macOS + Xcode 15+ (cannot build iOS on Windows)

## Commands

From `video-room/`:

```bash
npm run mobile:sync      # sync web placeholder + plugins, patch Info.plist / Manifest
npm run mobile:android   # open Android Studio project
npm run mobile:ios       # open Xcode project (macOS only)
```

First-time platform add (once per machine):

```bash
npx cap add android
npx cap add ios          # macOS only
npm run mobile:sync
```

## Device verification

See [../docs/screen-off-voice-qa.md](../docs/screen-off-voice-qa.md).

## Escalation

If iPhone still drops WebRTC under deep lock after audio session + background mode,
replace WKWebView `getUserMedia` / `RTCPeerConnection` with a native WebRTC plugin
while keeping this UI. That is not required for the Android FGS path in most OEMs.
