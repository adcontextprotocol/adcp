---
"adcontextprotocol": minor
---

spec(compliance): add `seed_*` values to `ListScenariosSuccess.scenarios` enum

The `comply_test_controller` request schema enumerates five `seed_*` scenarios (`seed_product`, `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`), but the `ListScenariosSuccess` response enum in `comply-test-controller-response.json` did not — so sellers advertising seed-scenario support had no schema-conformant way to report it. Adds the five seed values to the response enum (additive) and updates the `compliance_testing.scenarios` capability reference in `get_adcp_capabilities` to match. Runners and sellers MUST still accept unknown scenario strings for forward-compat.
