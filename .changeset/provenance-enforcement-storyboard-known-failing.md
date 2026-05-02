---
---

chore(testing): mark provenance_enforcement storyboard as known-failing pending training-agent implementation

Adds `media_buy_seller/provenance_enforcement` to `KNOWN_FAILING_STORYBOARDS` in `server/tests/manual/run-storyboards.ts`. The storyboard exercises the `PROVENANCE_*` rejection paths and the round-trip of `creative_policy.{provenance_required, provenance_requirements, accepted_verifiers}` through `get_products` / `sync_creatives`, but the training agent has no provenance enforcement yet — the spec is landing in this PR ahead of the reference implementation.

Tracked in #3777; the entry is removed once the training agent enforces provenance per the spec (`get_products` surfacing the seeded `creative_policy` fields and `sync_creatives` emitting the six `PROVENANCE_*` codes for structural rejections).

Non-protocol change; no schema or task definition is affected.
