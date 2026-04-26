---
---

Fix Addie 404 errors on deep-reasoning turns:

- `ModelConfig.depth` default was `claude-opus-4-7[1m]`, which is not a valid Anthropic model ID (the `[1m]` suffix is not part of the model name). Any turn the router classified as `requires_depth` — expert consultation, multi-doc synthesis, protocol-level analysis — or any message in a working-group / council channel would 404 with `not_found_error: model: claude-opus-4-7[1m]`.
- Default is now `claude-opus-4-7` (valid model ID).
- 1M context is now enabled the correct way: via the `context-1m-2025-08-07` Anthropic beta flag, applied automatically to models listed in `MODELS_SUPPORTING_1M_CONTEXT` (currently Opus 4.7 and Sonnet 4.6). Opt out per-deploy with `CLAUDE_DISABLE_1M_CONTEXT=true`.
- Addie's streaming path was switched from `client.messages.stream` to `client.beta.messages.stream` so it can pass `betas` alongside the existing non-stream beta call.
