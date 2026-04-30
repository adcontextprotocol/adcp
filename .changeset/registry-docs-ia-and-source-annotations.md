---
---

Registry API docs IA cleanup. Renames the `Lookups & Authorization` tag to `Authorization Lookups` so the Mintlify-generated docs URL stops slugifying the `&` into `%26` (which made `/operator-lookup` and friends unsearchable and unshareable). Adds OpenAPI descriptions on `source`, `discovered_from`, `member` so consumers can tell registered vs discovered agents apart without reading the source. Adds an auth-aware note on `/api/registry/operator` explaining that authenticated callers see `members_only` agents and profile owners see `private` agents — the primary value story for AAO membership at the API surface. Refs #3538.
