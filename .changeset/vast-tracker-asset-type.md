---
"adcontextprotocol": minor
---

Add `vast_tracker` and `daast_tracker` asset types for decomposed VAST/DAAST `<TrackingEvents>` URLs. Creative agents can now emit per-event tracker URLs (start, quartiles, complete, etc.) as a discriminated-union alternative to a complete VAST tag; the sales agent assembles them into the VAST `<TrackingEvents>` block at serve time. Adds normative creative/sales boundary: wrapper ownership belongs to the sales agent, and the `<Impression>` URL stays on `url` asset with `url_type: "tracker_pixel"` (not `vast_tracker` with `vast_event: "impression"`). Non-breaking — new asset types only.
