---
"adcontextprotocol": minor
---

spec(errors): register `AGENT_SUSPENDED` / `AGENT_BLOCKED` codes + consolidate the 3.0.5 `details.status` placeholder.

Two new error codes for the per-buyer-agent commercial-status axis (sibling to `ACCOUNT_SUSPENDED` / `CAMPAIGN_SUSPENDED`, scoped to the agent-relationship), both `recovery: terminal`. The code itself is the discriminator — no `error.details.scope` field, no `error.details` payload — mirroring `BILLING_NOT_PERMITTED_FOR_AGENT`'s discriminator-by-code precedent.

3.0.5 shipped `error-details/agent-permission-denied.json` with a `details.status: ["suspended", "blocked"]` axis as a placeholder while the dedicated codes were being designed. 3.1 consolidates the placeholder: the `status` field is removed from the schema; sellers MUST emit `AGENT_SUSPENDED` / `AGENT_BLOCKED` directly. The schema's `agent-permission-denied.json` now carries only `scope: "agent"` + `reason: "sandbox_only"` for non-status per-agent provisioning gates. `oneOf` exclusivity drops out (single payload axis), `reason` becomes required.

Migration: sellers that integrated against the 3.0.5 placeholder shape MUST switch to the dedicated codes. The known adopter (JS SDK BuyerAgentRegistry, [adcp-client#1269](https://github.com/adcontextprotocol/adcp-client/issues/1269)) is in Phase 1 placeholder mode, not production — the consolidation is intentional and is the reason 3.1 is the right release for it. The DX-expert "wire-level recovery field ambiguity" gap from #3887 review closes for the suspended/blocked paths — those paths now carry `recovery: terminal` directly at the wire level.

Same cross-tenant onboarding oracle clamp + channel-coverage rules established in #3887 apply uniformly to the new codes.

Closes #3871. Builds on #3887.

Files:
- `static/schemas/source/enums/error-code.json` — `AGENT_SUSPENDED` / `AGENT_BLOCKED` enum + descriptions + `enumMetadata.recovery: "terminal"`. `PERMISSION_DENIED` description points at the new codes for suspended/blocked.
- `static/schemas/source/error-details/agent-permission-denied.json` — `status` field removed, `oneOf` removed, `reason` required.
- `docs/building/implementation/error-handling.mdx` — Authorization (RBAC) table adds `AGENT_SUSPENDED` / `AGENT_BLOCKED` rows. Per-Agent Authorization Gate subsection rewritten to cover all three paths (`AGENT_SUSPENDED`, `AGENT_BLOCKED`, `PERMISSION_DENIED + scope:"agent" + reason:"sandbox_only"`) under a single uniform clamp + composition-pattern guidance + 3.0.5 → 3.1 migration note.
