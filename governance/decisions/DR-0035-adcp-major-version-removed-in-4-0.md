---
id: DR-0035
title: adcp_major_version and adcp.major_versions are deprecated through 3.x and removed in 4.0
class: breaking
status: recorded
date: 2026-10-22
decided: ~2026-04
decided_by: maintainer practice (release-precision negotiation, #3493; v4 compatibility checks, #3572)
refs: ["#3493", "#3572", "#8373"]
dissent: none
---

## Decision

The integer request field `adcp_major_version` and the capability field `adcp.major_versions` are **deprecated** in favor of the release-precision `adcp_version` and `adcp.supported_versions`. They are **removed in 4.0**.

- **Through 3.x:** buyers SHOULD send `adcp_version` and SHOULD also send `adcp_major_version` as a mirror. Servers MUST honor `adcp_major_version` when it is the only version field. Sellers MUST keep emitting `adcp.major_versions` alongside `adcp.supported_versions`.
- **In 4.0:** neither field exists. A 4.x buyer sends `adcp_version`, a 4.x seller advertises `adcp.supported_versions`, and a request without `adcp_version` is served the seller's default release.
- A 3.x SDK keeps dual-emitting for its whole support window, including after 4.0 GA. A 4.x SDK emits only `adcp_version`.

## Rationale

Release-precision negotiation is what lets SDKs pick a common release and translate between minors ([DR-0032]). An integer major cannot say which minor a payload is shaped for, so it cannot drive translation. It stays through 3.x only so that 3.0 peers keep working.

## Implications

- This records a decision already stated in the schema (`core/version-envelope.json` marks the field `deprecated` and says "Removed in 4.0"), in `specs/version-negotiation.md` §6, in `docs/reference/versioning.mdx`, and in the `major_versions_removed_in_4_0` check of the v4 compatibility guide.
- The major-only serving rule ([DR-0034], proposed) applies to 3.x only.
- In-house clients that still send only `adcp_major_version` should move to `adcp_version` before 4.0. Under DR-0034 they would otherwise be served the oldest 3.x release.

[DR-0032]: ./DR-0032-sdks-translate-between-releases.md
[DR-0034]: ./DR-0034-major-only-requests-are-served-the-oldest-release.md
