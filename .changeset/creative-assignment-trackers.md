---
"adcontextprotocol": minor
---

Add experimental assignment-scoped `trackers` in AdCP 3.3 to package creative assignments and `sync_creatives` assignments and assign operations, so one library creative can carry placement-specific measurement URLs for each package without a creative per placement. Each entry is a `pixel_tracker` asset and may use any `pixel_tracker` event. Assignment trackers are added to the creative's own trackers and never replace them, creative approval is unchanged, and they count against the format's tracker-slot maximum (`quantity.max` where declared); a seller that cannot fit or fire them rejects the assignment instead of dropping them. Supporting sellers return the assignment's trackers from `list_creatives` and `get_media_buys`. The new `creative.supports_assignment_trackers` capability defaults to false and requires a creative library; unsupported agents reject the field with `UNSUPPORTED_FEATURE`, and sellers that implement it declare the `creative.assignment_trackers` experimental feature id. Omission on an additive upsert preserves existing trackers, an unassign then assign or an omitted row in a full package replacement clears them, and after an assignment `merge` trackers come only from the buyer's assignment.

Closes #8204.
