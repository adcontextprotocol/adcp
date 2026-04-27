---
---

Introduce `negative_path` attribute for storyboard steps to distinguish `schema_invalid` (skip lint, default) from `payload_well_formed` (schema-valid payload, validate anyway) negative-path tests. Renames the value `business_rule` → `payload_well_formed` across 26 storyboard steps, the lint predicate, and the schema doc — the new name is broader (covers auth failures + state conflicts + governance denials, not just business rules). Also adds governance checking to `handleActivateSignal` in the training agent so the `signal_marketplace/governance_denied` storyboard passes CI when governance plans are registered, and adds a `sample_response` fixture to the `activate_signal_denied` step. Implements #2824.
