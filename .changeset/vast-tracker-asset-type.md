---
"adcontextprotocol": minor
---

Add `vast_tracker` and `daast_tracker` asset types for decomposed VAST/DAAST `<TrackingEvents>` URLs. Creative agents can now emit per-event tracker URLs (start, quartiles, complete, etc.) as a discriminated-union alternative to a complete VAST tag; the sales agent assembles them into the VAST `<TrackingEvents>` block at serve time. Adds normative creative/sales boundary: wrapper ownership belongs to the sales agent, and the `<Impression>` URL stays on `url` asset with `url_type: "tracker_pixel"` (not `vast_tracker` with `vast_event: "impression"`).

The `offset` pattern aligns with the VAST 4.2 XSD `Tracking@offset` constraint: `HH:MM:SS[.mmm]` with two-digit hours and minutes/seconds 00–59, or an integer percentage 0–100 suffixed with `%`. Negative offsets are not permitted (the VAST XSD pattern does not allow a leading minus). Tracker assets enforce a JSON Schema `if/then` requiring `offset` whenever `vast_event` / `daast_event` is `progress`, and exclude both VAST/DAAST element-children that don't live under `TrackingEvents` (`impression`, `clickTracking`, `customClick`, `error`) and `ViewableImpression`-element children (`viewable`, `notViewable`, `viewUndetermined`, `measurableImpression`, `viewableImpression`).

Non-breaking — new asset types only.
