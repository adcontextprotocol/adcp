---
---

Post-deploy smoke step that POSTs `tools/list` to each training-agent tenant URL (`/sales`, `/signals`, `/governance`, `/creative`, `/creative-builder`, `/brand`) plus the legacy `/mcp` alias and fails the deploy if any return a non-200/401 status. Closes #3878.

Two recent hotfixes (#3854, #3869) shipped clean through CI but caused production outages because the failure modes were `NODE_ENV=production`-gated: `createInMemoryTaskRegistry` throwing on init, and `noopJwksValidator` throwing under a now-removed prod guard that left every tenant `disabled`. Both surfaced as 404 ("Tenant not registered") or 5xx on per-tenant POSTs — failure modes that happen *before* auth, so an unauthenticated `tools/list` is sufficient to detect them. 401 is treated as healthy (registry resolved, just no token); only 404, 5xx, and timeouts are deploy-fatal.
