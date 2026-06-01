---
"adcontextprotocol": minor
---

Add `FORMAT_NOT_SUPPORTED` to the canonical error-code enum for creative-agent canonical build routing.

The 3.1 `creative.supported_formats` storyboard and `build_creative` docs already require creative agents to fail closed with this code when `target_format_id.id` is not an advertised canonical capability or supported legacy named format. Publishing the enum entry, including the `supported_capability_ids` details hint, keeps schema validation, docs, and conformance aligned.
