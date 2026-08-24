---
"adcontextprotocol": minor
---

Add structured reverse-forecast planning input. `criteria.outcome_target` lets a buyer state the outcome they need — a compact goal (a `forecastable-metric` delivery metric or an `event-type` conversion event) plus a desired volume, e.g. "10,000 clicks" — and ask the seller to solve for budget, answering with `total_budget_guidance` on proposals and forecasts whose points carry the goal's key in `metrics`. The goal vocabulary is shared with forecast reporting and package-level optimization goals, so every permitted goal has a defined answer and buyers carry the same metric or event name from plan to buy. Gated by the new `media_buy.outcome_target` capability declaration; sellers that do not declare it reject the field with `UNSUPPORTED_FEATURE` rather than silently ignoring it.
