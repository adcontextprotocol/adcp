---
"adcontextprotocol": minor
---

spec(creative): add an optional read-only `provenance` to the `list_creatives` creative item. It echoes the creative-level provenance accepted on `sync_creatives` for the returned revision, so sellers reviewing a library can see AI-disclosure metadata without a separate lookup. `provenance` is also selectable through `fields`. Provenance stays part of canonical revision content, so revision rules are unchanged. `get_creative_delivery` is unchanged. Adds an optional `provenance_readback` phase to the `creative/creative_revision_identity` storyboard.
