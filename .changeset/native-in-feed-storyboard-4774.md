---
---

Add native_in_feed conformance storyboard to creative protocol coverage.

New storyboard at `static/compliance/source/protocols/creative/scenarios/native_in_feed.yaml` exercises the full native_in_feed canonical end-to-end: format discovery via `list_creative_formats` (asset_types filter), happy-path `sync_creatives` with all 12 slots and three pixel_tracker entries, four isolated validation-rejection steps asserting per-constraint error codes (title_max_chars → VALIDATION_ERROR/INVALID_REQUEST, main_image_sizes → VALIDATION_ERROR/INVALID_REQUEST, cta_values closed-set → CREATIVE_VALUE_NOT_ALLOWED, pixel_tracker event=custom without custom_event_name → INVALID_REQUEST/VALIDATION_ERROR), and `preview_creative` showing the assembled feed render.

Closes #4774. Ref: #4770 (Taboola fixture + schema fixes that landed canonical slot definitions and pixel_tracker enum), #3307 (native_in_feed canonical-formats GA).
