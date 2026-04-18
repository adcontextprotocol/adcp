---
---

Upgrade `@adcp/client` to 5.1.0 and retire the AAO's `platform_type` concept in favor of capability-driven compliance selection.

**Why**: 5.1.0 replaces curated platform-type bundles with `get_adcp_capabilities` + specialism-driven storyboard resolution. Agents declare what they implement; the runner picks bundles. The AAO's own `platform_type` input was duplicating that job.

**Breaking (pre-3.0 GA)**:

- `save_agent`, `evaluate_agent_quality`, `compare_media_kit` MCP tools no longer accept `platform_type`. Storyboards auto-select from the agent's `supported_protocols` and `specialisms`.
- `PUT /api/registry/agents/{encodedUrl}/connect` no longer accepts or returns `platform_type`.
- `agent_registry_metadata.platform_type` column dropped (migration 409).
- `RegistryMetadataSchema` no longer exposes `platform_type`.
- `evaluate_agent_quality` output no longer includes the "Platform Coherence" section; coherence checks come from per-track results and advisory observations instead.

**Other changes**:

- `services/storyboards.ts` now reads from the 5.1.0 compliance cache (`loadBundledStoryboards` → `listAllComplianceStoryboards`, `getStoryboardById` → `getComplianceStoryboardById`). Test kits now live at `compliance/cache/{version}/test-kits/`.
- Migration 410 adds `version INTEGER NOT NULL DEFAULT 1` to `adcp_state` so the optimistic-concurrency primitives (`putIfMatch` / `patchWithRetry`) shipped in 5.1.0 work against the Postgres state store.
- Storyboard unit tests rewritten to cover the wrapper contract; upstream catalog content is validated by `@adcp/client`'s own tests.
