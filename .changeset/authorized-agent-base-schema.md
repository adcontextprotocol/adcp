---
---

refactor(adagents): extract shared `authorized_agents[*]` fields into `core/authorized-agent-base.json`

Closes #4510. Previously deferred because adcp-client's TS codegen (json-schema-to-typescript) produced broken union types on `allOf + $ref` patterns. Unblocked by adcp-client#1756 (PRs #1777 / #1783 shipped a pre-merge pass that flattens `allOf+$ref` siblings before codegen).

**What changes.** Five fields shared across all six `authorized_agents[*]` variants (`url`, `authorized_for`, `signing_keys`, `encryption_keys`, `last_updated`) move into a new `static/schemas/source/core/authorized-agent-base.json`. Each variant now `allOf`s the base alongside its variant-specific properties. Discriminator-specific fields (`authorization_type` const + `property_ids` / `property_tags` / `properties` / `publisher_properties` / `signal_ids` / `signal_tags`) and property-variant qualifiers (`collections`, `placement_ids`, `placement_tags`, `delegation_type`, `exclusive`, `countries`, `effective_from`, `effective_until`) stay at the variant root so the `discriminator: { propertyName: "authorization_type" }` pattern keeps working with audit-oneof.

**No semantic change.** The bundled schema permits the same set of inputs as before. JSON Schema `allOf` merges the base's properties into each variant's instance shape, so validators see identical required-field semantics. Existing files validate unchanged.

**Codegen verified.**

- **Python** (`datamodel-codegen`, used by adcp-client-python): produces clean inheritance — `class AuthorizedAgents1(AuthorizedAgentBase)`, `class AuthorizedAgents2(AuthorizedAgentBase)`, ..., `class AuthorizedAgents6(AuthorizedAgentBase)`. Field duplication across the six variants is eliminated.
- **TypeScript** (`json-schema-to-typescript`, used by adcp-client): the pre-merge pass adcp-client just shipped (adcp-client#1756) handles `allOf+$ref` correctly. Verifying end-to-end after they regenerate against this schema; if regression surfaces, file back against adcp-client.

**Drift prevention.** Adding a new field shared across all six variants now requires touching one schema file instead of six. The `last_updated` field landed in PR #4504 had to be added six times — that's the recurrence this refactor prevents.

**Test coverage.**
- `audit-oneof.mjs --check` ok (no new undiscriminated oneOfs; discriminator still resolves correctly because `authorization_type` const stays at the variant root).
- `composed-schema-validation.test.cjs` 43/43 pass.
- `example-validation.test.cjs` 14/14 adagents-relevant pass (7 pre-existing unrelated failures unchanged).
- Bundled schema build clean; dist outputs include the new `core/authorized-agent-base.json`.
