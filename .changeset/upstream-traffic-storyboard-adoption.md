---
---

feat(compliance): bump @adcp/sdk to 6.7.0 + adopt upstream_traffic on 5 storyboards

`@adcp/sdk@6.7.0` ships runner-side support for the v2.0.0 anti-façade contract from #3816 (`upstream_traffic` check + `capture_path_not_resolvable` synthesized code + forward-compat default for unknown check kinds). Bumping the dep unblocks storyboard adoption that was deferred from #3816 because the published runner errored hard on unrecognized check types.

**SDK bump (`^6.0.0` → `^6.7.0`)** with two integration fixes:
- `server/src/db/compliance-db.ts`: `TrackStatus` extended with `'silent'` to match SDK's enum.
- `server/src/training-agent/v6-brand-platform.ts`: `BrandRightsPlatform` interface added `updateRights` (wired to existing `handleUpdateRights`) and `reviewCreativeApproval` (stubbed with `AdcpError(NOT_IMPLEMENTED)` since training agent doesn't expose a webhook receiver).

**Storyboard adoption** of `upstream_traffic` validations on 5 specialisms (using only v2.0.0 fields the runner supports today — `min_count`, `endpoint_pattern`, `payload_must_contain`, `identifier_paths`, `since`):

- `sales-social`: `sync_audiences` (with `add[]` hashed identifiers + `payload_must_contain` for upstream POST shape) and `log_event` (with `user_match` matching the audience member, exercising identifier echo across two related steps).
- `audience-sync`: `create_audience` with hashed-identifier echo verification.
- `signal-marketplace`: `activate_on_platform` with `since: search_by_spec` window so the assertion is scoped to traffic caused after signal IDs were captured.
- `sales-non-guaranteed`: `create_media_buy` with platform-agnostic POST count assertion (DSPs and SSPs differ widely on campaign-creation endpoints).
- `creative-ad-server`: `build_creative` with platform-agnostic POST count assertion (ad-server vendors differ widely).

**Adopters who don't advertise `query_upstream_traffic`** in `list_scenarios` grade the new validations `not_applicable` per the runner's forward-compat rule — opt-in by adopter capability. The training agent does not yet implement the controller scenario, so all five storyboards run clean against it.

**Out of scope** (deferred until @adcp/sdk ships the rest of the contract surface): the `severity: advisory` + `expires_after_version` features (#3837/#3852) and the `attestation_mode: digest` mode (#3838). 6.7.0 ships the original v2.0.0 contract; subsequent fix-ups land in a later runner release.
