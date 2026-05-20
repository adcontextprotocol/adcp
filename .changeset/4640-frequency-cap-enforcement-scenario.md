---
"adcontextprotocol": minor
---

feat(compliance): frequency_cap_enforcement capability-gated scenario

New scenario in the capability-claim contract pattern (#4637), added to `sales-non-guaranteed.requires_scenarios`:

- `media_buy_seller/frequency_cap_enforcement` — gated on `media_buy.frequency_capping` presence (#4640 / #4670). Certifies that a seller advertising frequency_capping accepts a package-level `frequency_cap` (cap-form: `max_impressions` + `per` + `window`) on `create_media_buy` and, after simulated delivery, reports `totals.reach` + `totals.frequency` on `get_media_buy_delivery` with the observed frequency at-or-below the requested cap. Cap-form is the assertion target because it declares the numeric ceiling whose enforcement this scenario verifies; cooldown-form `suppress` is a separate semantic and not exercised here.

Runtime-enforcement scenario — structurally simpler than the goal-mode scenarios (audience_buy_flow, performance_buy_flow). No rejection arm: `frequency_cap` is a numeric constraint, not a pointer to a registered resource, so there is no unbound-id analogue to reject against. The discriminating assertion is the observed frequency in delivery totals — a seller that silently drops the cap would deliver to its natural frequency distribution and overshoot.

The observed-frequency-within-cap assertion uses `field_less_than` with a literal `value: 3.01` against a `max_impressions: 3` cap. The storyboard-schema check enum exposes `field_less_than` (strict less-than) as the only single-step numeric-comparison matcher today; a native `<=` / `field_at_most` matcher does not exist. The 0.01 epsilon lets the assertion target the cap literal without rejecting honest sellers that report frequency at exactly 3.0. A runner extension adding `field_at_most` (storyboard schema + runner update) would let this drop to `value: 3` without the epsilon — captured here as a soft follow-up; the cap-enforcement signal is already discriminating without it.

No training-agent changes — the training agent does not declare `frequency_capping` today, so the scenario grades `not_applicable` against the reference implementation and CI passes. Same anti-façade pattern as the other capability-gated scenarios: the bit gates the scenario, the assertion targets the runtime behavior that the bit commits to.

Refs: #4637 (capability-claim meta), #4640 (capability bit), #4670 (frequency_capping shipping PR).
