---
---

fix(training-agent): declare `account`/`brand` on governance tools so session keying holds across calls (closes #2845)

The `@adcp/client` storyboard runner strips request fields the server's
`tools/list` inputSchema does not declare. `check_governance`,
`report_plan_outcome`, and `get_plan_audit_logs` omitted top-level `account`
and `brand`, so those fields were stripped and `sessionKeyFromArgs` fell back
to `open:default` — a different session from the `open:<brand.domain>` where
`sync_plans` had stored the plan. Result: governance lookups returned
`Plan not found` mid-flow, and the three governance storyboards
(`media_buy_governance_escalation`, `governance_spend_authority`,
`governance_delivery_monitor`) failed their cross-step assertions.

Also adds a `create_media_buy` step to the `governance_delivery_monitor`
storyboard source so `get_media_buy_delivery` operates on a real
`media_buy_id` captured in context rather than the runner's `'unknown'`
fallback. The storyboard-source edit takes effect once `@adcp/client`
republishes its compliance cache; the inputSchema fix in
`governance-handlers.ts` lands immediately and unblocks the escalation and
spend-authority storyboards in CI.
