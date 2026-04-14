---
"adcontextprotocol": major
---

Remove `sampling` parameter from `get_media_buy_artifacts` request — sampling is configured at media buy creation time, not at retrieval time. Replace `sampling_info` with `collection_info` in the response. Add `failures_only` boolean filter for retrieving only locally-failed artifacts. Add `content_standards` to `get_adcp_capabilities` for pre-buy visibility into local evaluation and artifact delivery capabilities. Add podcast, CTV, and AI-generated content artifact examples to documentation.
