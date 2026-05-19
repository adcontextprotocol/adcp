---
"adcontextprotocol": patch
---

fix(compliance): replace phantom_unit with devices in reach_buy_flow rejection step

The rejection_unsupported_reach_unit phase was using reach_unit: "phantom_unit", which
is not a valid reach-unit.json enum value. Because the step carries negative_path:
payload_well_formed, the payload must be schema-valid — but phantom_unit caused schema
rejection before the seller's capability-checking logic ran, so the test was passing for
the wrong reason.

Fix: add metric_optimization.supported_reach_units: ["households", "individuals"] to the
reach_ctv_q2 product fixture and replace phantom_unit with "devices" (a valid enum value
deliberately absent from the fixture's declared units). The rejection now comes from the
seller's business-logic capability check, which is the contract the scenario is designed
to exercise.
