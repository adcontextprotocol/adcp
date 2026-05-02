---
---

Hotfix #2 for the multi-tenant migration. After #3854 fixed the registry-init crash (postgres task registry), production still returned 404 `Tenant 'signals' is not registered` on per-tenant POSTs. Cause: a `NODE_ENV=production`-gated guard in `noopJwksValidator` (added in the round-1 review fixes) threw at validation time, marking every tenant `disabled`, so `resolveByRequest` returned null for every lookup.

The guard was overprotective for our deployment. Reviewers added it on the theory that an adopter might accidentally import the no-op into a production registry that should be enforcing JWKS validation — but the only consumer of this file is the training agent's production deployment, which uses the no-op by design (brand.json is mounted at `/api/training-agent/.well-known/brand.json`, not host root, so the SDK's default validator can't reach it). Removing the guard.
