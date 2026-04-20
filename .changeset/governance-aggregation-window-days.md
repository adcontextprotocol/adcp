---
---

spec(governance): fragmentation-defense aggregation window

Adds the `governance.aggregation_window_days` capability (1–365 days,
no schema default — absence = per-commit evaluation only) and a
normative "Aggregated-spend evaluation" section to the campaign
governance specification. Closes the fragmentation attack surface
where a buyer splits a single large spend into many sub-threshold
commits across plans, task types, or delegated sub-agents to bypass
dollar-gated escalations. Governance agents MUST evaluate thresholds
against the trailing-window aggregate keyed on (buyer_agent,
seller_agent, account_id) with the delegating principal as
buyer_agent, include the incoming commit in the sum at evaluation
time, and cover every spend-commit task. The section now includes an
evaluation-semantics formula, a composition note for
reallocation_threshold, and a two-row conformance vector. Buyers MUST
check the capability before relying on a specific window for
compliance.
