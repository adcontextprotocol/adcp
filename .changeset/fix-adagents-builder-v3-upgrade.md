---
---

fix(admin-tool): upgrade adagents.json builder and AdAgentsManager from v2 to v3 schema, refs #4411

Replaces all hardcoded v2 schema URLs with v3 throughout the `/adagents/builder` tool
and `AdAgentsManager` (suggestion string, `createAdAgentsJson`, `validateProposed`).

Adds the following v3-only fields to the builder UI:
- **Contact section** (collapsible, file-level): name, email, domain, privacy_policy_url, seller_id, tag_id
- **Property features tab** (🏆 Features): inline add/edit form for `property_features[]` — third-party certification agents with feature IDs and optional publisher ID
- **Per-agent v3 constraints** in the agent modal: exclusive, countries (with validation feedback for invalid codes), effective_from, effective_until, encryption_keys (X25519/TMPX, kid + base64url x with client-side validation), signing_keys (flexible JWK JSON textarea)

Import (`importFile`, domain-validation path) fully restores v3 state including contact and property_features.

Collections and placements are deferred to a follow-up PR per expert consensus.
