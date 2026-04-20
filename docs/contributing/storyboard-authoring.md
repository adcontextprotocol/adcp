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

For `sync_plans`, identity lives inside each plan entry:

```yaml
sample_request:
  plans:
    - plan_id: "plan-001"
      account:
        brand:
          domain: "acmeoutdoor.example"
        operator: "pinnacle-agency.example"
      # ...
```

## What about top-level `brand`?

Some AdCP requests (`create_media_buy`, `get_products`, `build_creative`) have a top-level `brand` field. That is **the campaign's brand**, a separate schema field — not an identity shorthand. `create_media_buy` requires both `account` and `brand`; one does not substitute for the other.

The lint still accepts a bare top-level `brand.domain` as a fallback because the training agent's `sessionKeyFromArgs` reads it — but that is a training-agent routing detail, not a spec-canonical shape. New storyboards should use `account { brand, operator }`.

## Which tasks are session-scoped?

The authoritative list lives in `scripts/lint-storyboard-scoping.cjs` as `TENANT_SCOPED_TASKS`. A parity test (`tests/lint-storyboard-scoping.test.cjs`) asserts every task registered in the training agent's `HANDLER_MAP` appears in either `TENANT_SCOPED_TASKS` or `EXEMPT_FROM_LINT`. If you add a new tool to the dispatch table and forget to classify it, the parity test fails — you won't get silent drift.

Rule of thumb: if the handler calls `getSession(sessionKeyFromArgs(...))`, it's tenant-scoped. Global discovery (`list_creative_formats`, `get_adcp_capabilities`), payload-array-keyed sync tasks (`sync_accounts`, `sync_governance`, `sync_catalogs`, `sync_event_sources`), and global catalog reads (`get_brand_identity`, `get_rights`) are exempt.

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
