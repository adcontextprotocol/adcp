---
"adcontextprotocol": patch
---

Register `verify_brand_claim`, `verify_brand_claims` (bulk), and the shared `verification-status.json` enum in `static/schemas/source/index.json`. The tools and schemas shipped in PRs #4540 and #4603 but the central schema registry was missed — this restores parity with `get_brand_identity`, `get_rights`, etc., for any consumer that reads the registry for discovery (closes #4604).
