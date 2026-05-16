---
---

Make `/video` a side-by-side chooser between the Standard (Tavus iframe) and Daily SDK versions, and add an Advanced settings panel to the Daily SDK page.

- `/video` now shows two buttons: Start conversation (Standard) and Try the Daily SDK version (Beta). Anyone can pick either; both create the same Tavus session via the same backend endpoint.
- `/video/lab` is no longer admin-gated — open to anyone (session creation itself still requires login + rate limit).
- Lab page Advanced settings (collapsed by default, persisted to localStorage):
  - **Custom greeting** — first words Addie speaks
  - **Conversational context** — extra system-prompt text appended for this session
  - **Max call duration** — slider, 5–120 min, mapped to Tavus `properties.max_call_duration`
  - **Greenscreen background** — `properties.apply_greenscreen` for keynote compositing
  - **Language** — Tavus `properties.language` (full names, not ISO codes per Tavus's API)
- `POST /api/addie/video/session` now accepts `greeting`, `extraContext`, `maxDurationSec`, `greenscreen`, `language` in the JSON body. All optional, validated, clamped, and only forwarded to Tavus when set.
