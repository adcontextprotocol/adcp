---
---

Consolidate ~24 inline UUID-validation regexes into a single `isUuid()` helper at `server/src/utils/uuid.ts`. Fixes two latent bugs where the `/i` flag was missing, causing valid uppercase UUIDs to be rejected:

- `GET /logos/brands/:domain/:id` (brand logo serving)
- `GET /brand/logos/:id` (brand-logos route)
