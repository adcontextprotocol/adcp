---
---

spec(governance): fragmentation-defense aggregation window

Adds the `governance.aggregation_window_days` capability (1–365 days,
default 30) and a normative "Aggregated-spend evaluation" section to the
campaign governance specification. Closes the fragmentation attack
surface where a buyer splits a single large spend into many
sub-threshold commits across plans or task types to bypass dollar-gated
escalations. Governance agents MUST evaluate thresholds against the
trailing-window aggregate keyed on (buyer_agent, seller_agent,
account_id), and buyers MUST check the capability before relying on a
specific window for compliance.
