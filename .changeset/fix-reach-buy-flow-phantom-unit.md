---
"adcontextprotocol": patch
---

fix(compliance): replace phantom_unit with devices in reach_buy_flow rejection step

The rejection_unsupported_reach_unit phase was using reach_unit: "phantom_unit", which
is not a valid reach-unit.json enum value. Because the step carries negative_path:
payload_well_formed, the payload must be schema-valid — but phantom_unit caused schema
rejection before the seller's capability-checking logic ran, so the test was passing for
the wrong reason.

Fix: add metric_optimization.supported_metrics: ["reach"] and
supported_reach_units: ["households", "individuals"] to the reach_ctv_q2 product fixture,
replace phantom_unit with "devices" (a valid enum value deliberately absent from the
fixture's declared units), and rename the step id from
create_media_buy_with_phantom_reach_unit to create_media_buy_with_unsupported_reach_unit.
The rejection now comes from the seller's business-logic capability check, which is the
contract the scenario is designed to exercise.

Closes #4819.
