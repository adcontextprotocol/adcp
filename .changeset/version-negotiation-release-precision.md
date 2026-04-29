---
"adcontextprotocol": minor
---

spec(versioning): release-precision protocol version negotiation via `adcp_version` envelope field

Adds `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level field on every request and response. Buyers send their release pin; sellers echo the release they actually served. Augments the existing `adcp_major_version` (integer) with finer precision and adds response-side echo, which the spec lacked. Capabilities response gains `supported_versions` (release strings, authoritative) and `build_version` (full VERSION.RELEASE.PATCH, advisory). `VERSION_UNSUPPORTED` error gets a standardized `error.data` shape via the new `error-details/version-unsupported.json` schema.

Fully additive — `adcp_major_version` and `adcp.major_versions` deprecated through 3.x, removed in 4.0. RFC: `specs/version-negotiation.md`.
