---
---

Adds integration tests for `POST /api/admin/accounts/:orgId/reset-subscription-state` (#3222). Covers each safety guard (404/400/503), the happy path, and transaction atomicity (UPDATE + audit-log INSERT must commit together; either failure must roll back). Uses supertest + mocked auth/pool/stripe, matching the existing admin-route test pattern.
