---
"adcontextprotocol": minor
---

spec(versioning): release-precision protocol version negotiation via `adcp_version` envelope field

Adds `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level field on every request and response. Buyers send their release pin; sellers echo the release they actually served — never the seller's own latest release. Augments the existing `adcp_major_version` (integer) with finer precision and adds response-side echo, which the spec lacked.

Composed once via `allOf $ref` to the new `core/version-envelope.json` schema (single source of truth across all 127 task schemas — no inline duplication).

Capabilities response gains `adcp.supported_versions` (release strings, authoritative for negotiation) and `adcp.build_version` (full semver build identifier with optional pre-release and build-metadata per semver §9–§10, advisory only). `VERSION_UNSUPPORTED` error gets a standardized `error.data` shape via the new `error-details/version-unsupported.json` schema; `supported_versions` is required.

Migration: 3.1 SHOULD on both sides → 3.2 MUST on both sides (compliance grader gates non-echo) → 4.0 removes `adcp_major_version`, `adcp.major_versions`, and `extensions.adcp.adcp_version`. Through 3.x, buyers MUST emit both `adcp_version` and `adcp_major_version` so legacy 3.x sellers keep negotiating; if the two disagree at the major level the server returns `VERSION_UNSUPPORTED`.

Fully additive on the wire (existing servers ignore `adcp_version` via `additionalProperties: true`). RFC: `specs/version-negotiation.md`.
