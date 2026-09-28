---
"adcontextprotocol": patch
---

Fix `creative/get_creative_features_idempotency` storyboard applicability gate. `required_tools` listed four tools (`get_adcp_capabilities`, `get_creative_features`, `get_task_status`, `comply_test_controller`); because the gate is lenient any-of, every creative agent satisfied it via the three universal tools, causing the scenario to run against agents that do not expose `get_creative_features` and fail immediately on `governance.creative_features[0].feature_id`. Narrows `required_tools` to `[get_creative_features]` — the single tool that makes the scenario applicable — and adds `requires: [controller]` so agents without `comply_test_controller` receive a clean whole-storyboard skip at load time rather than a mid-run cascade failure. No step-level behavior changes; all exercised tools remain in their per-step definitions.
