---
---

docs: harden the creative lifecycle ahead of 3.0 GA with two prose clarifications that prevent seller/buyer divergence from baking in.

1. **Creative state and assignment state are separate lifecycles.** Creative review status (`processing`, `pending_review`, `approved`, `rejected`, `archived`) and assignment state (creative↔package link on a media buy) are tracked independently. Rejecting, canceling, or completing a media buy releases its assignments but does not modify the creatives themselves — they remain in the library with their existing review status and can be reused on other buys. (#2254)

2. **Inline creatives are decoupled from the buy outcome.** Creatives submitted via the package `creatives` array on `create_media_buy` enter the library with the same lifecycle as `sync_creatives` uploads. If the buy is rejected, canceled, or never activates, only the package assignments are released. Creative review proceeds independently of the buy outcome — sellers MUST NOT short-circuit review based on a rejected buy, and a buy rejection does not imply rejection of the submitted creatives. (#2262)

Both are prose-only with no schema changes. Retention (#2260) and webhooks (#2261) are deferred to 3.1 since they are additive for buyers.
