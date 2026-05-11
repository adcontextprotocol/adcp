---
---

Adds optional `account` object to `comply_test_controller` request schema with `sandbox: true` const constraint when present. Defense-in-depth on top of the per-request seller-side gate: a runner asserting `sandbox: false` schema-rejects before reaching the seller. Foundation of the (Sandbox) verification tier framing decided in #4379 — closes #3755 (soft-land path); the runner contract MUST set the field, and the follow-up sweep tightens to required once all storyboard sample_requests are updated.
