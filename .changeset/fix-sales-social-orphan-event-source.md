---
---

fix(storyboards): seed event_source_id via sync_event_sources in sales_social

The sales_social specialism storyboard referenced `event_source_id: "acmeoutdoor_website"` in a
log_event step without a preceding sync_event_sources call, producing an orphan reference that
seller agents validating event-source existence would reject with EVENT_SOURCE_NOT_FOUND. Adds an
`event_setup` phase that registers `acmeoutdoor_website` before `event_logging`, and adds
`sync_event_sources` to `required_tools` — matching the sales_catalog_driven pattern. Closes #2909.
