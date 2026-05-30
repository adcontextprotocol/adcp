---
"adcontextprotocol": minor
---

Add `field_pattern` / `envelope_field_pattern` compliance check kinds and use the envelope-scoped form to validate `adcp_version` shape in the version-negotiation storyboard.

Tighten media-buy storyboards that reuse a discovered `pricing_option_id` so auction-priced flows send `bid_price` and fixed-price flows validate the captured option before downstream package creation.
