---
---

Switch the `stripe-client` `vi.mock` factories in `content-my-content.test.ts` and `admin-endpoints.test.ts` to vitest's `importOriginal` pattern so unmocked exports (e.g. `listCustomersWithOrgIds` called from `OrganizationDatabase.syncStripeCustomers` during `HTTPServer.start`) flow through automatically and stop breaking integration tests.
