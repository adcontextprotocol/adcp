---
---

fix(training-agent): wire seed.creative_format on /sales tenant

`pagination_integrity_creative_formats` is a universal storyboard gated on `list_creative_formats`. The tool catalog advertises `list_creative_formats` on `sales`, `creative`, and `creative-builder` — the SDK auto-registers it whenever a tenant claims a creative archetype — but `buildSalesComplyConfig` only registered the seed adapters relevant to the sales-track storyboards (`product`, `pricing_option`, `media_buy`, `creative`). The `creative_format` slot was missing.

Result: `seed_creative_format` calls on `/sales/mcp` hit the SDK dispatcher's `if (!store.seedCreativeFormat) return UNKNOWN_SCENARIO` branch and returned `success: false` before the v5 handler's LOCAL_SCENARIOS pre-handler could service them. The storyboard's `seed_format_1` step graded "Expected true, got false" and cascaded — pagination steps that depended on the seed succeeding skipped.

Wires the adapter consistently with `/creative` and `/creative-builder`:

```ts
seed: {
  ...
  creative_format: cast(seedAdapter('seed_creative_format')),
},
```

Floor lift on /sales:

| Tenant  | Old (post-#4061) | New | Delta |
|---------|------------------|-----|-------|
| /sales  | 64 / 248         | 65 / 252 | +1 / +4 |

Files: `server/src/training-agent/tenants/comply.ts`, `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh`.

Closes one of the three remaining storyboard regressions surfaced after the #3965 cluster work.
