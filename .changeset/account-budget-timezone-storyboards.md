---
"adcontextprotocol": patch
---

Add capability-gated compliance storyboards for seller-fixed, buyer-selected,
and seller-assigned account timezones; account-based and feature-fixed daily
budget-cap boundaries; buyer cap-timezone overrides; and independent account,
reporting, and billing clocks. Cover buyer-preference mismatches against a
seller-fixed UTC clock, portable natural-key reconnects, and selecting a second
advertised timezone as a separate immutable account identity. Reject
unadvertised buyer timezone overrides with the canonical unsupported-feature
error.
