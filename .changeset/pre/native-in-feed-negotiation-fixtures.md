---
"adcontextprotocol": patch
---

Compliance: the `typed_proposal_negotiation` and `refine_frequency_cap_negotiation` storyboards seeded their native product (`native_feed_q4` and `no_fcap_native_q4`) with `format_kind: "native"`, which is not a canonical format kind. The format declaration therefore matched no `core/product-format-declaration.json` branch, and a seller that echoed the seeded product failed product schema validation. The declaration now uses `native_in_feed`, the canonical kind for in-feed native, and carries the `params` that every format declaration requires (title and body length limits and a 1200×627 main image). No storyboard step depends on the format kind; the product's role in both storyboards is unchanged.
