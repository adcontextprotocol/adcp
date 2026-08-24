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
3. **Add `x-entity: <value>`** next to `type` on the leaf property. For `$ref`'d shared types, annotate the shared type, not the use site. For a domain sweep with many known id fields, run `node scripts/add-x-entity-annotations.mjs <files> [--overlay <map>]` — base map at `scripts/x-entity-field-map.json`, per-domain overlays resolve ambiguous names (`list_id`, `plan_id`, `pricing_option_id`). The script validates all values against the registry before writing, so typos hard-fail.
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

### Shared types with `oneOf` / `anyOf` / `allOf` variants

If a shared type's root is a composite (`oneOf` / `anyOf` / `allOf`) and every branch resolves to the same entity, annotate once at the root — the lint reads root-level `x-entity` before descending into variants, so a whole-object capture (e.g., `$context.signal_id` for `core/signal-id.json`) resolves cleanly without duplicating `x-entity` on each variant. `core/signal-id.json` follows this pattern: root-level `x-entity: signal`, and the variant-local `id` fields are deliberately left un-annotated because the `id` is only unique within its variant's namespace (`data_provider_domain` or `agent_url`). Annotating the inner `id` would make two different-namespace ids look interchangeable to the lint.

If variants resolve to *different* entities, **split the type**. The registry lint flags root+variant disagreement (`composite_entity_disagreement` rule) because the walker's root-level check wins at the empty path and would silently drop the variant value.

## Registered entity types

The authoritative list lives at `static/schemas/source/core/x-entity-types.json`. The lint rejects unknown values — extending the registry is intentional and requires a PR.

High-level groupings (see the registry for full descriptions). *Categories below are editorial grouping for orientation only; the registry at `static/schemas/source/core/x-entity-types.json` is the authoritative list.*

| Category | Values |
|---|---|
| Brand & rights | `advertiser_brand`, `rights_holder_brand`, `rights_grant` |
| Account & party | `account`, `operator` |
| Media buy | `media_buy`, `package`, `product`, `product_pricing_option` |
| Creative | `creative`, `creative_format` |
| Data & targeting | `audience`, `signal`, `signal_activation_id`, `event_source` |
| Lists & catalogs | `collection_list`, `property_list`, `catalog`, `property` |
| Plans & governance | `media_plan`, `governance_plan`, `governance_registry_policy`, `governance_inline_policy`, `governance_check`, `content_standards`, `task` |
| Vendor services | `vendor_pricing_option` |
| SI | `si_session`, `offering` |

**Plan vs. policy vs. check:** `governance_plan` identifies the plan container (answers *"which plan?"*); `governance_registry_policy` / `governance_inline_policy` identify a rule inside or referenced by a plan (*"which rule?"*); `governance_check` identifies a specific evaluation of a plan against its policies (*"which check?"* — round-trips between `check_governance` and `report_plan_outcome`). Pick by the question the captured value answers.

**Registry vs. inline policy:** Use `governance_registry_policy` when the field holds a globally-unique registry id (e.g., `uk_hfss`, `us_coppa`, `garm:brand_safety:violence`). Use `governance_inline_policy` when the field holds a plan-scoped bespoke id authored via `policy-entry.json`. Every `$ref` to `policy-entry.json` in an AdCP task schema is inline by definition — registry entries are served by a separate out-of-band API. If the field can legitimately hold either at runtime (the two ambiguous sites: `check-governance-response::findings[].policy_id`, `get-plan-audit-logs-response` audit entries, plus reserved `creative/creative-feature-result.json::policy_id` and `core/feature-requirement.json::policy_id`), leave it un-annotated and add a `$comment` starting with `"x-entity deliberately omitted"` — the gap lister recognises that phrase and skips the leaf.

The registry file is the source of truth. To see every annotated field across the repo: `git grep -l x-entity static/schemas/source`.

### Adding a new entity type

When a schema change introduces an id that doesn't fit any registered value:

1. Add the new value to the `enum` array in `static/schemas/source/core/x-entity-types.json`.
2. Add a one-paragraph definition under `x-entity-definitions` in the same file. Describe what the id identifies, the schemas that use it, and any known caveats (e.g., namespace scope).
3. Add the new value to the category table above, in the most appropriate row.
4. If the new value neighbors an existing one (e.g., plan vs. policy vs. check), add a one-sentence disambiguation under the table.
5. If the value will be applied by the patch script in a future domain sweep, add it to `scripts/x-entity-field-map.json` with the canonical field name → entity value mapping. If the same field name splits by domain (like `plan_id` or `list_id`), use the `__scope_specific__` / `__ambiguous__` sentinels and document the overlay pattern the per-domain PR should supply.

## How the lint reads annotations

The cross-storyboard walk (`scripts/lint-storyboard-context-entity.cjs`) runs at `npm run build:compliance` and as `npm run test:storyboard-context-entity`:

1. For each storyboard step's `context_outputs[].path`, walk the step's `response_schema_ref` to the referenced location and read `x-entity` there. Record `(capture_name → entity_type)`.
2. For each storyboard step's `sample_request` field whose value is `$context.<name>`, walk the step's `schema_ref` (request schema) to the referenced field and read `x-entity` there. Look up the name in the capture table.
3. If both ends have `x-entity` and they don't match, flag a violation.

The lint is **silent on missing annotations** — partial rollout is safe. Missing annotations are treated as "we don't know what entity this is," not as "these must match." This lets the annotation pass proceed domain by domain without generating false positives. To check which domains have been annotated, run `git grep -l x-entity static/schemas/source`.

## Related

- Registry: `static/schemas/source/core/x-entity-types.json`
- Lint: `scripts/lint-storyboard-context-entity.cjs`
- Tests: `tests/lint-storyboard-context-entity.test.cjs`
- Canonical case: [#2627 brand_rights storyboard conflates advertiser brand_id with talent brand_id](https://github.com/adcontextprotocol/adcp/issues/2627)
- Tracking issue: [#2660 Storyboard field-entity-context lint](https://github.com/adcontextprotocol/adcp/issues/2660)
