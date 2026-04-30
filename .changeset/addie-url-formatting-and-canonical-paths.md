---
---

Tightens Addie's URL handling so the bouncer link added in #3577 actually works when surfaced in Slack. Adds a behaviors rule that bans wrapping bare URLs in `**`/`*`/quotes/backticks (Slack's auto-linker sweeps trailing punctuation into the link target — `**https://.../connect/github**` resolved as a click to `/connect/github*` and 404'd in production). Adds `/account` and `/connect/github` to the canonical URL allowlist in `urls.md`, and adds `/dashboard/settings` and `/settings` to the hallucinated-paths table so the prompt actively redirects Addie when she reaches for those.
