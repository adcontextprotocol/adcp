---
"adcontextprotocol": patch
---

spec(errors): register `AGENT_SUSPENDED` / `AGENT_BLOCKED` codes + deprecate `details.status` on `agent-permission-denied.json` (3.0.5 back-compat preserved).

Two new error codes for the per-buyer-agent commercial-status axis (sibling to `ACCOUNT_SUSPENDED` / `CAMPAIGN_SUSPENDED`, scoped to the agent-relationship), both `recovery: terminal`. The code itself is the discriminator — no explicit `error.details.scope` field, no `error.details` payload, mirroring `BILLING_NOT_PERMITTED_FOR_AGENT`'s discriminator-by-code precedent.

`error-details/agent-permission-denied.json` keeps the `status: [suspended, blocked]` axis with `deprecated: true` for back-compat with consumers pinned to the 3.0.5 shape. Sellers SHOULD emit dedicated `AGENT_SUSPENDED` / `AGENT_BLOCKED` codes once these new codes ship; consumers MUST handle either form during the deprecation window — branch on `error.code` first, fall through to `details.status` only when neither dedicated code is emitted. Removal of the `status` axis is scheduled for no earlier than the minor release after the one in which the dedicated codes ship.

Closes the DX-expert "wire-level `recovery: correctable`" gap from #3887 review for the suspended/blocked paths — those paths now carry `recovery: terminal` directly when sellers emit the dedicated codes.

Same cross-tenant onboarding oracle clamp + channel-coverage rules established in #3887 apply to the new codes.

Closes #3871. Builds on #3887.

Files:
- `static/schemas/source/enums/error-code.json` — `AGENT_SUSPENDED` / `AGENT_BLOCKED` enum + descriptions + `enumMetadata.recovery: "terminal"`. `PERMISSION_DENIED` description points at new codes for suspended/blocked and flags `details.status` as deprecated.
- `static/schemas/source/error-details/agent-permission-denied.json` — `status` field annotated `deprecated: true`; `oneOf` exclusivity preserved; description trimmed (deprecation timeline canonical in mdx).
- `docs/building/implementation/error-handling.mdx` — Authorization (RBAC) table adds `AGENT_SUSPENDED` / `AGENT_BLOCKED` rows; Per-Agent Authorization Gate subsection rewritten to cover all three paths under a single uniform clamp + composition-pattern guidance + dispatch example handling both new and back-compat shapes.
