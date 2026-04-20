# Storyboard authoring — scoping rules

Compliance storyboards live under `static/compliance/source/`. Each step that invokes a training-agent task that scopes session state by tenant **must** carry brand or account identity in `sample_request`. Otherwise the call lands in `open:default`, and a follow-up step that *does* carry identity writes to `open:<brand>` — giving you `MEDIA_BUY_NOT_FOUND` against your own just-created media buy.

This rule is enforced at build time by `scripts/lint-storyboard-scoping.cjs`, which runs as part of `npm run build:compliance`.

## Valid identity shapes

Any one of the following in `sample_request` satisfies the lint:

```yaml
sample_request:
  account:
    brand:
      domain: "acmeoutdoor.example"
    operator: "pinnacle-agency.example"   # buyer-side: prefer this shape
  # ...
```

```yaml
sample_request:
  account:
    account_id: "acc_acme_001"   # explicit account (require_operator_auth: true)
  # ...
```

```yaml
sample_request:
  brand:
    domain: "acmeoutdoor.example"   # minimal shorthand — fine for probe-style steps
  # ...
```

For `sync_plans` only, identity may live inside the plans array:

```yaml
sample_request:
  plans:
    - plan_id: "plan-001"
      brand:
        domain: "acmeoutdoor.example"
      # ...
```

The training agent's `sessionKeyFromArgs` falls back to `plans[0].brand.domain` when no top-level identity is present.

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

Fix: add one of
  sample_request.account.account_id
  sample_request.account.brand.domain
  sample_request.brand.domain
  sample_request.plans[0].brand.domain (sync_plans only)
```
