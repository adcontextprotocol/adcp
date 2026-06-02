---
"adcp": minor
---

Add published-post reference creatives as a canonical-format refinement, not a new task surface or format family.

- Adds `published_post` as an asset payload type and canonical slot asset type.
- Adds `publisher_owned_reference` to canonical `asset_source` where a product resolves an existing post instead of accepting uploaded bytes.
- Adds `CreativeStatus: "suspended"` plus authorization/source reason codes so recoverable published-post dependency loss is distinct from policy rejection.
- Adds `AUTHORIZATION_REQUIRED` for authenticated calls that need additional creator, identity, or post authorization before serving.
- Documents the canonical `video_hosted` published-post pattern and keeps catalog-driven retail media on `sponsored_placement`.
