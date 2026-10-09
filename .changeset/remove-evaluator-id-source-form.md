---
"adcontextprotocol": minor
---

Remove the `evaluator_id` source form from the experimental `evaluator` object on `build_creative` (`creative.evaluator`) and withdraw the `list_evaluators` follow-on (#5241). Evaluator sources are now inline `exemplars` or an allowlisted `agent_url`; a seller's house evaluator is an evaluator agent it lists in `creative_policy.accepted_verifiers[]`. The `evaluator` x-entity type is removed and the `evaluator_auth` compliance scenario (now 1.0.4) no longer uses `evaluator_id`.

## Migration

This breaks an experimental surface (`x-status: experimental`, feature id `creative.evaluator`), which the experimental-status contract allows with notice. The 6-week pre-landing notice is waived: beta.0 is the notice vehicle, and GA ships no earlier than 6 weeks after the beta.0 tag. 3.1 and 3.2 keep `evaluator_id`.

The bump is `minor`, not the patch that `versioning.mdx` assigns to experimental-only changes, because the removal changes the `build_creative` request payload and `.agents/playbook.md` ships breaking experimental changes in the next minor. No alias is offered: the id had no on-wire resolution path, and an unknown id already degraded to seller-default ranking.

An `evaluator` carrying only `evaluator_id` no longer validates. A stale `evaluator_id` alongside `exemplars` or `agent_url` still validates and is ignored.

Before:

```json
{ "evaluator": { "evaluator_id": "quality-default", "rank_by": [{ "feature_id": "creative_quality_score" }] } }
```

After (the seller lists the evaluator agent in `creative_policy.accepted_verifiers[]`):

```json
{ "evaluator": { "agent_url": "https://quality-evaluator.example/adcp", "rank_by": [{ "feature_id": "creative_quality_score" }] } }
```
