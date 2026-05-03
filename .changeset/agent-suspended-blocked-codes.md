---
---

spec(errors): register `AGENT_SUSPENDED` / `AGENT_BLOCKED` codes + simplify `agent-permission-denied.json` to non-status provisioning gates only.

Two new error codes for the per-buyer-agent commercial-status axis (sibling to `ACCOUNT_SUSPENDED` / `CAMPAIGN_SUSPENDED`, scoped to the agent-relationship), each `recovery: terminal`. The code itself is the discriminator — no explicit `error.details.scope` field, mirroring `BILLING_NOT_PERMITTED_FOR_AGENT`. Same cross-tenant onboarding oracle clamp and channel-coverage rules established in #3887 apply to the new codes.

`error-details/agent-permission-denied.json` is simplified accordingly: `status: [suspended, blocked]` axis is removed (those states now live on the dedicated codes); only `scope: "agent"` + `reason: "sandbox_only"` remains. `oneOf` exclusivity drops out (single payload axis), `reason` becomes required. The DX-expert "wire-level recovery field ambiguity" gap from #3887 review closes — the suspended/blocked paths now carry `recovery: terminal` directly, no conditional-recovery interpretation needed.

Closes #3871. Builds on #3887 (`agent-permission-denied.json` registration + cross-tenant clamp).

Files:
- `static/schemas/source/enums/error-code.json` — new codes + descriptions + enumMetadata; `PERMISSION_DENIED` description updated to point at new codes for suspended/blocked.
- `static/schemas/source/error-details/agent-permission-denied.json` — `status` field removed, `oneOf` removed, `reason` now required.
- `docs/building/implementation/error-handling.mdx` — Authorization (RBAC) table adds new code rows; Per-Agent Authorization Gate subsection rewritten to cover all three paths (`AGENT_SUSPENDED`, `AGENT_BLOCKED`, `PERMISSION_DENIED + scope:"agent"` + `reason:"sandbox_only"`) under a single uniform clamp.
