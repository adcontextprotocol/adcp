# Resource-scoped indicators, warnings, and assignment notifications for AdCP 3.2

## Decision requested

Adopt a joined implementation of [#4248](https://github.com/adcontextprotocol/adcp/issues/4248) and the current-state portion of [#6121](https://github.com/adcontextprotocol/adcp/issues/6121):

- structured `warnings[]` on successful canonical commitment/control operations and their 3.x compatibility facades;
- compact current `indicators[]` on `get_media_buys`, with an optional bounded `list_creatives` reverse projection rather than a new task;
- scoped assignment approval mirrored when both read directions are declared; and
- optional `indicators.changed` invalidations, with polling as the baseline and independently optional assignment invalidations and creative-library reverse projections.

This proposal does not introduce indicator IDs, history, lifecycle resources, methodology sub-versions, or a generic apply-recommendation dispatcher.

## Semantic boundary

| Condition | Surface |
|---|---|
| Failed operation | `errors[]` |
| Buyer decision required before success | `input-required` |
| Successful operation with noteworthy context | success `warnings[]` |
| Current material risk or optimization opportunity warranting buyer attention | resource-scoped `indicators[]` |
| Assignment eligibility decision | approval state |
| Resource-local serving gap | defect work in #4586 |
| Blocking/degrading operational condition | impairment or delivery-issue work in #5968 |

A warning is not durable state. If its condition remains current, the seller also projects it onto the applicable authoritative read. This prevents warning-only integrations from degrading into log sinks while preserving the timing value of an immediate success receipt.

An indicator says that the buyer should evaluate and probably address a condition. It is not itself an authorization, executable action, or claim that one universal remedy exists. Buyer products may translate indicators into recommendations, but mutations continue to use their normal AdCP task and governance path.

## Indicator object and catalog

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
media_buys[].indicators[]
└── packages[].indicators[]
    └── creative_approvals[].indicators[]

list_creatives
creatives[].assignments.assigned_packages[].indicators[]
```

The last path is an optional reverse projection of the same package–creative relationship. Every seller exposes the authoritative relationship through `get_media_buys`. A creative-library seller advertises `list_creatives` in `relationship_notifications.projection_tasks`; only then must it include `media_buy_id` and `approval_status` on every reverse assignment row. Relationship identity and approval state agree across projections. Indicator evaluations SHOULD converge, but separate reads may straddle reevaluation and buyers reconcile toward the strictly newer `indicators_as_of`. This bounded projection is useful for discovery but is not a repair task.

Uniform eligibility uses the existing scalar approval. Mixed publisher/placement outcomes use `approval_status: partially_approved` plus a complete, disjoint `approval_scopes[]` partition on both projections. Each normalized `(publisher_domain, optional placement_id)` occurs once. For a publisher, the array uses either one publisher-wide outcome or placement-specific outcomes, never both; there is no implicit override precedence. This avoids both falsely flattening and contradicting "approved on publisher A, rejected on publisher B."

## Evaluation contract

Every present indicator array has:

- `indicator_types_evaluated[]` — exact type coverage;
- `indicators_as_of` — snapshot freshness; and
- optional `indicators_evaluated_scope[]` — publisher/placement coverage.

Omitted `indicators` is unknown. An empty array is clear only for the named types and coverage. Every returned type appears in `indicator_types_evaluated`. Partial scope requires every assertion to carry a contained `scope`; each asserted scope is contained by the evaluated publisher/placement coverage. An unscoped assertion is valid only for whole-resource evaluation. A snapshot contains at most one logical item per `(type, normalized scope set)`.

Snapshots change stored state only when strictly newer. Equal-timestamp conflicts are invalid/no-op. Filter and pagination disappearance never clears state. A direct unfiltered read confirming relationship deletion retires that relationship's keys.

## Query contract

- `list_creatives.filters.indicator_types` selects creatives with a matching assignment indicator.
- `get_media_buys.indicator_types` selects buys with a matching buy, package, or assignment indicator.
- Values use OR logic and combine with other filters using AND.
- `list_creatives.assignment_projection: matching` returns only nested assignments matching `filters.indicator_types`; `assignment_limit` bounds rows per creative at 200.
- `returned_assignment_count`, `matching_assignment_count`, and `assignments_truncated` make nested completeness explicit. Truncated results are discovery-only; `get_media_buys` is the complete repair path.
- Creative field projections preserve the released required envelope: `creative_id`, `name`, `status`, `created_date`, `updated_date`, and exactly one format identity. `fields` limits only optional payload.

## Webhook contract

Sellers may expose indicators through polling alone. Sellers that declare push support accept account-level `notification_configs[]` subscriptions for:

- `indicators.changed`.

`supported_indicator_types` does not require `relationship_notifications`. If a seller declares `indicators.changed`, it also declares the indicator catalog; a seller without a catalog may declare `creative.assignment_changed` alone when it can detect assignment or approval changes, including when it is inline-only. A creative-library seller may independently declare the bounded `list_creatives` reverse projection. `get_media_buys` is always the complete repair task. Declared invalidations are signed; the notification capability requires a usable `webhook_signing` block with `supported: true`, `profile`, `algorithms`, and `legacy_hmac_fallback`. Payloads identify the relationship but never carry authoritative indicator or approval state.

Subscriptions are prospective and do not replay current conditions. After activation/reactivation the buyer establishes a complete baseline through `get_media_buys`, either by enumerating known IDs or by requesting all seven media-buy statuses and following pagination to exhaustion; it does not use `indicator_types`. `indicators.changed` fires for assertion-set changes, evaluation-coverage changes, and deletion of an assignment that retires stored keys. Advancing only `indicators_as_of` does not fire. A material in-place creative update invalidates prior assignment evaluations, emits `change_kind: invalidated`, and omits stale snapshots until reevaluation (or atomically publishes a strictly newer evaluation and fires `updated`). `creative.assignment_changed` fires for assignment addition/removal and assignment approval/reason/scoped-outcome changes. Retried delivery reuses `idempotency_key`; re-emission of the same logical change retains `notification_id`.

## Warning contract

Add `core/warning.json` (`code`, `message`, `affected_resource`, optional seller-specific `details`, `ext`) and `warnings[]` to completed success arms only for:

- `buy_products` and `accept_proposal` through their shared commitment response;
- `control_media_buy`; and
- the `create_media_buy` and `update_media_buy` 3.x compatibility facades, mirroring the canonical operation.

`request_proposals` and `refine_proposals` expose forecasts in proposal state and do not use commitment warnings.

Initial codes:

- `inventory_shortfall_forecast`;
- `flight_change_creates_pacing_risk`; and
- `fields_ignored_due_to_precedence`.

Terminal error and submitted arms reject `warnings`. `sync_creatives` does not receive the new root warning surface in this proposal: the suggested creative-format warning has no durable creative-root readback until the defect contract is standardized. Existing per-item `sync_creatives.creatives[].warnings: string[]` remains a legacy item-local surface and is not expanded here. `sync-creatives-response.json` enforces this exclusion via `not.anyOf` additions on all three response arms; this formally forbids a key that `additionalProperties: true` previously permitted silently — same tightening class as a conditional-required addition, contained to a surface where the key was never defined.

Every warning carries typed `affected_resource` identity. The initial codes target media buys or packages; package warnings include both `media_buy_id` and `package_id`, with compact commitment package IDs coming from `purchase_bindings[]`. Buyers never parse `message` or seller-defined diagnostic values to find the durable readback target. AdCP 3.2 does not standardize portable keys inside `details`.

Durable linkage is capability-gated: `inventory_shortfall_forecast` requires that supported indicator type; `flight_change_creates_pacing_risk` requires `pacing_risk`. `fields_ignored_due_to_precedence` is transaction-relative and requires no durable indicator capability.

## Indicators versus actions

The protocol object remains an `Indicator`; buyer products may present it as a recommendation. Core does not include a generic action union. A provider-native suggested action or deep link may appear in `ext`, but executing any change still uses its normal AdCP task and authorization/governance path.

## Conformance requirements

1. Accept every standard type only at its allowed resource level.
2. Reject an indicator snapshot without `indicator_types_evaluated` or `indicators_as_of`.
3. Reject assertions outside evaluated scope and duplicate logical `(type, normalized scope)` keys.
4. Keep optional reverse assignment projections coherent, including scoped approval state.
5. Accept success-with-warning on canonical commitments/controls and compatibility facades, and reject warnings on terminal or submitted arms.
6. Fire `indicators.changed` on semantic change but not timestamp-only reevaluation.
7. Fire `creative.assignment_changed` for approval changes and assignment deletion when that optional event is declared.
8. Treat subscriptions as prospective, establish a complete all-status or known-ID baseline, dedupe retries, and repair through an unfiltered authoritative `get_media_buys` read.
9. Invalidate assignment evaluations after material in-place creative updates.

The machine-readable vectors in `static/compliance/source/test-vectors/relationship-scoped-indicators.json` cover type/evaluation membership, scope containment, logical-key uniqueness, prospective bootstrap, semantic-change firing, timestamp-only suppression, creative-update invalidation, assignment removal, and delivery identity.

## Explicit non-goals

- Universal scoring or provider score comparison
- Indicator IDs, histories, or independent versions
- `get_indicators`
- Full provider recommendation-type passthrough
- Automatic recommendation execution
- Replacing defects, impairments, or operational delivery issues
