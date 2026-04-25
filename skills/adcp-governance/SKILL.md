---
name: adcp-governance
description: Execute AdCP Governance Protocol operations with governance agents - manage property lists, collection lists, content standards, and campaign governance (plans, checks, outcomes, audit trail). Use when users want to create include/exclude lists, set up brand safety rules, validate content delivery, register campaign plans, validate actions against policy, or produce internal/shareable audit trails.
---

# AdCP Governance Protocol

This skill enables you to execute the AdCP Governance Protocol with governance agents. Covers four areas: property lists (site-level targeting), collection lists (program-level targeting), content standards (brand safety rules), and campaign governance (plans, checks, outcomes, audit trail).

> **Buyer-side basics** — idempotency replay, `oneOf` variants, async `status:'submitted'` polling, error recovery from `adcp_error.issues[]` — live in `skills/call-adcp-agent/SKILL.md`. This skill covers per-task semantics only.

## Overview

The Governance Protocol provides 21 standardized tasks across four areas:

### Property Lists
| Task | Purpose | Response Time |
|------|---------|---------------|
| `create_property_list` | Create include/exclude list | ~1s |
| `update_property_list` | Modify list filters/properties | ~1s |
| `get_property_list` | Retrieve list with optional resolution | ~1-5s |
| `list_property_lists` | List all accessible lists | ~1s |
| `delete_property_list` | Delete a list | ~1s |

### Collection Lists
| Task | Purpose | Response Time |
|------|---------|---------------|
| `create_collection_list` | Create program-level list | ~1s |
| `update_collection_list` | Modify list | ~1s |
| `get_collection_list` | Retrieve with optional resolution | ~1-5s |
| `list_collection_lists` | List all accessible lists | ~1s |
| `delete_collection_list` | Delete a list | ~1s |

### Content Standards
| Task | Purpose | Response Time |
|------|---------|---------------|
| `create_content_standards` | Create brand safety rules | ~1s |
| `get_content_standards` | Retrieve standards by ID | ~1s |
| `update_content_standards` | Modify rules | ~1s |
| `list_content_standards` | List all accessible standards | ~1s |
| `calibrate_content` | Test content against standards | ~5-30s |
| `get_media_buy_artifacts` | Get creatives for compliance review | ~5s |
| `validate_content_delivery` | Audit delivery compliance | ~10-60s |

### Campaign Governance
| Task | Purpose | Response Time |
|------|---------|---------------|
| `sync_plans` | Push or update a campaign plan with budget authority and policies | ~1s |
| `check_governance` | Validate an action (intent or execution) against the plan | ~1-5s |
| `report_plan_outcome` | Report a completed action so plan budget state advances | ~1s |
| `get_plan_audit_logs` | Retrieve governance state, budget tracking, and audit trail | ~1-5s |

> **Experimental in 3.0.** Campaign governance may change between 3.x releases with at least 6 weeks' notice. Sellers MUST declare `governance.campaign` in `experimental_features` to participate. See [experimental status](/docs/reference/experimental-status).

## Typical Workflow

### Property Lists (site-level)
1. **Create list**: `create_property_list` with base properties and filters
2. **Resolve**: `get_property_list` with `resolve: true` to see matched properties
3. **Refine**: `update_property_list` to adjust filters
4. **Apply**: Reference `list_id` in `create_media_buy` targeting

### Collection Lists (program-level, CTV)
1. **Create list**: `create_collection_list` with distribution IDs or genre filters
2. **Resolve**: `get_collection_list` with `resolve: true` to see matched programs
3. **Apply**: Reference in campaign targeting for CTV brand safety

### Content Standards
1. **Create standards**: `create_content_standards` with rules
2. **Calibrate**: `calibrate_content` with test samples to validate configuration
3. **Monitor**: `get_media_buy_artifacts` + `validate_content_delivery` for ongoing compliance

### Campaign Governance
1. **Sync governance agents** to seller accounts via `sync_governance` (lives in the Accounts protocol)
2. **Register the plan**: `sync_plans` with budget authority, channel allocation, and resolved policy IDs
3. **Validate actions**: `check_governance` on intent (pre-discovery) and execution (pre-buy). Returns an opaque `governance_context` token the seller echoes on subsequent checks.
4. **Report outcomes**: `report_plan_outcome` so committed/remaining budget advances
5. **Audit and produce shareable views**: `get_plan_audit_logs` filtered by `governance_contexts` for the requesting party. See [audit trail: internal vs shareable views](/docs/governance/campaign/audit-trail).

---

## Task Reference

### create_property_list

Create a property list for brand safety and inventory targeting.

**Request:**
```json
{
  "name": "Premium News Properties",
  "description": "Tier 1 news publishers for brand campaigns",
  "base_properties": [
    {
      "selection_type": "publisher_tags",
      "publisher_domain": "publisher.com",
      "tags": ["premium", "news"]
    }
  ],
  "filters": {
    "countries_all": ["US", "GB"],
    "channels_any": ["display", "video"]
  },
  "brand": {
    "domain": "acmecorp.com"
  }
}
```

**Key fields:**
- `name` (string, required): Human-readable name
- `description` (string, optional): Purpose of the list
- `base_properties` (array, optional): Property sources — `publisher_tags`, `publisher_ids`, or `identifiers`
- `filters` (object, optional): Resolution filters — `countries_all`, `channels_any`, `property_types`, `feature_requirements`, `exclude_identifiers`
- `brand` (object, optional): Brand reference for automatic rule inference

---

### update_property_list

Modify an existing property list.

**Request:**
```json
{
  "list_id": "pl_abc123",
  "filters": {
    "countries_all": ["US", "GB", "DE"],
    "channels_any": ["display", "video", "ctv"]
  }
}
```

**Key fields:**
- `list_id` (string, required): Property list identifier
- `name`, `description` (string, optional): Update metadata
- `base_properties` (array, optional): Replace property sources
- `filters` (object, optional): Replace filter configuration

---

### get_property_list

Retrieve a property list with optional resolution.

**Request:**
```json
{
  "list_id": "pl_abc123",
  "resolve": true,
  "max_results": 50
}
```

**Key fields:**
- `list_id` (string, required): Property list identifier
- `resolve` (boolean, optional): Resolve filters and return property identifiers (default: false)
- `max_results` (number, optional): Max properties when resolved

---

### list_property_lists

List all property lists accessible to the authenticated principal.

**Request:**
```json
{
  "name_contains": "premium"
}
```

**Key fields:**
- `name_contains` (string, optional): Filter by name substring
- `max_results` (number, optional): Max results

---

### delete_property_list

Delete a property list.

**Request:**
```json
{
  "list_id": "pl_abc123"
}
```

**Key fields:**
- `list_id` (string, required): Property list identifier to delete

---

### create_collection_list

Create a collection list for program-level brand safety (CTV, podcast, streaming).

**Request:**
```json
{
  "name": "Family-Safe CTV Programs",
  "description": "Programs suitable for family brand campaigns",
  "base_collections": [
    {
      "selection_type": "publisher_genres",
      "publisher_domain": "ctv-publisher.com",
      "genres": ["family", "comedy"],
      "genre_taxonomy": "iab_content_taxonomy_3.0"
    }
  ],
  "filters": {
    "content_ratings_exclude": [
      { "system": "us_tv", "rating": "TV-MA" }
    ],
    "kinds": ["series"]
  },
  "brand": {
    "domain": "familybrand.com"
  }
}
```

**Key fields:**
- `name` (string, required): Human-readable name
- `base_collections` (array, optional): Collection sources — `distribution_ids`, `publisher_collections`, or `publisher_genres`
- `filters` (object, optional): `content_ratings_exclude`, `content_ratings_include`, `genres_exclude`, `genres_include`, `kinds`, `production_quality`
- `brand` (object, optional): Brand reference

**Distribution identifier types:** `imdb_id`, `gracenote_id`, `eidr_id`

---

### update_collection_list

Modify an existing collection list.

**Request:**
```json
{
  "list_id": "cl_abc123",
  "filters": {
    "content_ratings_exclude": [
      { "system": "us_tv", "rating": "TV-MA" },
      { "system": "us_tv", "rating": "TV-14" }
    ]
  }
}
```

**Key fields:**
- `list_id` (string, required): Collection list identifier
- `base_collections`, `filters` (optional): Replace configuration

---

### get_collection_list

Retrieve a collection list with optional resolution.

**Request:**
```json
{
  "list_id": "cl_abc123",
  "resolve": true
}
```

**Key fields:**
- `list_id` (string, required): Collection list identifier
- `resolve` (boolean, optional): Resolve and return collection entries
- `max_results` (number, optional): Max collections when resolved

---

### list_collection_lists

List all collection lists accessible to the authenticated principal.

**Request:**
```json
{
  "name_contains": "family"
}
```

---

### delete_collection_list

Delete a collection list.

**Request:**
```json
{
  "list_id": "cl_abc123"
}
```

---

### create_content_standards

Create content standards (brand safety rules) for campaign compliance.

**Request:**
```json
{
  "name": "Automotive Brand Safety",
  "description": "Content rules for automotive brand campaigns",
  "rules": [
    { "rule_type": "category", "action": "block", "value": "violence", "severity": "critical" },
    { "rule_type": "category", "action": "block", "value": "adult", "severity": "critical" },
    { "rule_type": "keyword", "action": "flag", "value": "accident", "severity": "medium" }
  ],
  "brand": {
    "domain": "automaker.com"
  }
}
```

**Key fields:**
- `name` (string, required): Human-readable name
- `rules` (array, optional): Content rules — `rule_type`, `action` (allow/block/flag), `value`, `severity`
- `brand` (object, optional): Brand reference for automatic rule inference

---

### get_content_standards

Retrieve content standards by ID.

**Request:**
```json
{
  "standards_id": "cs_abc123"
}
```

---

### update_content_standards

Modify existing content standards.

**Request:**
```json
{
  "standards_id": "cs_abc123",
  "rules": [
    { "rule_type": "category", "action": "block", "value": "violence", "severity": "critical" }
  ]
}
```

---

### list_content_standards

List all content standards accessible to the authenticated principal.

**Request:**
```json
{
  "name_contains": "automotive"
}
```

---

### calibrate_content

Test content samples against content standards to validate configuration.

**Request:**
```json
{
  "standards_id": "cs_abc123",
  "samples": [
    { "url": "https://example.com/article1", "expected_result": "allow" },
    { "url": "https://example.com/article2", "expected_result": "block" },
    { "text": "Car crash injures three people", "expected_result": "block" }
  ]
}
```

**Key fields:**
- `standards_id` (string, required): Content standards to calibrate against
- `samples` (array, required): Content samples with `url` and/or `text`, and optional `expected_result`

---

### get_media_buy_artifacts

Get creative artifacts from a media buy for compliance review.

**Request:**
```json
{
  "media_buy_id": "mb_abc123",
  "sales_agent_url": "https://sales.publisher.com"
}
```

**Key fields:**
- `media_buy_id` (string, required): Media buy identifier
- `sales_agent_url` (string, required): Sales agent that owns the media buy

---

### validate_content_delivery

Validate delivered content against content standards.

**Request:**
```json
{
  "standards_id": "cs_abc123",
  "media_buy_id": "mb_abc123",
  "sales_agent_url": "https://sales.publisher.com",
  "date_range": {
    "start": "2025-01-01",
    "end": "2025-01-31"
  }
}
```

**Key fields:**
- `standards_id` (string, required): Content standards to validate against
- `media_buy_id` (string, required): Media buy identifier
- `sales_agent_url` (string, required): Sales agent URL
- `date_range` (object, optional): Filter by delivery date range

---

### sync_plans

Register or update a campaign plan that defines authorized parameters (budget, channels, policies) for an orchestrator's autonomous action.

**Request:**
```json
{
  "plan_id": "plan_q1_2026_launch",
  "plan_version": 1,
  "budget": { "authorized": 500000, "currency": "USD" },
  "channel_allocation": { "olv": 0.55, "display": 0.30, "audio": 0.15 },
  "policies": ["us_coppa", "alcohol_advertising"],
  "human_review_required": false
}
```

**Key fields:**
- `plan_id` (string, required): Stable plan identifier
- `plan_version` (integer, required): Increment on every modification — checks bind to a version
- `budget.authorized` (number, required): Total spend authority across all governed actions on this plan
- `policies` (array, optional): Registry policy IDs that govern this plan. Inline `custom_policies` may add restrictions but cannot relax registry policies.
- `human_review_required` (boolean, optional): Force human review on all actions. Auto-set true when any resolved policy has `requires_human_review: true`.

---

### check_governance

Validate an action against the plan. Called twice in the lifecycle: once on intent (pre-discovery), once on execution (pre-buy). Sellers MUST call execution checks independently using credentials synced via `sync_governance`.

**Request (execution check):**
```json
{
  "plan_id": "plan_q1_2026_launch",
  "plan_version": 1,
  "purchase_type": "media_buy",
  "tool": "create_media_buy",
  "payload": { "...": "the create_media_buy request body" },
  "governance_context": "gc_mb_seller_456"
}
```

**Key fields:**
- `purchase_type` (enum, required): `media_buy`, `rights_license`, `signal_activation`, or `creative_services`
- `governance_context` (string, optional): Echoed on subsequent checks for the same governed action. The agent issues this on the first check and the buyer attaches it to the action envelope.
- `tool` (string, required): Which AdCP tool is being authorized
- `payload` (object, required): The full request body the orchestrator/seller would otherwise send

**Response status:** `approved`, `denied`, or `conditions`. On `denied`, read `governance_context.findings[]` to locate the failed rule and correct the payload.

---

### report_plan_outcome

Report the result of a governed action so plan budget and state advance.

**Request:**
```json
{
  "plan_id": "plan_q1_2026_launch",
  "governance_context": "gc_mb_seller_456",
  "outcome": "completed",
  "committed_budget": 150000
}
```

**Key fields:**
- `governance_context` (string, required): The token issued on the original check
- `outcome` (enum, required): `completed`, `cancelled`, `failed`, or `delivery` (for ongoing pacing reports)
- `committed_budget` (number, required for `completed`): Net budget committed by this action

---

### get_plan_audit_logs

Retrieve governance state, budget tracking, and audit trail for one or more plans.

**Request:**
```json
{
  "plan_ids": ["plan_q1_2026_launch"],
  "governance_contexts": ["gc_mb_seller_456"],
  "include_entries": true
}
```

**Key fields:**
- `plan_ids` / `portfolio_plan_ids` / `governance_contexts` (at least one required): Scope the query
- `include_entries` (boolean, optional): Return the full audit trail. Default `false` returns summary only.

**Producing a shareable view:** filter `governance_contexts` to the requesting party's actions and strip plan-level aggregates (`budget.*`, `channel_allocation.*`, `summary.drift_metrics`) before forwarding. See [audit trail: internal vs shareable views](/docs/governance/campaign/audit-trail).

---

## Key Concepts

### Property Lists vs Collection Lists

- **Property Lists**: Site-level targeting. Operates on publisher domains and properties (websites, apps, CTV apps). Use for "where" the ad appears.
- **Collection Lists**: Program-level targeting. Operates on shows, series, and content programs using distribution identifiers (IMDb, Gracenote, EIDR). Use for "what content" the ad appears alongside (primarily CTV).

### Content Standards vs Property/Collection Lists

- **Content Standards**: Rules-based evaluation of content quality, topics, and safety. Evaluates content dynamically.
- **Property/Collection Lists**: Pre-computed sets of approved or excluded inventory. Static targeting applied at campaign setup.

### Filter Resolution

Property and collection lists combine static selections with dynamic filters. Use `resolve: true` on get operations to see the final resolved set of properties or collections.

### Three invariants for audit and disclosure decisions

These three properties of campaign governance shape what an orchestrator can disclose, can rely on a counterparty having, and cannot work around. Surface them when audit-trail design or counterparty disclosure decisions come up.

1. **Inline policies are additive-only over registry policies.** A buyer's bespoke `custom_policies` (or inline `policy` entries on a plan) may add restrictions on top of registry-sourced policies. They MUST NOT relax, override, or disable registry policies. Counterparties who see `policies_evaluated: ["us_coppa"]` can trust the registry version of `us_coppa` was applied at its declared `enforcement` level.
2. **`governance_context` is the seller-visible correlation token; full plan/budget data is buyer-side.** The seller sees the opaque token they were issued and the entries scoped to it. Plan-level totals (`budget.authorized`, `channel_allocation`, `drift_metrics`) belong to the buyer's internal view and are never shared by default.
3. **`plan_hash` is the cryptographic attestation surface.** `base64url_no_pad(SHA-256(JCS(plan_payload)))` over the plan revision the check evaluated. Any party with the plan revision can recompute and byte-compare. This is what makes a four-field shareable attestation (`governance_context`, `status`, `plan_hash`, `policies_evaluated`) cryptographically meaningful — counterparties don't have to trust the buyer's summary.

> A related working-group adoption pattern — `effective_date` enabling informational-before-enforcement of new policies — lives in [Policy Registry](/docs/governance/policy-registry); it shapes registry rollout rather than per-check disclosure decisions.

---

## Error Handling

Common error codes:

- `LIST_NOT_FOUND`: Invalid list_id
- `STANDARDS_NOT_FOUND`: Invalid standards_id
- `UNAUTHORIZED`: Not authorized to access this resource
- `VALIDATION_ERROR`: Invalid filter or rule configuration
- `PLAN_NOT_FOUND`: No plan with this ID, or the principal is not authorized for it. Returned indistinguishably from the unauthorized case to prevent plan-ID enumeration.
- `GOVERNANCE_DENIED`: `check_governance` rejected the action. Read `governance_context.findings[]` to identify the failed rule, correct the payload, and retry.
