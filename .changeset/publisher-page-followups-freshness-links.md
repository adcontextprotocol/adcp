---
---

Three deferred follow-ups from the publisher-page redesign roadmap, shipped as a single small UI patch on `/publisher/<domain>`:

- **Freshness pill** alongside the verified timestamp — color-coded green (<24h), amber (<7d), red (older). Lets a verifier scan staleness without subtracting dates. Reads off `last_validated` (already plumbed through Phase B); pure CSS + a small JS helper.
- **Buy-side agents** added as a fourth cross-link card in the page footer (alongside spec / publishers / builder). Closes the "no exit to the agent directory" gap from the product review.
- **Authorized agent URLs are now clickable** — open in a new tab so a buyer can inspect the agent endpoint directly. Validated to http(s) only at the renderer so a malicious manifest can't smuggle a `javascript:` href. Replaces the prior plain-text rendering.

No backend changes. Single-file edit, +88 net LoC.
