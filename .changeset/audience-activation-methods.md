---
"adcontextprotocol": minor
---

Add audience activation method declarations (#4324). Products declare how buyer audience data can reach them via `audience_activation.methods` — `sync_audiences`, `tmp_identity_match`, `file_transfer`, `dataset_query`, `clean_room`, or `platform_distribution` — with vendor identity as a BrandRef domain. The seller-level union surfaces as `media_buy.audience_targeting.supported_activation_methods` in `get_adcp_capabilities` for fast-fail discovery, and buyers filter products with `filters.audience_activation_methods` (OR across entries, AND within an entry, omitted fields as wildcards). Dataset entries may publish `consumer_identities[]` (cloud/region-qualified principals to grant); grant-based paths are in-protocol only when the vendor flow is grantee-identified.
