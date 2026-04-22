---
---

Training-agent unit tests: align with storyboard-driven behavior changes.

- `comply-test-controller.test.ts`: narrowed sandbox gate now allows
  calls when `sandbox` is omitted and when `account` is absent; only
  rejects on explicit `sandbox: false`.
- `training-agent.test.ts`: targeting persistence tests use the spec
  field name `targeting_overlay` on both input and response.
