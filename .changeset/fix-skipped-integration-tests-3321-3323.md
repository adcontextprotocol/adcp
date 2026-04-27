---
---

Un-skip 10 integration tests across 4 files (#3321, #3322, #3323):

- join-request-approval.test.ts: add @workos-inc/node class mock + WorkOS env var priming so handlers' new WorkOS() calls see test mocks; un-skip 5 tests
- personal-workspace-restrictions.test.ts: same fix; un-skip 4 tests
- self-service-delete.test.ts: update 404→403 assertion (membership check precedes existence check by design); fix active-subscription test to seed subscription_status='active' in DB rather than mocking stripe-client import
- admin-endpoints.test.ts: same DB-seed fix for active-subscription test
