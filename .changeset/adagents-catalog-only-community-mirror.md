---
"adcontextprotocol": minor
---

adagents.json: allow catalog-only community mirrors (empty `authorized_agents`).

The inline `adagents.json` variant required `authorized_agents` with `minItems: 1`, which made the community-mirror use case the spec itself describes — catalog-only files (e.g. at `creative.adcontextprotocol.org/translated/<platform>/adagents.json`) for platforms that haven't adopted AdCP — impossible to express, since such a mirror has no sales agent to authorize. It is also the exact `authorized_agents: []` shape the SDK's `buildCommunityMirrorAdagents()` emits, which `POST /api/adagents/create` rejected with a 400.

- **Schema:** `authorized_agents` may now be empty (`[]`); `minItems: 1` is dropped. A new content guard requires a file to carry either sales authorization or a non-empty catalog array (`formats`/`properties`/`placements`/`collections`/`signals`), so a file with neither is still invalid. `catalog_etag` remains recommended-not-required at the schema layer (the mirror contract is enforced by the producer/SDK, consistent with "SDK is canon for wire contracts"); the schema only widens what was previously rejected, so every file valid today stays valid.
- **Registry:** `POST /api/adagents/create` and the proposed-file validator accept an empty `authorized_agents` when catalog content is present.
- **Consumer semantics:** an empty `authorized_agents` asserts *no sales authorization* — validators MUST NOT read it as deny-all, authorize-all, or a revocation, MUST NOT treat it as an error, and MUST still consume the catalog arrays.
- The Meta community-mirror example now uses `authorized_agents: []` instead of a fabricated advisory agent.
