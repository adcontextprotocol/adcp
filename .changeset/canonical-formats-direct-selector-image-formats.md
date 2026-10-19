---
"adcontextprotocol": patch
---

compliance(media-buy): the `canonical_formats` direct canonical selector carries every param the product constrains.

`create_media_buy_with_direct_canonical_selector` sent `{width: 300, height: 250, max_file_size_kb: 200}` against `canonical_formats_mrec_display`, whose image declaration also constrains `image_formats: ["jpg", "png"]`. The runner's `canonical_format_satisfaction` check classified the omitted constrained param as `directionality` (`local_satisfied: false`), so the step failed for every seller even when the create was accepted — the same defect class #7791 fixed for `max_file_size_kb`. The selector now includes `image_formats: ["jpg", "png"]`, matching the product's declared constraint. No schema or wire change; the packaged `dist/compliance/` cache is generated from this source.
