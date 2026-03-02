---
"adcontextprotocol": patch
---

fix(addie): replace hand-coded AdCP tool handlers with generic passthrough

Fixes #1311 — `build_creative` was dropping `brand`, `quality`, `item_limit`, `context`, and `ext` because the handler cherry-picked parameters. Every other handler had similar gaps for fields added after the handler was written.

All ~30 per-tool handlers now use a single generic loop that strips only Addie-specific routing fields (`agent_url`, `debug`) and forwards everything else to the SDK's `executeTask()` unchanged. This eliminates the entire class of "forgot to forward field X" bugs.

Also fixes a latent issue where `if (input.field)` truthiness checks silently dropped valid falsy values like `paused: false` or `budget: 0`.
