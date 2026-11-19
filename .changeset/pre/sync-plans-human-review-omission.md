---
"adcontextprotocol": minor
---

Campaign governance (experimental `governance.campaign`): accept an omitted `human_review_required`, and state two `sync_plans` validation rules (adcp#8733, PR 3 of 3). This widens what `sync-plans-request.json` accepts and changes no `plan_hash` rule.

- **Omitted flag.** A plan that declares a regulated policy category (`fair_housing`, `fair_lending`, `fair_employment`, `pharmaceutical_advertising`) or `eu_ai_act_annex_iii`, and omits `human_review_required`, is now schema-valid. The governance agent derives the flag from the plan's resolved policies and policy categories. Before, both `then` branches required the field, so the specification's "sets it automatically" could never apply. An explicit `false` is still rejected by `const: true`.
- **No schema default.** `"default": false` is removed from `human_review_required`. A consumer that applied the default turned a valid omitted field into an explicit `false`, which the schema rejects. Schema `default` annotations are never applied to the `plan_hash` preimage, and a value the governance agent derives is not written into it.
- **Prose.** The specification says the governance agent rejects, not overrides, a caller-supplied `false`. `known-limitations` and the trust page name the field the schema constrains.
- **Flight order.** `flight.end` must be later than `flight.start`, else `INVALID_REQUEST`.
- **Policy ID uniqueness.** An ID must not repeat in `policy_ids`, and a `custom_policies[].policy_id` must not equal an ID in `policy_ids`, else `INVALID_REQUEST`.

The two validation rules are stated in prose and as `x-adcp-validation` annotations. The schema does not enforce them in 3.x; tightening it is deferred to 4.0 (adcp#8756). The plan-hash vector `004b` gains a note that it exercises canonicalization only.
