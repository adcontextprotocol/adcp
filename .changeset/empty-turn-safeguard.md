---
---

Partial fix for #3721 — empty-turn safeguard. When the model produces no text AND no successful tool calls, the user gets nothing back: the same UX as a transport drop, and the signature failure mode behind silent invoice-tool failures (the original Greg-thread incident). Added `detectEmptyTurn` next to `detectHallucinatedAction` in `server/src/addie/claude-client.ts`, wired both end-of-turn paths (regular + streaming) to log a warning and flag the response when this happens. Tool-error person events for the billing-tool refusal paths are still pending — that piece needs personId plumbing through `MemberContext` and is left for a follow-up.
