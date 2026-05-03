---
---

Add admin-only `/video/lab` experimentation surface that connects to the Tavus session via `@daily-co/daily-js` directly (no iframe) instead of the production iframe path on `/video`. Lets us prototype custom controls, push-to-interrupt, and a pre-call device test before deciding what to promote to production.

- New route `GET /video/lab` (gated by `requireAdmin`) serves `server/public/video-lab.html`. Daily JS SDK is loaded from CDN; pin a version before promoting any of this to production.
- Reuses `POST /api/addie/video/session` — no backend changes, no separate Tavus persona.
- Pre-call device test: enumerate cameras/mics/speakers, local preview, "Test camera & mic" gates the join button until permissions are granted.
- Push-to-interrupt: button + Space-bar shortcut sends `{ message_type: 'conversation', event_type: 'conversation.interrupt' }` as a Daily app-message, which Tavus listens for to stop the replica mid-utterance.
- Custom controls: mute, camera toggle, end call. Network-quality pill from `network-quality-change`. Active-speaker indicator from `active-speaker-change`.
- Live event log streams Daily events + sent/received app-messages for protocol debugging.

Production `/video` and the embedded `/chat` panel are untouched.
