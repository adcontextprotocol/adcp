---
---

Test-only: route-level integration coverage for the `verdict_source` owner-scope gate on `GET /api/registry/agents/:url/compliance`. Pins the contract that anonymous and cross-org callers see `null`/`false` on every owner-only field while the response shape stays identical, and that owner callers (including Explorer-tier orgs where `is_api_access_tier=false`) still see `verdict_source` populated. Closes #4378.
