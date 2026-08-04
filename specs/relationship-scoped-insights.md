# Resource-scoped insights, warnings, and assignment notifications for AdCP 3.2

## Decision requested

Adopt a joined implementation of [#4248](https://github.com/adcontextprotocol/adcp/issues/4248) and the current-state portion of [#6121](https://github.com/adcontextprotocol/adcp/issues/6121):

- structured `warnings[]` on successful create/update operations;
- compact current `insights[]` on `get_media_buys`, with an optional bounded `list_creatives` reverse projection rather than a new task;
- scoped assignment approval mirrored when both read directions are declared; and
- mandatory `insights.changed` invalidations, with optional paired assignment invalidations for creative-library sellers.

This proposal does not introduce insight IDs, history, lifecycle resources, methodology sub-versions, or a generic apply-recommendation dispatcher.

## Semantic boundary

| Condition | Surface |
|---|---|
| Failed operation | `errors[]` |
| Buyer decision required before success | `input-required` |
| Successful operation with noteworthy context | success `warnings[]` |
| Persistent seller interpretation | resource-scoped `insights[]` |
| Assignment eligibility decision | approval state |
| Resource-local serving gap | defect work in #4586 |
| Blocking/degrading operational condition | impairment or delivery-issue work in #5968 |

A warning is not durable state. If its condition remains current, the seller also projects it onto the applicable authoritative read. This prevents warning-only integrations from degrading into log sinks while preserving the timing value of an immediate success receipt.

## Insight object and catalog

The compact object remains:

```json
{
  "type": "creative_fatigue",
  "detected_at": "2026-08-03T09:00:00Z",
  "scope": [
    {
      "publisher_domain": "publisher-a.example",
      "placement_id": "feed"
    }
  ],
  "ext": {
    "seller_example": {
      "fatigue_rate": 0.47,
      "window_days": 7
    }
  }
}
```

The seller is the assertion source. Native/relayed/derived methodology, provider label, score, threshold, evidence window, deep link, suggested action, and upstream attribution belong in namespaced `ext`.

3.2 standardizes seven broad types:

| Type | Placement |
|---|---|
| `creative_fatigue` | Package–creative assignment |
| `creative_quality_opportunity` | Package–creative assignment |
| `creative_diversity_low` | Package |
| `audience_saturation` | Package |
| `inventory_shortfall_forecast` | Package |
| `pacing_risk` | Package |
| `budget_constrained` | Media buy or package |

The enum descriptions define normative broad meanings. Different sellers are not assumed to use comparable algorithms or scores.

## Placement and reverse projection

```text
get_media_buys
media_buys[].insights[]
└── packages[].insights[]
    └── creative_approvals[].insights[]

list_creatives
creatives[].assignments.assigned_packages[].insights[]
```

The last two paths are optional reverse projections of the same package–creative relationship. Every insight-capable seller exposes the authoritative relationship through `get_media_buys`. A creative-library seller advertises `list_creatives` in `insight_notifications.repair_tasks`; only then must it include `media_buy_id` and `approval_status` on every reverse assignment row and keep both projections coherent.

Uniform eligibility uses the existing scalar approval. Mixed publisher/placement outcomes use `approval_status: partially_approved` plus a complete, disjoint `approval_scopes[]` partition on both projections. Each normalized `(publisher_domain, optional placement_id)` occurs once. For a publisher, the array uses either one publisher-wide outcome or placement-specific outcomes, never both; there is no implicit override precedence. This avoids both falsely flattening and contradicting “approved on publisher A, rejected on publisher B.”

## Evaluation contract

Every present insight array has:

- `insight_types_evaluated[]` — exact type coverage;
- `insights_as_of` — snapshot freshness; and
- optional `insights_evaluated_scope[]` — publisher/placement coverage.

Omitted `insights` is unknown. An empty array is clear only for the named types and coverage. Every returned type appears in `insight_types_evaluated`. Partial scope requires every assertion to carry a contained `scope`; each asserted scope is contained by the evaluated publisher/placement coverage. An unscoped assertion is valid only for whole-resource evaluation. A snapshot contains at most one logical item per `(type, normalized scope set)`.

Snapshots change stored state only when strictly newer. Equal-timestamp conflicts are invalid/no-op. Filter and pagination disappearance never clears state. A direct unfiltered read confirming relationship deletion retires that relationship's keys.

## Query contract

- `list_creatives.filters.insight_types` selects creatives with a matching assignment insight.
- `get_media_buys.insight_types` selects buys with a matching buy, package, or assignment insight.
- Values use OR logic and combine with other filters using AND.
- `list_creatives.assignment_projection: matching` returns only nested assignments matching `filters.insight_types`; `assignment_limit` bounds rows per creative at 200.
- `returned_assignment_count`, `matching_assignment_count`, and `assignments_truncated` make nested completeness explicit. Truncated results are discovery-only; `get_media_buys` is the complete repair path.
- Sparse creative responses require only `creative_id`; other requested fields are optional by construction.

## Webhook contract

All insight-capable sellers accept account-level `notification_configs[]` subscriptions for:

- `insights.changed`.

Creative-library sellers additionally accept `creative.assignment_changed` and pair it with the `list_creatives` repair task. Inline-only sellers declare only `insights.changed` and `get_media_buys`. These are signed invalidations. Declaring the capability requires `webhook_signing.supported: true`. Payloads identify the relationship but never carry authoritative insight or approval state.

Subscriptions are prospective and do not replay current conditions. After activation/reactivation the buyer performs an unfiltered baseline read. `insights.changed` fires for assertion-set changes, evaluation-coverage changes, and deletion of an assignment that retires stored keys. Advancing only `insights_as_of` does not fire. A material in-place creative update invalidates prior assignment evaluations, emits `change_kind: invalidated`, and omits stale snapshots until reevaluation (or atomically publishes a strictly newer evaluation and fires `updated`). `creative.assignment_changed` fires for assignment addition/removal and assignment approval/reason/scoped-outcome changes. Retried delivery reuses `idempotency_key`; re-emission of the same logical change retains `notification_id`.

## Warning contract

Add `core/warning.json` (`code`, `message`, `affected_resource`, optional `details`, `ext`) and `warnings[]` to synchronous success arms only for:

- `create_media_buy`;
- `update_media_buy`.

Initial codes:

- `inventory_shortfall_forecast`;
- `flight_change_creates_pacing_risk`; and
- `fields_ignored_due_to_precedence`.

Terminal error and submitted arms reject `warnings`. `sync_creatives` does not receive the new root warning surface in this proposal: the suggested creative-format warning has no durable creative-root readback until the defect contract is standardized. Existing per-item `sync_creatives.creatives[].warnings: string[]` remains a legacy item-local surface and is not expanded here.

Every warning carries typed `affected_resource` identity. The initial codes target media buys or packages; package warnings include both `media_buy_id` and `package_id`. Buyers never parse `message` or seller-defined diagnostic values to find the durable readback target.

Durable linkage is capability-gated: `inventory_shortfall_forecast` requires that supported insight type; `flight_change_creates_pacing_risk` requires `pacing_risk`. `fields_ignored_due_to_precedence` is transaction-relative and requires no durable insight capability.

## Recommendations and actions

The protocol object remains an `Insight`; buyer products may present it as a recommendation. Core does not include a generic action union. A provider-native suggested action or deep link may appear in `ext`, but executing any change still uses its normal AdCP task and authorization/governance path.

## Conformance requirements

1. Accept every standard type only at its allowed resource level.
2. Reject an insight snapshot without `insight_types_evaluated` or `insights_as_of`.
3. Reject assertions outside evaluated scope and duplicate logical `(type, normalized scope)` keys.
4. Keep optional reverse assignment projections coherent, including scoped approval state.
5. Accept success-with-warning and reject warnings on terminal or submitted arms.
6. Fire `insights.changed` on semantic change but not timestamp-only reevaluation.
7. Fire `creative.assignment_changed` for approval changes and assignment deletion when that optional event is declared.
8. Treat subscriptions as prospective, establish a baseline read, dedupe retries, and repair through an unfiltered authoritative read.
9. Invalidate assignment evaluations after material in-place creative updates.

The machine-readable vectors in `static/compliance/source/test-vectors/relationship-scoped-insights.json` cover type/evaluation membership, scope containment, logical-key uniqueness, prospective bootstrap, semantic-change firing, timestamp-only suppression, creative-update invalidation, assignment removal, and delivery identity.

## Explicit non-goals

- Universal scoring or provider score comparison
- Insight IDs, histories, or independent versions
- `get_insights`
- Full provider recommendation-type passthrough
- Automatic recommendation execution
- Replacing defects, impairments, or operational delivery issues
