---
---

Server: rename `upsertDomainFromWorkos` → `upsertWorkosDomain` to match the existing `removeWorkosDomainAndReselectPrimary` pattern, and document the caller-contract trust assumption (callers must have actual WorkOS provenance — not arbitrary admin scripts). Pin the cross-org `is_primary` upsert edge case in tests. #4159 cleanup.
