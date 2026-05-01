---
---

docs(reference/migration): fix `url_type` "tracking_pixel" → `role: "impression_tracker"` in creatives.mdx

The asset discovery example in the v2→v3 migration guide used `"url_type": "tracking_pixel"` inside a requirements block — wrong on two counts: `url_type` is not a field of `url-asset-requirements.json` (it belongs on the manifest-side asset payload), and `tracking_pixel` is not a valid `url-asset-type.json` enum value. The correct representation for this URL slot's constraint is `"role": "impression_tracker"`, using the `role` enum from `url-asset-requirements.json`. Closes #3692.
