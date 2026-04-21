---
title: x-entity schema annotations
description: "How to annotate AdCP schema fields that carry entity identity, so the cross-storyboard context-entity lint can catch conflation bugs like the #2627 brand_id advertiser-vs-rights-holder case."
"og:title": "AdCP — x-entity schema annotations"
---

# `x-entity` schema annotations

## TL;DR for schema authors

You're editing a schema and the field you're adding (or reviewing) is an id, slug, or stable reference:

1. **Does the value ever cross storyboard steps?** (captured via `context_outputs`, consumed as `$context.<name>`, or echoed between request and response.) If no, don't annotate.
2. **Pick the entity type** from the table below. If none fits, read the full registry at `static/schemas/source/core/x-entity-types.json` — if still nothing, PR the registry to add one.
3. **Add `x-entity: <value>`** next to `type` on the leaf property. For `$ref`'d shared types, annotate the shared type, not the use site.
4. If your field is a pass-through **echo** of a value from the request, annotate it with the **same** entity type on both sides.

The lint is silent on fields without `x-entity`, so partial rollout is safe.

## Why this exists

Some AdCP schemas use a single field name — `brand_id`, `list_id`, `plan_id` — for values that refer to **different kinds of entities** in different contexts. The most-cited example: `brand_id` can mean "the advertiser's brand" (from `get_brand_identity`) or "the rights-holder / talent brand" (inside `get_rights`). Same JSON shape, different entity. Both locally valid. The mismatch only surfaces when a storyboard captures a value of one kind into `$context` and a later step consumes it expecting the other — as tracked in [issue #2627](https://github.com/adcontextprotocol/adcp/issues/2627).

`x-entity` is a non-validating JSON Schema annotation that tags each identity-bearing field with the *entity type* the value resolves against. The context-entity lint (`scripts/lint-storyboard-context-entity.cjs`) walks storyboard `context_outputs` capture sites and `$context.<name>` consume sites, reads `x-entity` at both ends, and flags mismatches.

## When to add it

Add `x-entity` to a field if and only if:

1. The field's value is an id, slug, or stable reference to a business entity, **and**
2. A storyboard could plausibly capture or consume that value across steps (via `context_outputs` or `$context.<name>`).

Request fields and response fields both take the annotation. Shared types referenced by `$ref` (e.g., `core/brand-id.json`) carry the annotation once; it applies at every use site.

**Echo fields** (response fields that pass through a value the client sent in the request) *should* be annotated, with the same entity type as the request side. The lint treats capture and consume symmetrically — an annotated echo catches when a storyboard re-captures it into `$context` and forwards it under a misleading name.

**Do not** annotate:

- Transient request-scoped values (`idempotency_key`, `request_id`, `correlation_id`).
- Purely descriptive fields (display names, URLs, free-text).
- Fields that don't cross storyboard step boundaries.
- Enum values (`right_type`, `audience_type`) — those are tags, not entity references.

## Placement

On the leaf property definition, next to `type` / `description`:

```json
{
  "properties": {
    "brand_id": {
      "type": "string",
      "description": "Brand identifier from the agent's roster",
      "x-entity": "rights_holder_brand"
    }
  }
}
```

For arrays of entities, annotate the item schema:

```json
{
  "rights": {
    "type": "array",
    "items": {
      "properties": {
        "rights_id": {
          "type": "string",
          "x-entity": "rights_contract"
        }
      }
    }
  }
}
```

For shared `$ref` types (e.g., `core/brand-id.json`), annotate the shared type. Every use site inherits the entity type:

```json
{
  "$id": "/schemas/core/brand-id.json",
  "type": "string",
  "x-entity": "advertiser_brand"
}
```

**Shared-type invariant:** once a shared type carries `x-entity`, every `$ref` to it asserts that entity scope. `core/brand-id.json` is tagged `advertiser_brand`, so a rights-holder / talent-roster brand id cannot reuse that type — create a separate shared type (e.g., `core/rights-holder-brand-id.json`) even if the string shape is identical. The lint treats the shared type as the source of truth; silently re-using it across scopes is the bug we're catching.

If a shared type is used ambiguously across contexts, *split the type* rather than omitting the annotation — ambiguity is the problem the lint exists to catch.

## Registered entity types

The authoritative list lives at `static/schemas/source/core/x-entity-types.json`. The lint rejects unknown values — extending the registry is intentional and requires a PR.

High-level groupings (see the registry for full descriptions):

| Category | Values |
|---|---|
| Brand & rights | `advertiser_brand`, `rights_holder_brand`, `rights_grant` |
| Account & party | `account`, `operator` |
| Media buy | `media_buy`, `package`, `product`, `pricing_option` |
| Creative | `creative`, `creative_format` |
| Data & targeting | `audience`, `signal`, `signal_activation_id`, `event_source` |
| Lists & catalogs | `collection_list`, `property_list`, `catalog`, `property` |
| Plans & governance | `media_plan`, `governance_plan`, `content_standards`, `task` |
| SI | `si_session` |

## How the lint reads annotations

Phase 3 of [issue #2660](https://github.com/adcontextprotocol/adcp/issues/2660) implements the cross-storyboard walk:

1. For each storyboard step's `context_outputs[].path`, walk the step's `response_schema_ref` to the referenced location and read `x-entity` there. Record `(capture_name → entity_type)`.
2. For each storyboard step's `sample_request` field whose value is `$context.<name>`, walk the step's `schema_ref` (request schema) to the referenced field and read `x-entity` there. Look up the name in the capture table.
3. If both ends have `x-entity` and they don't match, flag a violation.

The lint is **silent on missing annotations** — partial rollout is safe. Missing annotations are treated as "we don't know what entity this is," not as "these must match." This lets the annotation pass proceed domain by domain without generating false positives.

## Current coverage

The first annotation pass covers the `brand/` domain (the canonical `brand_id` conflation). Follow-up PRs sweep the remaining domains one at a time:

- `media-buy/` — `media_buy`, `package`, `product`, `pricing_option`, `audience`
- `creative/` — `creative`, `creative_format`
- `signals/` — `signal`, `signal_activation_handle`
- `account/` — `account`, `operator`
- `governance/` — `governance_plan`, `content_standards`, `task`
- `property/`, `collection/` — `property_list`, `collection_list`, `property`, `catalog`
- `sponsored-intelligence/` — `si_session`

Until a domain is annotated, the lint is silent there.

## Related

- Registry: `static/schemas/source/core/x-entity-types.json`
- Lint: `scripts/lint-storyboard-context-entity.cjs`
- Tests: `tests/lint-storyboard-context-entity.test.cjs`
- Canonical case: [#2627 brand_rights storyboard conflates advertiser brand_id with talent brand_id](https://github.com/adcontextprotocol/adcp/issues/2627)
- Tracking issue: [#2660 Storyboard field-entity-context lint](https://github.com/adcontextprotocol/adcp/issues/2660)
