# Compact Performance Feedback and Measurement-Agent Interchange

**Status:** Draft for working-group review

**Related:** [#4296](https://github.com/adcontextprotocol/adcp/issues/4296), [#6209](https://github.com/adcontextprotocol/adcp/issues/6209)

## Decision summary

AdCP should make measurement providers first-class producers of performance
feedback without becoming a universal transport for measurement data.

The proposed contract has five parts:

1. Preserve the existing one-assertion `provide_performance_feedback` task.
2. Add only the semantics needed to interpret the index: baseline, metric,
   producer, provider-scoped methodology, compact evidence, and maturation.
3. Make the buyer orchestrator the measurement gateway. In the first tier it
   exposes approved delivery through `get_media_buy_delivery` and authenticates
   provider output through `provide_performance_feedback`.
4. Defer webhook and offline interchange until AdCP defines their registration,
   credential, payload, and receipt contracts.
5. Let only the orchestrator share normalized feedback with sellers, preserving
   common cohort definitions, seller-local ID mapping, and buyer control.

This is intentionally smaller than the earlier proposal. It does not add
batching, a dimension-subject union, an experiment schema, a universal
methodology enum, a measurement-data ingestion task, or a new authorization
scope.

## Why this matters

The seller-to-buyer reporting surface is rich, but buyer-to-seller feedback is
currently a normalized number with an implicit baseline. A seller receiving
`performance_index: 1.35` cannot tell whether `1.0` means a campaign target,
control group, buyer portfolio, or market benchmark.

At the same time, measurement providers have no obvious operational role in
the feedback loop. AdCP already gives them identity and discovery:

- `brand.json` supports agents with `type: "measurement"`;
- `get_adcp_capabilities.measurement.metrics[]` publishes their metric catalog;
- products and committed metrics reference them by BrandRef.

What is missing is a narrow way for their outputs to become actionable across
sellers. The answer is not to force every provider to ingest reporting through
AdCP. The measurement ecosystem already has established integrations, and many
results are calculated offline. The interoperable boundary should be the
optimizer-ready output.

## Design principles

1. **One assertion per call.** Batching is transport efficiency, not a semantic
   requirement. It can be added after adoption warrants partial-acceptance
   complexity.
2. **Name the baseline.** A normalized index without its reference point is not
   interoperable.
3. **Reuse metric identity.** Standard and vendor metrics use the same
   `(scope, metric_id, qualifier)` shape already used by committed and reported
   metrics.
4. **Authenticate the producer at the gateway.** A payload field cannot
   override measurement-provider identity. Sellers authenticate the
   orchestrator, not every upstream provider.
5. **Provider-scoped methodology.** Methodology names are open strings anchored
   to the producer, not a universal AdCP taxonomy.
6. **Carry evidence summaries, not studies.** Keep large datasets, model
   coefficients, identity paths, and full reports with the provider.
7. **Receipt is not application.** `accepted` is never presented as proof that
   the optimizer used the signal.
8. **The orchestrator owns interchange.** It authorizes provider access to the
   gateway tasks, maps identifiers, and decides what each seller sees.

## Proposed request

```json
{
  "idempotency_key": "measurement-study-42-july-final",
  "media_buy_id": "mb_123",
  "package_id": "pkg_streaming_video",
  "measurement_period": {
    "start": "2026-07-01T00:00:00Z",
    "end": "2026-07-31T23:59:59Z"
  },
  "metric": {
    "scope": "standard",
    "metric_id": "conversion_value",
    "qualifier": {
      "attribution_methodology": "modeled"
    }
  },
  "performance_index": 1.35,
  "baseline": "control_group",
  "producer": {
    "domain": "measurement.example"
  },
  "methodology": "geo_incrementality",
  "methodology_version": "2026-07",
  "study_ref": "study_42",
  "evidence": {
    "sample_size": 14820,
    "confidence_interval": {
      "lower": 1.18,
      "upper": 1.49,
      "level": 0.95
    }
  },
  "evidence_ref": "https://measurement.example/results/study_42",
  "as_of": "2026-08-04T12:00:00Z",
  "final": true
}
```

### Existing required fields

- `idempotency_key`
- `media_buy_id`
- `measurement_period`
- `performance_index`

All existing 3.x requests remain valid.

### Baseline

Compact-contract producers populate one enum:

- `campaign_target`
- `control_group`
- `seller_history`
- `buyer_portfolio`
- `market_benchmark`
- `other`

`performance_index = 1.0` means equality with this baseline. For ratio metrics,
higher-is-better measures use observed divided by baseline; lower-is-better
measures such as CPA use baseline divided by observed. In both cases values
above 1.0 mean better performance. The raw baseline value need not be disclosed.

`baseline` remains schema-optional during 3.x compatibility because the task
already accepts requests without it. Sellers declaring the new capability may
enforce it for compact-contract callers.

### Scope

The initial contract keeps the existing scope fields:

- no narrowing field: media-buy level;
- `package_id`: package level;
- `creative_id`: creative level.

It does not copy placement, audience, geography, property, keyword, catalog,
device, and future reporting dimensions into a discriminated union. If adopters
need arbitrary dimensional feedback, delivery reporting should eventually emit
an opaque stable key that feedback can echo. That keeps dimension semantics in
one protocol surface.

### Metric

Standard metric:

```json
{
  "scope": "standard",
  "metric_id": "roas"
}
```

Vendor metric:

```json
{
  "scope": "vendor",
  "vendor": {
    "domain": "attentionvendor.example"
  },
  "metric_id": "attention_units"
}
```

The nested vendor defines the metric. It may differ from the top-level producer
that created this assertion.

Legacy `metric_type` remains accepted and deprecated. When both are present,
`metric` wins.

### Producer

`producer` is a BrandRef.

- On the provider-to-orchestrator hop, authenticated provider identity is
  authoritative and must match `producer`.
- On the orchestrator-to-seller hop, `producer` preserves analytical
  provenance while the authenticated orchestrator remains responsible for the
  submission. The provider never needs a seller credential.
- The previously documented `vendor` field remains as a deprecated alias so
  existing clients are not stranded.

### Methodology and study reference

`methodology` and `methodology_version` are provider-scoped strings. Examples
include `geo_incrementality`, `media_mix_model`, and
`deterministic_attribution`.

They intentionally do not use a shared enum. The producer's capability catalog
and methodology documentation define the term.

`study_ref` is opaque correlation metadata. It never instructs the seller to
construct experiment arms or assign holdouts. Cross-seller studies require the
buyer or its measurement partner to define cohorts once and express them to
each seller through ordinary audience and geographic targeting.

This is why [#6209](https://github.com/adcontextprotocol/adcp/issues/6209) was
closed as not planned.

### Evidence

The inline evidence vocabulary is deliberately limited to:

- `sample_size`
- `confidence_interval { lower, upper, level }`

`evidence_ref` points to the provider-hosted detail under the provider's access
controls. Portable attestation references can be added through the shared
attestation primitive when it lands; feedback must not create a custom
signature envelope.

### Maturation and revision

- `as_of`: when the assertion was computed;
- `final`: whether the producer expects further revision;
- `supersedes_feedback_id`: receiver-issued ID of the prior assertion on the
  same hop.

Revisions are new immutable submissions with new idempotency keys. The compact
contract does not add a general revision graph or delivery-revision dependency.

## Proposed response

```json
{
  "status": "completed",
  "success": true,
  "feedback_id": "fb_01J5Y5KQ2T8B2M8P0A4E6R3C9D",
  "application_status": "applied",
  "received_at": "2026-08-04T12:00:02Z",
  "applied_at": "2026-08-04T12:00:02Z"
}
```

`status` remains the protocol task lifecycle. `application_status` is the
business disposition:

- `accepted`: stored and eligible for evaluation;
- `applied`: incorporated into optimizer inputs;
- `not_applied`: evaluated but not incorporated, with `status_reason`.

Legacy sellers may continue returning only `success`. Any receiving endpoint
declaring the compact capability returns a hop-local `feedback_id`. Sellers
claiming application-status support return `application_status` honestly; an
orchestrator gateway normally returns receipt rather than claiming seller
application.

This draft intentionally does not add an asynchronous read task or webhook.
The response reports disposition at response time. A durable follow-up should
ship only when implementations can expose optimizer state reliably.

## Measurement-agent and orchestrator roles

### Discovery

Measurement provider:

```json
{
  "supported_protocols": ["measurement"],
  "experimental_features": ["measurement.core"],
  "measurement": {
    "produces_performance_feedback": true,
    "metrics": [
      {
        "metric_id": "incremental_revenue_index",
        "unit": "index",
        "methodology_url": "https://measurement.example/methodology"
      }
    ]
  }
}
```

Buyer orchestrator gateway:

```json
{
  "supported_protocols": ["measurement"],
  "experimental_features": ["measurement.gateway"],
  "measurement_gateway": {
    "delivery_task": "get_media_buy_delivery",
    "feedback_task": "provide_performance_feedback"
  }
}
```

Seller:

```json
{
  "experimental_features": ["measurement.core"],
  "media_buy": {
    "performance_feedback": {
      "reports_application_status": true
    }
  }
}
```

These are routing claims, not access grants.

A provider that sets `produces_performance_feedback: true` uses the fixed
first-tier gateway tasks. Method arrays are intentionally absent until complete
contracts exist for additional paths.

### Authorization

The existing account authorization model is sufficient on the orchestrator
gateway:

```json
{
  "authorization": {
    "allowed_tasks": ["get_media_buy_delivery", "provide_performance_feedback"],
    "read_only": false
  }
}
```

The provider receives `get_media_buy_delivery` and
`provide_performance_feedback` on its orchestrator account. Orchestrators may
use a `custom:` scope name, but the task list carries the normative task
permission. Measurement providers do not receive seller-account grants.

No new standard named scope is proposed.

### Gateway flow

```text
Seller delivery ──► Buyer orchestrator ──► Measurement agent
                         ▲                        │
                         │ compact assertion     │
                         └────────────────────────┘
                         │
                         └──► normalized seller-local feedback
```

1. The orchestrator collects delivery from each seller and applies common user
   or geographic cohort definitions.
2. The provider calls the orchestrator's `get_media_buy_delivery` task for
   buyer-approved delivery.
3. The provider calls the orchestrator's `provide_performance_feedback` task.
   The gateway authenticates the provider and binds `producer`.
4. The orchestrator validates and normalizes the assertions, chooses what to
   disclose, maps its measurement-facing identifiers to seller-local IDs, and
   calls each seller's `provide_performance_feedback` under the buyer's
   identity. Identifiers are receiver-scoped on each hop; providers never need
   seller-local identifiers.
5. The orchestrator retains the mapping between provider receipts and seller
   receipts/application dispositions as the cross-seller audit trail.

Account authorization grants the two gateway tasks. Future webhook or offline
paths require a separate connection/configuration contract rather than an
undeclared out-of-band assumption.

## Why not `report_usage`?

`report_usage` reports how a vendor service was consumed so the vendor can
track billing. Its records require `vendor_cost` and `currency` and combine
signal, creative, governance, rights, and other service identifiers.

It is not a general measurement-result format and should not become one. Using
it for measurement interchange would mix:

- service-consumption billing;
- seller delivery facts;
- third-party analytical outputs; and
- optimizer feedback.

Existing documentation that describes `report_usage` as a general
buyer-attested measurement settlement path overstates what its schema can
carry. That inconsistency should be resolved separately rather than expanded.

## Schema changes

- **New:** `enums/performance-baseline.json`
- **New:** `core/performance-feedback-metric.json`
- **New:** `core/performance-feedback-assertion.json` defines compact request
  assertions while the published stored-record type remains intact.
- **Changed:** `provide-performance-feedback-request.json` composes the
  canonical assertion plus idempotency/context fields.
- **Changed:** `provide-performance-feedback-response.json` adds receipt and
  application-disposition fields.
- **Changed:** `get-adcp-capabilities-response.json` adds distinct seller,
  measurement-provider, and buyer-orchestrator gateway declarations for the
  first-tier task path.

## Compatibility

- Existing request fields and required fields are unchanged.
- Existing success responses remain valid.
- The standalone `core/performance-feedback.json` remains a stored-record type
  with its previously required fields unchanged. Compact request fields live in
  the new assertion schema.
- `metric_type`, `feedback_source`, and the documented `vendor` producer field
  remain accepted.
- `metric_type` and `vendor` are deprecated in favor of `metric` and
  `producer`.
- When `baseline` is absent, `performance_index = 1.0` retains its legacy
  meaning of expected performance. When `baseline` is present, 1.0 means that
  named baseline.
- `additionalProperties` policy is unchanged.
- Released `dist/schemas/<version>` artifacts remain immutable.

## Non-goals

- Transporting raw exposure or conversion logs.
- Standardizing model inputs, coefficients, or identity graphs.
- Defining buyer experiment assignment or seller-created holdouts.
- Making AdCP a clean-room protocol.
- Replacing authoritative delivery or billing records with feedback.
- Reusing `report_usage` as measurement ingestion.
- Defining a universal methodology taxonomy.
- Supporting arbitrary dimensional subjects in the first compact revision.
- Guaranteeing that applied feedback causes a specific delivery change.

## Conformance expectations

Tests cover:

1. The existing legacy request remains valid.
2. Compact buyer and measurement-provider assertions validate.
3. Invalid baseline and vendor metric identity are rejected.
4. Sellers can return receipt and application disposition without colliding
   with protocol task status.
5. Measurement provider, orchestrator gateway, and seller capability roles
   validate independently.
6. The training seller validates the compact fields and returns a replay-safe
   accepted receipt without claiming optimizer application.

## Working-group questions

1. Should `baseline` become schema-required at the next major, or is a
   capability-gated 3.x requirement sufficient?
2. Is synchronous `application_status` useful enough to ship now, or should
   sellers return only `feedback_id` until an asynchronous audit path exists?
3. Should a future delivery row expose an opaque stable key for arbitrary
   dimensional feedback, or are media-buy/package/creative scopes sufficient?
4. When will the two fixed first-tier tasks need to expand to a negotiated
   method set? The current design defers webhook and offline paths until
   complete registration, credential, payload, and receipt contracts exist.
5. Should `report_usage` documentation retreat to its billing/consumption role
   immediately, or does its buyer-attested settlement language require a
   separate migration proposal?
