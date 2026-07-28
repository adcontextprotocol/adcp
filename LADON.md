# Ladon configuration

## Repo Context

`adcontextprotocol/adcp` is the Ad Context Protocol specification plus the
AgenticAdvertising.org member platform that serves it. The protocol source of
truth is JSON Schema under `static/schemas/source/**`, rendered to Mintlify docs
under `docs/**`, built into immutable versioned artifacts under `dist/**`, and
versioned with Changesets across two active release lines (`main` → the next
minor in beta pre mode, `3.1.x` → stable maintenance patches). The platform is a
TypeScript/Node server (`server/**`) on Fly.io with Postgres, whose migrations
run automatically on startup, and which hosts Addie, an LLM agent with GitHub
and Slack write access. Reviews weigh wire-shape fidelity, schema↔docs
coherence, changeset correctness, and release-artifact immutability above style.

The Working Group's standing engineering bar lives in
`.agents/wg/constitution.md`; recorded precedent lives in
`governance/decisions/`.

### Mandatory: schema ↔ docs coherence

Whenever the diff modifies `static/schemas/source/**`, identify the
corresponding page under `docs/reference/**` and compare the schema change
against what the docs claim. A field renamed, retyped, added to or removed from
`required`, or an enum value changed in schema but not in docs, is spec drift:
`high`. The reverse — docs asserting a wire shape the schema does not encode —
is the same finding.

### Mandatory: changeset scope and type

The published protocol surface is `static/schemas/source/**`, task definitions,
compliance assets, normative reference docs under `docs/reference/**`, release
scripts, and versioned `dist` artifacts.

- A PR touching that surface with no `.changeset/*.md` is `high`. Changesets are
  the AdCP versioning surface; omitting one ships an untracked wire change.
- A `patch` or `minor` changeset shipping a breaking wire change — removed or
  renamed field/tool/enum value, an optional↔required flip on a published field,
  a response-shape change that breaks a buyer/seller agent in production — is
  `high`. Breaking wire changes take `major`.
- A hand-edited `version` in `package.json` is `high`. Versions come from
  Changesets.
- A changeset on an app, site, admin, Addie, newsletter, digest, migration-only,
  deployment, or operational-only PR is out of scope: `medium`.
  `node scripts/check-changeset-protocol-scope.cjs origin/main` is the gate, and
  an empty changeset added to satisfy CI is the wrong fix.

### Mandatory: oneOf discriminator regression

A new undiscriminated `oneOf` under `static/schemas/source/**`, or any change
that makes `node scripts/audit-oneof.mjs --check` fail, is `high`. The baseline
at `scripts/oneof-discriminators.baseline.json` is the ratchet: loosening it, or
bypassing the audit with `--accept-new`, requires an explicit justification in
the PR body — absent that, `high`.

A schema the walker cannot classify but which is correctly disjoint through
mechanisms the walker does not track (`not.anyOf`, `additionalProperties: false`,
transitive `$ref` required) is a known walker limitation, not a defect. Do not
report it.

### Mandatory: released artifacts are immutable

`dist/schemas/<semver>/`, `dist/compliance/<semver>/`, `dist/docs/<semver>/`, and
`dist/protocol/<semver>.*` are append-only release records, including `-beta.N`
and `-rc.N` paths after GA. Modifying, rewriting, or deleting a file inside an
existing semver artifact is `critical` — adopters pin those paths. Only
`dist/*/latest` is mutable development output. A wrong released artifact is
fixed at the source and shipped as a new version, never patched in place.

### Mandatory: `3.1.x` patch eligibility

For a PR based on `3.1.x`, the following are not patch-eligible and are `high`:
new fields, renamed fields, new enum values, new error codes, or any new
normative requirement on a stable schema; renaming or repurposing an existing
conformance-harness step kind; and any transport-layer (MCP, A2A, REST envelope),
auth-profile (RFC 9728, OAuth scopes), or signing-profile (RFC 9421, JWS
algorithms) change. A clarification is patch-eligible only when the prior spec
was demonstrably ambiguous *and* any conformant 3.1.0 implementation would
already satisfy the new MUST. "It's just docs" does not apply to normative docs.

### Mandatory: cite governance precedent

When a PR decides a question of protocol policy or convention rather than
implementation, grep `governance/decisions/` for a controlling record and cite it
by ID (`DR-NNNN`). A PR that contradicts a decision record, without explicitly
superseding it with human ratification on the thread, is spec drift: `high`.

### Hard gate: Breaking-class changes are never auto-approved

Classify every protocol change against the constitution's decision classes.
Editorial and Normative (non-breaking) changes proceed normally. A
Breaking-class change — even a clean one carrying a correct `major` changeset —
is never auto-approved: ratification is a human act. Escalate unless
`review_decision` is `APPROVED`. This applies whether or not the
`breaking-change` label is present.

### Repo conventions

- Naming: the member organization is **AgenticAdvertising.org**; the protocol is
  **AdCP**. "Alliance for Agentic Advertising", "AAO", and "ADCP" are wrong in
  user-facing copy, docs, and prompts: `medium`.
- New examples use fictional companies (Acme Corp, Pinnacle Media, Nova Brands).
  A real brand, agency, or holding-company name introduced in a new example is
  `medium`. Enum values naming an industry standard are protocol terms, not
  examples.
- Recurring characters in docs, certification content, and fixtures come from
  `specs/character-bible.md`. An invented or renamed character is `medium`.
- Migrations under `server/src/db/migrations/**` run automatically on startup in
  production. Judge them as production-facing, not as pending scripts.
- Certification module and exam completion is only reachable through Addie's
  tool calls. A REST route that lets a user self-report a score is `critical`.

## High-Risk Paths

- static/schemas/source/**
- docs/reference/**
- scripts/build-schemas.cjs
- scripts/build-protocol-tarball.cjs
- scripts/audit-oneof.mjs
- scripts/oneof-discriminators.baseline.json
- server/src/db/migrations/**
- server/src/routes/**
- server/src/addie/**
- dist/**

## Gated Paths

These are the paths CODEOWNERS previously protected: agent behavior, all CI, the
protocol source of truth, and release configuration. Ladon may review their
contents, but never auto-approves them.

- .agents/**
- .github/workflows/**
- static/schemas/source/**
- .changeset/config.json
- .changeset/pre.json

## Escalation Reviewers

- bokelley

## Trivial Paths

- .changeset/*.md
- CHANGELOG.md
- package-lock.json
- tests/**
- server/tests/**
- **/*.test.ts
- **/*.test.tsx
- **/*.test.js
- **/*.test.cjs
- **/*.test.mjs
- **/*.spec.ts
- **/*.spec.tsx
- **/*.spec.js

## Release Stack Branches

Matched exactly against the PR head ref. Add an entry when a new release line
opens.

- changeset-release/main
- changeset-release/3.1.x

## Skip Bot Authors

- dependabot[bot]
- renovate[bot]
- github-actions[bot]
