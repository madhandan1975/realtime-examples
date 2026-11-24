# Screen-off voice QA (Telegram-like)

Use the Capacitor app builds from [`../mobile/README.md`](../mobile/README.md). Browser tabs are expected to fail this checklist.

## Setup

1. Install the Android and/or iOS shell on a physical device.
2. Join the same room from a second client (desktop browser is fine) as the listener/speaker peer.
3. Grant microphone (and Android notification) permission in the app.

## Android checklist

- [ ] Join a room in the app; confirm an ongoing “Voice Room” notification appears.
- [ ] Speak while unlocked; peer hears you.
- [ ] Lock the screen for 2–5 minutes; peer still hears you.
- [ ] Peer speaks while your screen is locked; you still hear them through the earpiece/speaker.
- [ ] Unlock; UI recovers without a manual rejoin (or shows reconnect and recovers).
- [ ] Leave room; notification disappears and mic stops.

## iPhone checklist

- [ ] Join a room; Control Center / status bar shows audio activity as expected.
- [ ] Speak while unlocked; peer hears you.
- [ ] Lock the screen for 2–5 minutes; peer still hears you.
- [ ] Peer speaks while locked; you still hear them.
- [ ] Unlock; UI recovers (reconnect if needed).
- [ ] Leave room; audio session ends.

## Escalation (iOS only)

If mic or remote audio still dies under lock after `UIBackgroundModes=audio` + `AVAudioSession` `.playAndRecord`, WKWebView WebRTC is the limit. Next step: native WebRTC plugin for `getUserMedia` / `RTCPeerConnection` only; keep the existing React UI.

## Browser baseline (expected fail)

- [ ] Mobile Safari/Chrome: lock screen → local mic and/or remote audio stop within seconds.
- [ ] Lobby shows the screen-off / install-app notice on mobile browsers.
