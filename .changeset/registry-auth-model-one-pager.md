---
---

Add `specs/registry-authorization-model.md` — the gating decision artifact
for PR 4b of the property registry unification (#3177). Compares three
options for storing agent → publisher / agent → property authorizations
in the catalog (first-class table, JSONB-only, fact-based), recommends
the first-class `catalog_agent_authorizations` table to mirror
`catalog_identifiers`, and lays out a sequencing for PR 4b-prereq
(schema), PR 4b (writer + reader cutover), and PR 5 (drop legacy).

Spec-only — no code changes.

Refs #3177.
