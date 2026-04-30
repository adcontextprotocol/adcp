---
---

dashboard(verification-panel): surface the agent owner's actual membership tier inline so the panel gives a deterministic verdict ("your tier (Builder) is eligible") instead of asking the developer to guess ("check that your AAO membership is on an API-access tier"). Implements stage 2 of #3525.

Owner-scoped: tier fields are only populated when the request is authenticated AND the user owns the agent — cross-org viewers and anonymous registry browsers see the unchanged generic copy. Owner check uses the existing `resolveAgentOwnerOrg` helper.

Single source of truth: extracts `API_ACCESS_TIERS` and `ACTIVE_SUBSCRIPTION_STATUSES` to a new `services/membership-tiers.ts` shared by `compliance-heartbeat.ts` (badge issuance gating) and the `/registry/agents/:url/compliance` route (panel rendering). The heartbeat query is parameterized via `= ANY($::text[])` to keep the constant authoritative — adding or removing a tier touches one place. Tier labels for display ("Builder", "Member") also live there.

When the owner is on a non-API-access tier, the panel renders a direct upgrade CTA inline. When eligible, it confirms eligibility so the developer knows the only remaining step is for the heartbeat to run. The auth-not-yet-configured branch also surfaces tier-aware copy so a Builder member sees "your tier is eligible, just need to authorize" instead of the generic eligibility hedge.

12 unit tests for the new helper covering tier enumeration, subscription-status acceptance (`past_due` is intentionally eligible), label fallback for unknown tiers, and the canonical-list contract test that fails if the heartbeat and route ever drift.
