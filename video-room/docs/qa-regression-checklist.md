# Voice room QA regression checklist

Environment: `https://voice-room-sfu.madhan1975.workers.dev`  
Host create key: from `ROOM_CREATE_SECRET` (never put in share links)  
Use a **unique room id** each full run. Prefer two browsers/profiles for host + guest.

## Layers

| Layer | When | Scope |
| --- | --- | --- |
| Smoke | Every deploy | Create → 2-party audio → Mute all → End call → OGG download |
| Full regression | Before push / weekly | Entire matrix below |

## How to record results

For each case: `PASS` / `FAIL` / `SKIP`, date, room id, notes. On FAIL capture request id from status bar, host/guest role, Leave vs tab close.

---

## A. Access and room lifecycle

| ID | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| A1 | Create gated | Join on brand-new room (no create) | Clear error / 409 room not created | |
| A1b | Create without key | Create room, omit host key | 403 create forbidden | |
| A1c | Create with key | Create + valid host key + password 8+ | Room created; join succeeds | |
| A2 | Join open | Guest: Join + room password only | Joins; no create key required | |
| A3 | Wrong password | Guest with wrong password | Rejected; no lasting SFU session | |
| A4 | Host is creator | After Create+join | Host sees Mute all + End call; guest does not | |
| A5 | Reuse after End call | End call, then open same URL | Documented/tombstone behavior; no ghost call | |

## B. Media / presence

| ID | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| B1 | Two-way audio | Host + guest join, speak | Hear each other within ~5s | |
| B2 | Self mute | Toggle Mute/Unmute | Remote stops/starts hearing | |
| B3 | Push-to-talk | Hold Space, release | Talk while held; restores prior mute | |
| B4 | Leave button | Guest clicks Leave | Gone from host tiles + audio within ~3s | |
| B5 | Browser close (P0) | Guest closes tab | Host loses participant/audio within ~5s (not ~45s) | |
| B5b | Refresh host | Host refreshes mid-call | Reconnects; no duplicate ghost tile | |
| B6 | Stale generation | After refresh/reconnect | Status → Connected; no sticky media_generation_stale loop | |

## C. Host controls

| ID | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| C1 | Mute all | Host Mute all | Guest locked; “Muted by host”; Space/Unmute blocked; host sees muted | |
| C1b | Guest-first join | Guest RoomDO joins before host | Guest has no Mute all/End call; host gets them after room-state | |
| C1c | Mute all during Space | Guest holds Space; host Mute all; guest releases | Guest stays muted (Space release must not unmute) | |
| C2 | Force unmute | Host unmutes guest on tile | Guest can speak again | |
| C3 | Kick | Host kicks guest | Guest removed; socket closed; host gets error if target invalid | |
| C3b | Transfer admin | Host Make admin on guest | Controls move and **stick**; new host Mute all works | |
| C3c | Host blip grace | Host RoomDO drops &lt;30s; guest present | Sticky host not stolen; host Mute all works after rejoin | |
| C4 | End call | Host End call | Everyone leaves; recording finalizes; no reconnect loop | |
| C4b | End call keeps OGG | 2-party call, End call, download | OGG is the ended take (not wiped by leave sync) | |
| C4c | Guest End call | Guest (SFU-first joiner) | No End call button; forced WS end-call rejected without leaving others muted/finalized | |

## D. Recording / OGG

| ID | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| D1 | Live recording | During call | Status recording; adapters &gt; 0 when publishing | |
| D2 | Finalize | End call | Status ready; download enabled | |
| D3 | Download | Download recording | Filename `YYYY-MM-DD.ogg` (UTC); `audio/ogg`; plays | |
| D4 | Size | ~1–2 min sample | Extrapolates near ~15 MB/hour | |
| D5 | Admin portal | `/admin` room + password | Same OGG download | |
| D6 | Retention | After expiry (if fixture) | 410 expired | |

## E. Cost / resource release

| ID | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| E1 | Leave / tab close | Leave or close tab | That user’s SFU/recording activity stops promptly | |
| E2 | End call adapters | End call | No lingering SFU websocket adapters for room | |
| E3 | Idle room | Empty after leave | R2 PCM not growing forever | |

## F. Negative / abuse

| ID | Case | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| F1 | Guest host actions | Guest tries End call / Mute all | UI hidden; server rejects if forced | |
| F2 | Create key leakage | Copy room link | URL has no create secret | |
| F3 | Double tab | Same guest identity, second tab | Replaces socket; no permanent dual publishers | |

---

## Smoke run log

| Date | Build / Version | A1c | B1 | B5 | C1 | C4 | D2 | D3 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 | `0c1d5031` + unload leave deploy | PASS (API create) | SKIP (needs 2 mics) | PASS (API leave keepalive: participant cleared in 388ms) | SKIP (manual 2-browser) | SKIP (manual) | SKIP | SKIP | Automated: create→join→leave clears membership immediately. Manual B1/C1/C4/D3 still required on device. |

## Failure triage

1. Note room id, request id, timestamp, role (host/guest).
2. Classify: auth/create, media/SFU, RoomDO controls, recording/OGG, unload/leave.
3. For unload issues: confirm `pagehide` leave keepalive fired (Network: `POST .../leave` with keepalive) and RoomDO WS closed.
