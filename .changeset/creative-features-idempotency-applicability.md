---
"adcontextprotocol": patch
---

fix(compliance): scope `creative/get_creative_features_idempotency` to agents that expose `get_creative_features`.

The scenario's `required_tools` listed `get_adcp_capabilities`, `get_task_status`, and `comply_test_controller` alongside `get_creative_features`. Because `required_tools` is an any-of applicability gate, the scenario was selected for every creative agent and failed at capability discovery on agents that do not evaluate creative features. It now lists only `get_creative_features`. Assertions are unchanged.
