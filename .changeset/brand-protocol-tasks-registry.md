---
"adcontextprotocol": patch
---

Fix brand-protocol registration in the schema registry index so SDKs auto-generate the tools. The domain now exposes `get_brand_identity`, `get_rights`, `acquire_rights`, and `update_rights` under `tasks.*` (matching every other AdCP domain), with `rights-pricing-option`, `rights-terms`, `creative-approval-request/response`, and `revocation-notification` moved to `supporting-schemas`. Fixes #2245.
