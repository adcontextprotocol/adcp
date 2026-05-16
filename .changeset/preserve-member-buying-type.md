---
---

Preserve member-declared `buying` agent type through the null-inferred snapshot override path. Buy-side agents structurally don't expose AdCP tools (they CALL them), so passive probe inference always returns `unknown` for them — without this carve-out, member-set `type: 'buying'` was silently squashed to `unknown` on first probe. Smuggle protection still holds for sales/creative/signals (those types are squashed to `unknown` when the snapshot can't classify, since the probe WOULD classify them when reachable). Closes #3549.
