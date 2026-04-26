---
---

Writer extension for catalog_agent_authorizations (PR 4b of #3177).
`cacheAdagentsManifest` now projects each `authorized_agents[]` entry
into the catalog table after the property-side projection runs.
Coverage in v1: `property_ids`, `inline_properties`, lexically-anchored
`publisher_properties` (selection_type ∈ {`all`, `by_id`}), and
publisher-wide (no `authorization_type`). Cross-publisher
`publisher_properties` claims, `selection_type='by_tag'`, `property_tags`,
`signal_ids`, and `signal_tags` are deferred per spec — the legacy
`agent_publisher_authorizations` table continues to serve them via the
UNION reader during the dual-read window.

Security guards:
- `agent_url` canonicalization (lowercase + strip trailing slash;
  embedded wildcards rejected; `*` sentinel exact-match only).
- Cross-publisher refusal — a manifest at attacker.example claiming
  `publisher_properties` for victim.example is logged and skipped.
- Each entry in its own savepoint so a malformed entry doesn't lose
  the rest of the manifest.

Reader cutover and snapshot endpoints are out of scope for this PR;
they ship in subsequent PRs.

Refs #3177. Builds on #3274 (schema). Spec #3251.
