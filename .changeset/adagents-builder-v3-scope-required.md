---
---

fix(admin): adagents.json builder always emits a valid v3 scope on each agent.

Previously the builder could produce entries with only `url`, `authorized_for`, and `delegation_type`. v3 requires every `authorized_agents` item to carry an `authorization_type` discriminator plus a non-empty matching selector (`property_ids`, `property_tags`, `inline_properties`, or `publisher_properties`). Russell Stringham flagged this on the #4459 thread.

Changes in `server/public/adagents-builder.html`:

1. `saveAgent` now sets `authorization_type` explicitly based on the radio:
   - "Specific properties" → `property_ids` (requires ≥1 selection; alert otherwise)
   - "Properties by tag" → `property_tags` (requires ≥1 selection; alert otherwise)
   - "All properties" → snapshots every current `state.properties[].property_id` into an explicit `property_ids` list (no implicit "all + future"; help text updated)
2. `updateJsonPreview` drops the legacy fallthrough that emitted `property_ids` without `authorization_type`.
3. `editAgent` reads v3 fields first (`authorization_type` + matching selector) and only falls back to the v2 `property_ids`/`tag:`-prefix shape for legacy imports — auto-upgrading on next save. coversAll detection hardened with Set-based equality.
4. `renderAgents` shows a red "⚠️ Scope not set — open to authorize" tag for stub agents (e.g. those added via the registry picker) so users can't ship invalid output unknowingly. Legacy v2 entries get a "(v2 — re-save to upgrade)" badge.
5. Copy/Download buttons now block via `blockIfAgentsMissScope` when any agent lacks `authorization_type` (catches registry-picker stubs and untouched v2 imports) or when the contact section has fields filled but no name (v3 requires `contact.name`).

Verified:
- All emitted shapes validate against `static/schemas/source/adagents.json` (`property_ids` snapshot, `property_tags` selector).
- Russell's bare `{url, authorized_for, delegation_type}` shape correctly fails v3 validation.
- 89 existing `adagents-manager.test.ts` tests still pass.
