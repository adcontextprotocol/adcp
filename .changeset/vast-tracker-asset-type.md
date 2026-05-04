---
"adcontextprotocol": minor
---

Add `vast_tracker` and `daast_tracker` asset types for decomposed VAST/DAAST `<TrackingEvents>` URLs. Creative agents can now emit per-event tracker URLs (start, quartiles, complete, etc.) as a discriminated-union alternative to a complete VAST tag; the sales agent assembles them into the VAST `<TrackingEvents>` block at serve time. Adds normative creative/sales boundary: wrapper ownership belongs to the sales agent, and the `<Impression>` URL stays on `url` asset with `url_type: "tracker_pixel"` (not `vast_tracker` with `vast_event: "impression"`).

**Tracker asset constraints (from authoritative spec):**

- `offset` pattern aligns with the VAST 4.2 XSD `Tracking@offset` constraint (`vast_4.2.xsd` line 146): `HH:MM:SS[.mmm]` with two-digit hours and minutes/seconds 00–59, or an integer percentage 0–100 suffixed with `%`. Negative offsets are not permitted — the VAST XSD pattern has no leading-minus branch.
- A JSON Schema `if/then` requires `offset` whenever `vast_event` / `daast_event` is `progress` (mirrors the XSD documentation: "Must be present for progress event").
- `vast_event` / `daast_event` exclude both VAST/DAAST element-children that don't live under `<TrackingEvents>` (`impression`, `clickTracking`, `customClick`, `error`) and `<ViewableImpression>`-element children (`viewable`, `notViewable`, `viewUndetermined`, `measurableImpression`, `viewableImpression`).
- Each tracker carries a `target` field (`linear` | `non_linear` | `companion` for VAST; `linear` | `companion` for DAAST, since DAAST has no `<NonLinearAds>` element) so the sales agent places the tracker under the correct `<TrackingEvents>` parent during XML assembly.

**Tracking-event enum corrections (corrective alignment to spec):**

- VAST: add the five VAST 4.2 events that were missing from `vast-tracking-event.json` (`acceptInvitation`, `adExpand`, `adCollapse`, `minimize`, `overlayViewDuration` — all in the XSD enumeration). Drop `notUsed`, which was incorrectly inherited from earlier draft work and is not in the VAST 4.2 XSD `Tracking@event` enumeration. `fullscreen` / `exitFullscreen` are kept and labeled as VAST 2.x / 3.x compat.
- DAAST: add `rewind` (DAAST 1.1 §3.2.1.7 lists it explicitly). Drop `loaded`, which is not in DAAST 1.1 §3.2.1.7. `progress` is retained per DAAST 1.1 §3.2.4.3.

These enum corrections are nominally breaking for the existing `tracking_events` field on the `vast` / `daast` asset types, but the dropped values were never spec-correct (`notUsed` is not in the VAST 4.2 XSD; `loaded` is not in DAAST 1.1 §3.2.1.7) — fixing them up before the new tracker assets reference these enums avoids carrying the inconsistency forward.
