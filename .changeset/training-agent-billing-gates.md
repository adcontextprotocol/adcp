---
---

feat(training-agent): implement BILLING_NOT_SUPPORTED + BILLING_NOT_PERMITTED_FOR_AGENT gates

Reference implementation of the two billing gates from the spec contract landed in #3831 (BuyerAgentRegistry support). Lands first on the legacy `/mcp` route via `handleSyncAccounts`; v6 per-tenant routes (`/api/training-agent/<tenant>/mcp`) currently expose no `accounts.upsert`, so wiring the gates onto v6 follows in a separate PR.

**Capability gate (`BILLING_NOT_SUPPORTED`).** `handleSyncAccounts` now validates `input.billing` against a `SUPPORTED_BILLINGS` constant and returns the canonical error shape per `error-details/billing-not-supported.json` — `error.details.scope: "capability"` plus an echoed `error.details.supported_billing` list. Also fixes a stale advertisement: the legacy `/mcp` route was advertising `supported_billing: ['agent']` while the handler accepted any of the three values; both surfaces now agree on `['agent', 'operator', 'advertiser']`.

**Per-buyer-agent gate (`BILLING_NOT_PERMITTED_FOR_AGENT`).** New `commercial-relationships.ts` module maps the authenticated `principal` (set by the bearer authenticator in `index.ts`) to a commercial-relationship enum: `passthrough_only` (no payments relationship; only `operator` billing permitted) or `agent_billable` (any supported billing permitted). Two demo bearer prefixes recognized:

- `demo-billing-passthrough-*` → `passthrough_only` — used by storyboard test kits to exercise the per-agent gate.
- `demo-billing-agent-billable-*` → `agent_billable` — explicit positive-control principal so storyboards can assert the gate does NOT fire on agents with payments relationships.

Both prefixes match the existing `DEMO_TEST_KIT_KEY_PATTERN` in `index.ts`, so no authenticator changes are needed — any token matching the `demo-*` prefix family is accepted, and the principal carries the bearer token verbatim.

The gate emits `error.details.rejected_billing` (echo) plus `error.details.suggested_billing: "operator"` per the clamped shape in `error-details/billing-not-permitted-for-agent.json` (`additionalProperties: false`). Tests assert the negative-shape clamp: `permitted_billing`, `rate_card`, `payment_terms`, `credit_limit`, `billing_entity` are all explicitly absent — no per-agent commercial state leaks through error.details.

**Uniform-response rule.** Principals not matching either prefix return `undefined` from `getCommercialRelationship`, falling through to the seller-wide capability gate only. This is the spec's bright line for `BILLING_NOT_PERMITTED_FOR_AGENT` — emit only when agent identity AND a commercial-relationship record both exist, so the per-agent code does not act as an onboarding oracle for unrecognized callers. Test asserts that a recognized-but-non-passthrough principal (e.g., `static:primary`) gets `billing: "agent"` accepted normally.

**Tests.** Six new tests in `server/tests/unit/account-handlers.test.ts` cover capability-gate rejection (negative case), passthrough-only rejection of `agent` and `advertiser`, autonomous recovery via `operator`, agent-billable acceptance of all three values, and the uniform-response rule for unrecognized principals. All 19 sync_accounts tests pass.

**Follow-ups (separate PRs):**

1. Wire `accounts.upsert` on v6 platforms so `sync_accounts` is exposed at `/api/training-agent/<tenant>/mcp` and the gates flow through there too.
2. Storyboard test kit declaring `commercial_relationship: passthrough_only` against the training-agent endpoint — unblocks #3839 (currently draft, waiting on this implementation).
3. Align v6 platform `supportedBillings` declarations across tenants so a runner can compare wire `supported_billing` to handler-enforced gate consistently.
