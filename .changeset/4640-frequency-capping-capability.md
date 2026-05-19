---
"adcontextprotocol": minor
---

feat(schemas): add media_buy.frequency_capping capability declaration (closes #4640)

Sellers can now declare frequency-capping support in get_adcp_capabilities. Presence of the object means the seller honors `targeting.frequency_cap` and MUST reject caps they cannot enforce rather than silently dropping them.

Two optional sub-fields let buyers pre-flight validate before submitting:
- `supported_per_units` — entity granularities (devices, individuals, etc.) from reach-unit.json
- `supported_window_units` — duration units (hours, days, campaign) from duration.json

`enforces_within` from the original RFC was dropped — no SSP can back that attestation cleanly. Per-product overrides for mixed addressable/non-addressable inventory are a likely follow-up.

A capability-gated `frequency_cap_enforcement` storyboard scenario lands separately under the capability-claim contract pattern (#4637).
