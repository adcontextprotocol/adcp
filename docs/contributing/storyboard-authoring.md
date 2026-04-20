---
title: Storyboard authoring
description: "How to author AdCP compliance storyboards: the canonical account shape, session scoping lint, sync_plans plan-level identity, and cross-tenant probe opt-out."
"og:title": "AdCP — Storyboard authoring"
---

# Storyboard authoring — scoping rules

Compliance storyboards live under `static/compliance/source/`. Each step that invokes a training-agent task that scopes session state by tenant **must** carry brand or account identity in `sample_request`. Otherwise the call lands in `open:default`, and a follow-up step that *does* carry identity writes to `open:<brand>` — giving you `MEDIA_BUY_NOT_FOUND` against your own just-created media buy.

This rule is enforced at build time by `scripts/lint-storyboard-scoping.cjs`, which runs as part of `npm run build:compliance`.

## Canonical identity shape

Use `account { brand, operator }`. The `AccountRef` schema requires `operator` whenever the natural-key form (`brand`) is used — there is no "just a brand" shape at the spec level.

```yaml
sample_request:
  account:
    brand:
      domain: "acmeoutdoor.example"
    operator: "pinnacle-agency.example"
  # ...
```

Explicit-account form (when the seller issued an `account_id` via `list_accounts`):

```yaml
sample_request:
  account:
    account_id: "acc_acme_001"
  # ...
```

For `sync_plans`, identity lives inside each plan entry. The `sync-plans-request` schema defines `brand` on each plan item and forbids `account` there — do not use the wrapper form inside `plans[]`:

```yaml
sample_request:
  plans:
    - plan_id: "plan-001"
      brand:
        domain: "acmeoutdoor.example"
      # ...
```

## What about top-level `brand`?

Some AdCP requests (`create_media_buy`, `get_products`, `build_creative`) have a top-level `brand` field. That is **the campaign's brand**, a separate schema field — not an identity shorthand. `create_media_buy` requires both `account` and `brand`; one does not substitute for the other.

The lint still accepts a bare top-level `brand.domain` as a fallback because the training agent's `sessionKeyFromArgs` reads it — but that is a training-agent routing detail, not a spec-canonical shape. New storyboards should use `account { brand, operator }`.

## Which tasks are session-scoped?

The authoritative list lives in `scripts/lint-storyboard-scoping.cjs` as `TENANT_SCOPED_TASKS`. A parity test (`tests/lint-storyboard-scoping.test.cjs`) asserts every task registered in the training agent's `HANDLER_MAP` appears in either `TENANT_SCOPED_TASKS` or `EXEMPT_FROM_LINT`. If you add a new tool to the dispatch table and forget to classify it, the parity test fails — you won't get silent drift.

Rule of thumb: if the task's **request schema has a required globally-unique scope-ID** (`plan_id`, `rights_id`, `standards_id`, `list_id`, `event_source_id`), the seller can resolve the tenant from that ID alone — envelope identity is redundant and the lint does not require it (see `EXEMPT_FROM_LINT` bucket (c)).

Everything else falls into `TENANT_SCOPED_TASKS`: create/update mutations without a scope-ID, list/get operations that don't carry a single resource ID, resource-standards calls without `standards_id` in schema, etc. These must carry envelope `account { brand, operator }`.

Other exempt categories: payload-array-keyed sync tasks (`sync_accounts`, `sync_governance`, `sync_catalogs`, `sync_event_sources`), global discovery (`list_creative_formats`, `get_adcp_capabilities`), global catalog reads (`get_brand_identity`, `get_rights`, `update_rights`), and the `comply_test_controller` sandbox primitive.

### Why ID-scoped tasks are exempt but storyboards still carry identity

`check_governance`, `report_plan_outcome`, `acquire_rights`, `log_event`, `calibrate_content`, `validate_content_delivery`, and `validate_property_delivery` all require a globally-unique ID (`plan_id`, `rights_id`, `standards_id`, etc.) that was previously provisioned with brand context. At the spec level, a real seller resolves the ID → tenant via their own lookup; the envelope doesn't need to repeat the identity.

The training agent's `sessionKeyFromArgs` routes by envelope identity. A storyboard that **drops** identity on an ID-scoped task lands in `open:default` and fails to find the plan/rights/standards — so storyboards carry envelope identity anyway, and the lint just won't enforce it.

This is a sandbox routing convention, not a spec claim. Production sellers resolve tenant from the authenticated principal (bearer/OAuth/HMAC), not from envelope payload — see [Tenant resolution](/docs/building/integration/authentication#tenant-resolution). They don't need envelope identity on ID-scoped tasks and wouldn't rely on it if present. Building a cross-session reverse index in the training agent just to move identity off the wire would be sandbox plumbing without spec meaning.

## Intentionally cross-tenant probes

If your step is *supposed* to probe a session-scoped task without tenant identity — e.g. a negative test that verifies the seller rejects the bare request, or a capability-discovery probe — annotate the step:

```yaml
- id: probe_without_brand
  task: get_media_buys
  scoping: global
  sample_request:
    # ... no brand/account here by design
```

Use sparingly. When in doubt, carry brand identity — nearly all real-world calls do.

## Asserting on errors

AdCP surfaces errors in two layers (see [Error handling — envelope vs. payload](/docs/building/implementation/error-handling#envelope-vs-payload-errors-the-two-layer-model)). Storyboards MUST assert error shape in a way that works regardless of which layer a conformant agent surfaced the error on.

**Use `check: error_code` — not `check: field_present, path: "errors"`.**

```yaml
# ✅ Shape-agnostic — resolves from either adcp_error (envelope) or errors[] (payload)
validations:
  - check: error_code
    value: "BUDGET_TOO_LOW"
    description: "Budget validation rejected with BUDGET_TOO_LOW"

# ✅ Multiple acceptable codes
validations:
  - check: error_code
    allowed_values: ["VALIDATION_ERROR", "INVALID_REQUEST", "BUDGET_TOO_LOW"]

# ❌ Pins to the payload `errors[]` shape — fails against agents that surface
#    errors only via the transport envelope (MCP `adcp_error`, A2A DataPart)
validations:
  - check: field_present
    path: "errors"
```

Every code used in `value:` or `allowed_values:` MUST exist in the canonical error-code enum at `static/schemas/source/enums/error-code.json`. The `lint:error-codes` script (wired into `npm run test`) walks every storyboard and rejects references to codes that aren't in the enum — a build failure before any test runs.

When a rename is required, register the old code as a deprecation alias in `static/schemas/source/enums/error-code-aliases.json` (added lazily when the first rename lands). Aliased codes validate against the lint during the deprecation window, then fail once the alias is removed. This is how renames like `INVALID_TRANSITION` → `INVALID_STATE` land without breaking storyboard authorship across versions.

## Running the lint locally

```bash
npm run build:compliance    # includes the lint
node scripts/lint-storyboard-scoping.cjs    # lint only
npm run test:storyboard-scoping    # parity test
```

Typical failure output:

```
✗ storyboard scoping lint: 1 violation(s)

  protocols/media-buy/scenarios/invalid_transitions.yaml:setup/create_buy (create_media_buy) — sample_request missing brand/account

Fix: add `account { brand, operator }` to sample_request, e.g.
  sample_request:
    account:
      brand:
        domain: "acmeoutdoor.example"
      operator: "pinnacle-agency.example"
```
