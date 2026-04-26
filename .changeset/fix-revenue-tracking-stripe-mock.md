---
---

Un-skip revenue-tracking integration tests by adding a fuller stripe-client mock.

Adds `vi.hoisted` + `vi.mock('stripe-client')` following the pattern from
`admin-sync-revenue-backfill.test.ts` (#3313). The webhook route guard requires
both `stripe` and `STRIPE_WEBHOOK_SECRET` to be non-null; the mock satisfies both.
Removes stale dead-code in `beforeAll` that attempted to patch the live stripe object
at runtime (which was a no-op since `stripe` was `null` in tests).

Refs #3318. Part of #3289 integration-test restoration.
