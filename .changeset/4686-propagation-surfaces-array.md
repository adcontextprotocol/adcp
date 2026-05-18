---
"adcontextprotocol": minor
---

Restructure `capabilities.media_buy.impairment_propagation` from a single-value enum to `capabilities.media_buy.propagation_surfaces` (non-exclusive array). The enum couldn't express the common case where a seller propagates impairments on both the buy snapshot AND fires webhooks (GAM, FreeWheel, CM360) — the previous shape forced a choice between `snapshot` and `webhook_only`, which created an incentive to declare `webhook_only` and dodge the snapshot-coherence bar even when the seller actually does both. The array shape lets sellers declare `["snapshot", "webhook"]` honestly.

Surface values:
- **`snapshot`** — `media_buy.health` + `media_buy.impairments[]` mirror impairments on `get_media_buys` reads. Graded by `impairment.coherence` storyboards when declared.
- **`webhook`** — `notification-type: impairment` webhooks fire via `push_notification_config`. Graded by the persistent-channel webhook contract.
- **`out_of_band`** — propagation via channels outside the AdCP protocol surface (email, dashboard, partner-specific feeds). Compliance bar is the offline agreement, not a protocol assertion. Sellers with a non-AdCP-field mapping gap (e.g., `media_buy.delivery_status_detail` instead of `media_buy.health`) SHOULD document the mapping rather than declare `out_of_band` — the spec's gap is what this value legitimately covers.

Default when absent: `["snapshot"]` (preserves current snapshot-coherence contract for sellers that don't declare).

Storyboard gating: `impairment.coherence` scenarios (`dependency_impairment`, `dependency_impairment_cardinality`) grade `not_applicable` when `propagation_surfaces` does not include `"snapshot"`. Sellers declaring `["snapshot", "webhook"]` are graded on the snapshot surface here and on the webhook contract separately.

Pre-release breaking change to the freshly-shipped `impairment_propagation` enum (landed in PR #4685 but unreleased — 3.1.0 GA is 2026-05-29). No deprecation cycle needed; sellers migrating from a pre-release adoption translate single values to one-element arrays.

Closes #4686.
