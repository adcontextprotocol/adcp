---
"adcontextprotocol": minor
---

spec(versioning): release-precision protocol version negotiation via `adcp_version` envelope field

Adds `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level field on every request and response. Buyers send their release pin; sellers echo the release they actually served — never the seller's own latest release. Augments the existing `adcp_major_version` (integer) with finer precision and adds response-side echo, which the spec lacked.

Composed once via `allOf $ref` to the new `core/version-envelope.json` schema (single source of truth across all 127 task schemas — no inline duplication).

Capabilities response gains `adcp.supported_versions` (release strings, authoritative for negotiation) and `adcp.build_version` (full semver build identifier with optional pre-release and build-metadata per semver §9–§10, advisory only). `VERSION_UNSUPPORTED` error gets a standardized `error.data` shape via the new `error-details/version-unsupported.json` schema; `supported_versions` is required.

Migration: spec stays SHOULD on both sides through all of 3.x (consistent with the 3.x stability guarantee that fields don't graduate optional → required within a major). The compliance grader carries the adoption pressure: advisory at 3.1, blocking failure at 3.2 for sellers that don't echo `adcp_version` or don't emit `supported_versions` on capabilities. 4.0 promotes the spec to MUST and removes `adcp_major_version`, `adcp.major_versions`, and `extensions.adcp.adcp_version`. Through 3.x, buyers SHOULD dual-emit both `adcp_version` and `adcp_major_version` so legacy 3.x sellers keep negotiating; when the two disagree at the major level the server MUST return `VERSION_UNSUPPORTED`.

Fully additive on the wire (existing servers ignore `adcp_version` via `additionalProperties: true`). RFC: `specs/version-negotiation.md`.

**One scoped behavior change in 17 request schemas:** the `allOf $ref` envelope-composition pattern requires permissive `additionalProperties` at root (draft-07 doesn't bypass parent strict-mode through `allOf`). 17 request schemas under `collection/`, `governance/`, `property/`, and `tmp/` previously declared `additionalProperties: false`; this PR flips them to `true` so the envelope's fields are accepted. Strict request validation returns at draft 2019-09 via `unevaluatedProperties: false` (tracked in #3534). The new lint at `tests/lint-version-envelope.test.cjs` enforces the invariant going forward.
