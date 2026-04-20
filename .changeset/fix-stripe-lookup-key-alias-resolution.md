---
---

Resolve casual Stripe price lookup-key aliases (e.g. `explorer_annual`) to their canonical product (`aao_membership_explorer_50`). Addie's billing tools sometimes invent intuitive keys derived from tier name + interval; `getPriceByLookupKey` now strips common interval suffixes and matches against the canonical `aao_membership_<tier>` prefix before failing.
