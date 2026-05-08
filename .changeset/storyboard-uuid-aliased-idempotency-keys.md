---
"adcontextprotocol": patch
---

fix(compliance): UUID-aliased idempotency_keys across remaining storyboard scenarios

Extends the [#4218](https://github.com/adcontextprotocol/adcp/pull/4218) precedent (`measurement_terms_rejected`) to the rest of the suite. 15 storyboard steps across 9 scenarios still shipped hardcoded `idempotency_key` literals on state-mutating tasks (`create_media_buy`, `sync_creatives`, `sync_plans`, `update_media_buy`). The runner shifts dynamic `start_time` substitutions forward to keep buys future-dated, so against a long-running seller deployment those static keys collide cross-run with the same key + a different canonical body, arming the spec-mandated `IDEMPOTENCY_CONFLICT` (or, when the seller's emit shape changed between runs, replaying a now-spec-non-compliant cached payload — the production failure mode that surfaced this).

Switch every remaining literal to `$generate:uuid_v4#<scenario>_<step>` so each storyboard run mints fresh keys and never collides with stale cached state. Affected scenarios: `creative_fate_after_cancellation` (5), `governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery` (3), `invalid_transitions`, `inventory_list_no_match`, `inventory_list_targeting`, `pending_creatives_to_start`.

Closes #4230.
