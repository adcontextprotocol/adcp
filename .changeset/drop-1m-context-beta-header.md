---
---

server(addie): drop `context-1m-2025-08-07` beta header now that 1M context is GA on Sonnet 4.6 / Opus 4.6+

Anthropic retired the `context-1m-2025-08-07` beta on Sonnet 4 / Sonnet 4.5 (requests >200K on those models now error) and made 1M context generally available on Sonnet 4.6 and Opus 4.6+. Addie already runs on Sonnet 4.6 (primary) and Opus 4.7 (depth), so the explicit beta flag is no longer required — and keeping it risks a stray request being routed to a retired model and rejected.

Removes `CONTEXT_1M_BETA`, `MODELS_SUPPORTING_1M_CONTEXT`, `getModelBetas()`, and the `CLAUDE_DISABLE_1M_CONTEXT` opt-out from `server/src/config/models.ts`, and drops the corresponding spread in `server/src/addie/claude-client.ts` for both the non-streaming and streaming `client.beta.messages` calls. The streaming call still uses the `beta` namespace because `web-search-2025-03-05` is passed there.
