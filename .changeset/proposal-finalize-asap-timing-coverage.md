---
"adcontextprotocol": patch
---

Add `proposal_finalize_asap_timing` storyboard scenario covering `start_time: "asap"` on `create_media_buy`.

The existing `proposal_finalize` scenario only tested the ISO 8601 date string form. This new scenario
exercises the spec-defined `"asap"` string literal (from `start-timing.json`), catching wrapper-layer
rejections that accept ISO dates but reject the asap form before the handler runs. Registered under
both `sales-guaranteed` and `sales-proposal-mode` specialism indexes.
