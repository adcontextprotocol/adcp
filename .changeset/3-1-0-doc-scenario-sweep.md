---
"adcontextprotocol": patch
---

3.1.0 docs + scenario sweep — three remaining small fixes batched ahead of GA (2026-05-29):

- **#4574** Cleanup of stale `list_authorized_properties` references (replaced by `get_adcp_capabilities` portfolio in v3):
  - `static/compliance/source/specialisms/signal-owned/index.yaml` — narrative rewritten to reflect the v3 retirement.
  - `skills/adcp-media-buy/SKILL.md` — table row + dedicated section removed; `get_adcp_capabilities` row updated to mention portfolio surface.
  - `server/src/addie/mcp/adcp-tools.ts` — removed from the ADCP_TASK_REGISTRY map so Addie's MCP routing no longer advertises the retired task.
  - `tests/addie/__snapshots__/adcp-tool-schema-drift.test.ts.snap` — snapshot updated to match.

- **#4713** Surface 3.1 version negotiation in three docs surfaces previously describing the legacy integer-only contract:
  - `docs/reference/whats-new-in-v3.mdx § Per-request version declaration` — leads with release-precision `adcp_version` + `adcp.supported_versions`; legacy `adcp_major_version` retained as backwards-compatible.
  - `docs/building/by-layer/L0/a2a-guide.mdx` and `mcp-guide.mdx` — agent/server card notes updated with release-precision framing and a cross-link to `versioning.mdx § Version negotiation`.

- **#4712** `static/compliance/source/universal/error-compliance.yaml` (phase `version_negotiation`) — added a release-precision `VERSION_UNSUPPORTED` probe (`adcp_version: "99.0"`) as the sibling to the existing integer-only probe. Advisory at 3.1; promotes to required at the 3.2 storyboard cut. Closes the gap where an integer-only validator could pass all storyboards while shipping a broken 3.1 buyer experience.

Three sibling issues closed without code change (already done on main or upstream):
- #4466 — adagents.mdx `authorization_type` is now `(required)` on main.
- #3981 — sponsored-intelligence si_get_offering `context_outputs` path is now `offering.offering_id` on main.
- #3555 — push-notification-config.json `url` description now documents port permissiveness on main.
- #4519 — refine_products scenario `brief` already removed on main.
- #4462 — schema's `ttl_sec` is the required field; the commit cited in the issue body was reverted/never landed.
- #3349 — references `scenarios/signals.js` in adcp-client; spec storyboards already use correct field names.
