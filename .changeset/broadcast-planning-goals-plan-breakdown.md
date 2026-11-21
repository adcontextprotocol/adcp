---
"adcontextprotocol": minor
---

Add experimental planning goals and a plan breakdown for scheduled media (radio, linear TV, out-of-home): `media_buy.planning_goals` and `media_buy.plan_breakdown`. Proposal draft in `specs/broadcast-planning-goals-and-plan-breakdown.md`, first shown by iHeartMedia's Harmony planner.

- Goals: `criteria.planning_goals` on `request_proposals` and `revise` refinements carries `budget_mode` (`set` or `suggest`), an `objective` (`max_reach` or `max_efficiency`), a `delivery_target` in GRPs or impressions with a CPP or CPM ceiling, a `max_frequency` with its window, `delivery_rules` (spot-length mix, spots per hour, overbook, daypart-class mix, pacing), `must_include` and `must_exclude` stations, markets and programming formats, and an `audience_basis`.
- Breakdown: proposals carry `plan_breakdown`, headline totals (markets, market audience, estimated audience, average index, GRPs, CPP, impressions, CPM, reach and frequency by window) and allocations by market, station, programming format, daypart, week and spot length, each with budget, spots, impressions, GRPs, CPP, CPM, composition rate and index. `audience_basis` adds the rating `universe` and `index_baseline` beside the forecast's provider and demographic fields.
- Results: each proposal version carries `goal_results`, one `met`, `missed` or `not_supported` entry per goal, so re-optimization through `refine_proposals` states what each draft achieved.

All fields are optional and on open schemas. `get_adcp_capabilities` gains `media_buy.planning_goals` and `media_buy.plan_breakdown`.
