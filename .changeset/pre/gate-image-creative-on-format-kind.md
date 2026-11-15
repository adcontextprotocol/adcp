---
"adcontextprotocol": patch
---

Stop the `dependency_impairment` and `dependency_impairment_cardinality` storyboards from failing sellers whose selected format option is not an image format (adcp#8770). Both storyboards send a fixed 300x250 image creative against the first product's first format option. When that option is a `display_tag`, `video_vast` or other non-image kind, the creative phases are now skipped instead of failing a seller that correctly refuses an image it does not accept. Image sellers run the storyboards unchanged.
