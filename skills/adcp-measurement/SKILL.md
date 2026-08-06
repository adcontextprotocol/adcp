---
name: adcp-measurement
description: Operate as or integrate with an AdCP measurement agent through a buyer-controlled orchestrator gateway - publish a metric catalog, receive authorized cross-seller delivery, and return compact feedback for orchestrator-controlled seller fan-out. Use when connecting measurement providers or routing provider results into seller optimization.
---

# AdCP Measurement Agents

Measurement agents are first-class provider identities without requiring AdCP to become a universal measurement-data transport.

> **Calling basics** — authentication, idempotency, error recovery, and account resolution live in `skills/call-adcp-agent/SKILL.md`. This skill covers measurement-specific semantics.

## Role

A measurement agent can:

1. publish the metrics it computes through `get_adcp_capabilities.measurement.metrics[]`;
2. declare `measurement.produces_performance_feedback: true` when it produces optimizer-ready assertions;
3. obtain buyer-approved data from an orchestrator through AdCP delivery reads, reporting webhooks, cloud buckets, or existing SDK, clean-room, and offline integrations; and
4. return compact assertions through the negotiated task, webhook, or offline path, after which the orchestrator decides what to send to each seller.

The measurement agent never needs seller credentials. The orchestrator controls cohort consistency, seller-ID mapping, normalization, and disclosure. `report_usage` is a vendor-service consumption and billing task, not general measurement interchange.

## Discovery

Publish an agent entry with `type: "measurement"` in the provider's `brand.json`. The agent's `get_adcp_capabilities` response includes:

```json
{
  "supported_protocols": ["measurement"],
  "experimental_features": ["measurement.core"],
  "measurement": {
    "produces_performance_feedback": true,
    "delivery_input_methods": ["pull", "webhook", "offline"],
    "feedback_output_methods": ["task", "webhook", "offline"],
    "metrics": [
      {
        "metric_id": "incremental_revenue_index",
        "unit": "index",
        "description": "Incremental revenue relative to a buyer-defined control.",
        "methodology_url": "https://measurement.example/methodology",
        "methodology_version": "2026-08"
      }
    ]
  }
}
```

Metric identity is `(provider BrandRef, metric_id)`. Do not assume vendor metric IDs are globally unique.

When `produces_performance_feedback` is true, both method arrays are required.

## Orchestrator gateway and authorization

The buyer orchestrator's experimental `measurement_gateway` capability means it exposes the interchange boundary; it does not grant access by itself. The orchestrator intersects `delivery_output_methods` and `feedback_input_methods` with the provider's corresponding method lists, then provisions the chosen paths on an orchestrator account. Sellers are not part of this provider authorization.

For task-based return, the provider's authenticated principal needs `provide_performance_feedback` on its orchestrator account. Add `get_media_buy_delivery` only when the provider pulls reporting from the orchestrator:

```json
{
  "allowed_tasks": ["get_media_buy_delivery", "provide_performance_feedback"],
  "read_only": false
}
```

Omit either task when its corresponding path is webhook or offline; those paths use provisioned callback-signing or cloud credentials.

Use an orchestrator-defined `custom:` scope name if desired. The task list is normative; the custom name is not.

The orchestrator can expose delivery through the same interfaces a seller uses:

- pull through `get_media_buy_delivery`;
- push through reporting webhooks;
- offline files through a provisioned cloud bucket; or
- an existing provider integration.

The orchestrator exposes measurement-facing media-buy, package, and creative IDs to the provider and retains their mapping to every seller-local ID.

## Producing feedback

Submit one assertion per task call, webhook event, or offline record:

```json
{
  "idempotency_key": "measurement-study-42-july-final",
  "media_buy_id": "mb_123",
  "package_id": "pkg_video",
  "measurement_period": {
    "start": "2026-07-01T00:00:00Z",
    "end": "2026-07-31T23:59:59Z"
  },
  "metric": {
    "scope": "vendor",
    "vendor": { "domain": "measurement.example" },
    "metric_id": "incremental_revenue_index"
  },
  "performance_index": 1.35,
  "baseline": "control_group",
  "producer": { "domain": "measurement.example" },
  "methodology": "geo_incrementality",
  "methodology_version": "2026-08",
  "study_ref": "study_42",
  "evidence_ref": "https://measurement.example/results/study_42",
  "final": true
}
```

Rules:

- `1.0` equals the named baseline.
- `producer` must match authenticated provider identity at the orchestrator gateway.
- `study_ref` is correlation only; it never asks a seller to construct experiment arms.
- Keep raw logs, model coefficients, identity paths, and full study datasets outside the feedback payload.
- A revision is a new assertion with a fresh idempotency key and `supersedes_feedback_id` from the earlier receipt.

## Reading receipts

```json
{
  "status": "completed",
  "success": true,
  "feedback_id": "fb_01J5Y5KQ2T8B2M8P0A4E6R3C9D",
  "application_status": "accepted",
  "received_at": "2026-08-04T12:00:02Z"
}
```

- A gateway receipt identifies the assertion stored by the orchestrator. It should normally report `accepted`; it is not proof that any seller used the signal.
- Each seller returns a separate receipt to the orchestrator. A seller's `applied` means the signal entered that seller's optimizer inputs.
- `not_applied` means the receiving endpoint evaluated but did not incorporate the assertion; inspect `status_reason`.

Do not claim causal delivery impact from `applied`. It means the seller consumed the signal, not that the signal caused a specific bid or allocation change.

## End-to-end flow

### 1. Orchestrator supplies data

The orchestrator negotiates pull, webhook, bucket, or existing-integration delivery with the provider and supplies only buyer-approved data. It applies the same user or geographic cohort definition across sellers before measurement.

### 2. Provider returns feedback

The provider sends compact assertions to the orchestrator gateway. Authenticated provider identity binds `producer`; raw logs, model coefficients, and identity paths remain outside the payload.

### 3. Orchestrator fans out

The orchestrator validates and normalizes the result, chooses what each seller should receive, maps to seller-local IDs, and calls each seller's `provide_performance_feedback` under the buyer's identity. It retains the mapping between provider and seller receipts for audit.
