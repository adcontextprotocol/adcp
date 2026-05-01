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

## Identity fields that flow through `$context`

When a step captures a value into `$context` via `context_outputs` and a later step consumes it as `$context.<name>`, the *entity type* at both ends must match. If the value captured from a field annotated `advertiser_brand` is consumed as a field annotated `rights_holder_brand`, the lint will flag it (that's the #2627 bug: same field name, different entity). See `docs/contributing/x-entity-annotation.md` for the list of entity types and how schema authors annotate fields.

Other exempt categories: payload-array-keyed sync tasks (`sync_accounts`, `sync_governance`, `sync_catalogs`, `sync_event_sources`), global discovery (`list_creative_formats`, `get_adcp_capabilities`), global catalog reads (`get_brand_identity`, `get_rights`, `update_rights`), and the `comply_test_controller` sandbox primitive.

### Why ID-scoped tasks are exempt but storyboards still carry identity

`check_governance`, `report_plan_outcome`, `acquire_rights`, `log_event`, `calibrate_content`, `validate_content_delivery`, and `validate_property_delivery` all require a globally-unique ID (`plan_id`, `rights_id`, `standards_id`, etc.) that was previously provisioned with brand context. At the spec level, a real seller resolves the ID → tenant via their own lookup; the envelope doesn't need to repeat the identity.

The training agent's `sessionKeyFromArgs` routes by envelope identity. A storyboard that **drops** identity on an ID-scoped task lands in `open:default` and fails to find the plan/rights/standards — so storyboards carry envelope identity anyway, and the lint just won't enforce it.

This is a sandbox routing convention, not a spec claim. Production sellers resolve tenant from the authenticated principal (bearer/OAuth/HMAC), not from envelope payload — see [Tenant resolution](/dist/docs/3.0.3/building/integration/authentication#tenant-resolution). They don't need envelope identity on ID-scoped tasks and wouldn't rely on it if present. Building a cross-session reverse index in the training agent just to move identity off the wire would be sandbox plumbing without spec meaning.

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

## Fixtures and cross-step captures

Storyboards that need prerequisite state (a product with a specific `product_id`, a creative already in `approved` status, a plan the governance flow can reference) have two ways to set it up: **declarative `fixtures:` at the storyboard root** for state that exists *before* the test runs, and **step `context_outputs:` captures** for IDs *generated during* the run.

### When to use which

| Fixture origin | Pattern | Authored as |
|---|---|---|
| Exists before the storyboard (needs seeding) | `fixtures:` at storyboard root | Declarative block; runner seeds via `comply_test_controller` `seed_*` |
| Generated by an earlier step in this run | `context_outputs:` on the generating step, `$context.<name>` on later steps | Captured at runtime; stays inside this run |
| Runner-supplied (webhook URLs, etc.) | `{{runner.webhook_url:<step_id>}}` | Substitution variable |

**Never hardcode a literal ID in `sample_request` if you can avoid it.** A literal like `media_buy_id: "mb_acme_q2_2026_auction"` only works if the agent happens to generate (or accept) that exact ID. Spec-compliant agents auto-generate IDs — the literal won't match and your storyboard will fail for an implementer who did nothing wrong.

### Pattern A — prerequisite fixtures via `fixtures:` + `comply_test_controller`

Declare fixtures at the storyboard root. Set `prerequisites.controller_seeding: true` to tell the runner to auto-inject a fixtures phase before the main phases.

```yaml
id: sales_non_guaranteed
prerequisites:
  controller_seeding: true
  description: "Requires a seeded product and approved creative."

fixtures:
  products:
    - product_id: "test-product"
      delivery_type: "non_guaranteed"
      pricing_options:
        - pricing_option_id: "test-pricing"
          pricing_model: "cpm"
          currency: "USD"
  creatives:
    - creative_id: "campaign_hero_video"
      status: "approved"
      format_id: { id: "video_30s" }

phases:
  - id: place_buy
    steps:
      - id: create_buy
        task: create_media_buy
        sample_request:
          packages:
            - product_id: "test-product"           # ← seeded above
              pricing_option_id: "test-pricing"   # ← seeded above
```

The runner injects a fixtures phase that calls `comply_test_controller` with `scenario: seed_product`, `scenario: seed_pricing_option`, and `scenario: seed_creative` (in foreign-key order) before running `place_buy`. An agent that implements the seed scenarios passes out of the box; an agent that returns `UNKNOWN_SCENARIO` on the seeds causes the storyboard to grade as `not_applicable`, not failed — implementers don't get penalized for missing sandbox-only surface.

See the full list of seed scenarios and their params in [Compliance test controller — Scenarios](/dist/docs/3.0.3/building/implementation/comply-test-controller#scenarios).

### Pattern B — flow-derived captures via `context_outputs:` + `$context.<name>`

Capture the ID the generating step returned, then reference it by `$context.<name>` on downstream steps.

```yaml
steps:
  - id: create_buy
    task: create_media_buy
    sample_request:
      packages: [...]
    context_outputs:
      - name: media_buy_id
        path: "media_buy_id"        # JSON path against this step's response

  - id: check_buy
    task: get_media_buys
    sample_request:
      media_buy_ids: ["$context.media_buy_id"]   # ← resolved at run time
```

The runner captures `media_buy_id` from `create_buy`'s response (after its validations pass), stores it in the run-scoped context accumulator, then substitutes the literal string `$context.media_buy_id` in `check_buy.sample_request` before sending. Agents see the actual ID — never the literal `$context.foo` token.

Capture failures grade the *generating* step, not the reader: if the response doesn't contain `media_buy_id` at the declared path, `create_buy` fails with `capture_path_not_resolvable`. This is deliberate — the contract the storyboard declared ("this step produces a `media_buy_id`") is what failed, not the step that tried to use it.

### Context block and the echo contract

Storyboards that assert on response `context` MUST send a `context:` block on the sample_request:

```yaml
sample_request:
  packages: [...]
  context:
    correlation_id: "sales_non_guaranteed--create_buy"
validations:
  - check: field_value
    path: "context.correlation_id"
    value: "sales_non_guaranteed--create_buy"
    description: "Agent echoes context verbatim"
```

The runner does NOT auto-inject `context:` on sample_requests that omit it. Storyboards whose validator expects `context.correlation_id` in the response but whose sample_request lacks `context:` are authoring bugs — the agent is allowed (and required) to omit context when the caller sent none.

See [Context and sessions — Normative echo contract](/dist/docs/3.0.3/building/integration/context-sessions#normative-echo-contract) for the agent-side rules.

## Asserting on errors

AdCP surfaces errors in two layers (see [Error handling — envelope vs. payload](/dist/docs/3.0.3/building/implementation/error-handling#envelope-vs-payload-errors-the-two-layer-model)). Storyboards MUST assert error shape in a way that works regardless of which layer a conformant agent surfaced the error on.

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

When a rename is required, register the old code in `scripts/error-code-aliases.json`. The file is pure data (it lives next to the lint script that reads it, not in the schema tree) and ships with an empty `aliases` map by default:

```json
{
  "aliases": {
    "OLD_CODE": "NEW_CODE"
  }
}
```

Aliased codes pass the lint as **warnings** during the deprecation window, giving authors time to migrate storyboards. Once the alias is removed from the file, references to the old code become lint errors. This is how renames land without breaking storyboard authorship across versions.

## Asserting on branchable behaviors

Some spec requirements allow multiple conformant agent behaviors — e.g. a past `start_time` on `create_media_buy` MAY be rejected with `INVALID_REQUEST` OR accepted-and-adjusted forward. A single-assertion validator that asserts only one branch forces a conformant agent that picked the other branch to silently fail.

When the spec allows a branchable outcome, split the storyboard into parallel optional phases and resolve via `assert_contribution`:

```yaml
phases:
  - id: reject_path
    optional: true
    steps:
      - id: probe_reject
        expect_error: true
        contributes_to: behavior_handled
        validations:
          - check: error_code
            value: "INVALID_REQUEST"

  - id: adjust_path
    optional: true
    steps:
      - id: probe_adjust
        contributes_to: behavior_handled
        validations:
          - check: response_schema
          - check: field_present
            path: "media_buy_id"

  - id: enforcement
    steps:
      - id: require_either
        task: assert_contribution
        validations:
          - check: any_of
            allowed_values: ["behavior_handled"]
            description: "Agent must exhibit one of the conformant branches."
```

Failures inside an `optional: true` phase do NOT fail the storyboard — only the synthetic `assert_contribution` in the final phase does, and only when no branch contributed. Conformant agents pass exactly one branch and fail the other by design.

The non-chosen branch's failing steps MUST be reported by the runner with skip reason `peer_branch_taken`, not `failed`. This keeps runner summaries accurate for conformant agents (the other-branch failures were not real failures) and keeps dashboard coverage signals clean (`peer_branch_taken` is runtime routing; `not_applicable` is for protocol coverage gaps). See `universal/storyboard-schema.yaml` § "Per-step grading in any_of branch patterns" and `universal/runner-output-contract.yaml` > `skip_result.reasons.peer_branch_taken` for the normative rule.

Canonical example: `past_start_reject_path` / `past_start_adjust_path` / `past_start_enforcement` in `universal/schema-validation.yaml`. Use the same shape for any spec `MAY` / `any_of` where observable outcomes differ across branches.

Single-code `check: error_code` is still correct when the spec mandates a canonical code for a scenario (e.g. `GOVERNANCE_DENIED` on a governance-denied outcome, `NOT_CANCELLABLE` on re-cancel). The split-phase pattern applies only when the spec itself leaves the outcome branchable.

### When NOT to use this pattern

The parallel-optional-phases + `assert_contribution` shape is only appropriate when the **spec text itself** permits multiple observable outcomes (look for explicit `MAY`/`OR` in the normative prose, or an enum of acceptable statuses). It is **not** a tool for softening a vector because an agent's behavior drifted from the spec. Do not apply this pattern to:

- **Idempotency semantics.** `idempotency_key` must be rejected when missing on mutating tasks; replay must return the cached response; conflict must surface `IDEMPOTENCY_CONFLICT`. The spec mandates single behaviors — any other outcome is non-conformant, not a valid branch.
- **Context echo.** Responses MUST echo `context:` verbatim when the caller sent it. There is no conformant branch that omits the echo.
- **Error-code vocabulary.** Canonical codes enumerated in `static/schemas/source/enums/error-code.json` are single-value per scenario. If a storyboard asserts `GOVERNANCE_DENIED` on a governance-denied outcome, that is the code — not one option among several.
- **Webhook signing correctness.** RFC 9421 signing with AdCP's covered-components profile is a single verification shape; there is no alternate branch.

If you find yourself reaching for the split-phase pattern to get past a failing vector, first verify the spec actually permits the branch you want to accept. If it doesn't, the fix is in the agent (or in the spec), not in the vector.

## Adding a catalog-substitution-safety phase to a new specialism

If you are adding a specialism that renders catalog-item macros into URLs
(catalog-driven sales, generative sellers, retail-media, etc.), your storyboard
SHOULD include a substitution-safety phase covering the rule set at
[`docs/creative/universal-macros.mdx#substitution-safety-catalog-item-macros`](../creative/universal-macros.mdx#substitution-safety-catalog-item-macros).

**Start from the template, don't copy-paste from a sibling specialism.** The
canonical three-step phase (`sync_*_probe_catalog` → `build_*_probe_creative`
→ `expect_substitution_safe`) lives as a `phase_template:` comment block in
[`static/compliance/source/test-kits/substitution-observer-runner.yaml`](../../../../static/compliance/source/test-kits/substitution-observer-runner.yaml).
The block uses `<<PLACEHOLDER>>` tokens for the specialism-specific bits
(brand domain, catalog_id prefix, idempotency prefix) so you can materialize a
new phase by doing a simple text substitution against those tokens.

Copying a near-clone from `sales-catalog-driven` or `creative-generative`
works in principle, but the DX reviewer on [#2654](https://github.com/adcontextprotocol/adcp/issues/2654)
flagged that three consumers is the inflection point where trivial drift
starts (misspelled `item_id`, missing `require_every_binding_observed: true`).
The template is the drift-avoidance surface; the `lint:substitution-vector-names`
script ([#2655](https://github.com/adcontextprotocol/adcp/issues/2655))
catches typos in the vector_name references.

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
