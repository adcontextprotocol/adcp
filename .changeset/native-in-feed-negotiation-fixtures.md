---
"adcontextprotocol": patch
---

Compliance: the `typed_proposal_negotiation` and `refine_frequency_cap_negotiation` storyboards seeded their native product (`native_feed_q4` and `no_fcap_native_q4`) with `format_kind: "native"` and `channels: ["native"]`, neither of which is a valid value. The format declaration matched no `core/product-format-declaration.json` branch, so a seller that echoed the seeded product failed product schema validation. The declaration now uses `native_in_feed`, the canonical kind for in-feed native, and carries the `params` that every format declaration requires (title and body length limits and a 1200×627 main image). The channel is now `display`. Both fixtures now match `main`. No storyboard step depends on the format kind or channel, and the product's role in both storyboards is unchanged. Released bundles are unchanged.
