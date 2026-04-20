---
title: Storyboard authoring
description: "Conventions for writing AdCP compliance storyboards: tenant scoping, sample_request identity shapes, and the scoping: global opt-out for cross-tenant probes."
"og:title": "AdCP — Storyboard authoring"
---

# Storyboard Authoring

AdCP compliance storyboards live under `static/compliance/source/` and drive the compliance test runner. A storyboard is a YAML file describing a flow: capability discovery, state setup, buyer-side calls, assertions.

This page documents the conventions the scoping lint enforces (`scripts/lint-storyboard-scoping.cjs`, wired into `npm run build:compliance`).

## Tenant scoping invariant

Any seller that isolates tenants by brand (spec-required for multi-tenant deployments) derives a session key from the request's identity fields. If two steps in the same storyboard target different session keys, the second step can't see state the first wrote.

**Every step that invokes a tenant-scoped task must carry one of these identity shapes in `sample_request`:**

- `brand.domain`
- `account.brand.domain`
- `account.account_id`
- `plans[*].brand.domain` (for `sync_plans` batch shape)

Tenant-scoped tasks are those whose reference implementation in `server/src/training-agent/` derives session state from the request — see `TENANT_SCOPED_TASKS` in `scripts/lint-storyboard-scoping.cjs`.

## Example

```yaml
steps:
  - id: create_buy
    task: create_media_buy
    stateful: true
    sample_request:
      brand:
        domain: "acmeoutdoor.example"    # <-- identity on every step
      idempotency_key: "demo-v1"
      packages:
        - product_id: "$context.product_id"
          budget: 10000

  - id: read_back
    task: get_media_buys
    stateful: true
    sample_request:
      brand:
        domain: "acmeoutdoor.example"    # <-- same brand, same session
      media_buy_ids:
        - "$context.media_buy_id"
```

Both steps land in the same per-tenant session on any brand-scoped seller.

## Opt-out: `scoping: global`

Negative-path probes (schema validation, auth failures, capability discovery) legitimately don't care which tenant they target. Mark them with `scoping: global` at the step level to skip the lint:

```yaml
- id: reversed_dates
  task: create_media_buy
  scoping: global                        # <-- skip the scoping lint
  sample_request:
    start_time: "2026-09-30T23:59:59Z"
    end_time:   "2026-01-01T00:00:00Z"
```

Current legitimate uses:

- `universal/error-compliance.yaml` — probes for structured error shapes.
- `universal/schema-validation.yaml` — probes for schema-validation error paths.
- `universal/security.yaml`, `universal/capability-discovery.yaml` — tenant-agnostic probes that don't get flagged because their tasks are in `EXEMPT_FROM_LINT` (`get_adcp_capabilities`, auth probes).

Don't reach for `scoping: global` to silence the lint. If the storyboard walks buyer-side state across steps, it needs brand.

## Exempt tasks (lint never checks these)

Some tasks are administrative or tenant-agnostic by design. The lint ignores them:

- `get_adcp_capabilities`, `list_creative_formats` — capability / format discovery.
- `get_brand_identity`, `get_rights`, `acquire_rights`, `update_rights`, `creative_approval` — brand-identity agent surfaces (separate agent, not the seller's session).
- `sync_accounts`, `sync_governance`, `sync_catalogs`, `sync_event_sources` — bulk administrative sync from a control plane. Identity travels in the array payload (`accounts[*].brand`, `governance[*]`, etc.), not at the envelope, so the envelope-level lint can't validate it — exemption is structural, not semantic.
- `comply_test_controller` — the test-harness admin channel.

If you add a new tool to the AdCP spec, classify it explicitly in `TENANT_SCOPED_TASKS` or `EXEMPT_FROM_LINT` when you wire it into the training agent.

## Why the lint exists

Found during [adcontextprotocol/adcp#2236](https://github.com/adcontextprotocol/adcp/issues/2236): a storyboard created a media buy with `brand: { domain: "acmeoutdoor.example" }`, then its follow-up `get_media_buys` step omitted brand and landed in a different session. The seller correctly returned "media buy not found." The bug hid behind the training agent being permissive in earlier versions; once session scoping was tightened in [#2263](https://github.com/adcontextprotocol/adcp/pull/2263), the class of bug surfaced across ~15 storyboards. This lint prevents the regression from recurring.
