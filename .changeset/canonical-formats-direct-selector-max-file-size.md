---
"adcontextprotocol": patch
---

compliance(media-buy): the `canonical_formats` direct canonical selector carries every param the product constrains.

`create_media_buy_with_direct_canonical_selector` sent `{format_kind: "image", params: {width: 300, height: 250}}` against `canonical_formats_mrec_display`, whose image declaration also constrains `max_file_size_kb: 200`. The runner's `canonical_format_satisfaction` check correctly classified the omitted constrained param as `directionality` (`local_satisfied: false`), so the step failed for every seller even when the create was accepted. The selector now includes `max_file_size_kb: 200`, and the check description says "selector" rather than "dimensions" since the satisfying param is not a spatial one. No schema or wire change; the packaged `dist/compliance/` cache is generated from this source.
