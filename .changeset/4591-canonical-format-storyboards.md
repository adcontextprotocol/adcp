---
"adcontextprotocol": patch
---

Expand the canonical-formats compliance storyboard track for #4591 with seeded
producer coverage for v1-only, v2-only, custom v2-only, experimental, and
divergent dual-emission product declarations.

The training agent now preserves fixture-seeded `format_options`-only products
without inventing v1 fallbacks, and emits a producer advisory when a dual-emitted
product's `format_options[].v1_format_ref[]` does not resolve to that product's
`format_ids[]`. The v5 dispatcher and v6 sales adapter both preserve populated
success payloads that carry non-fatal `errors[]` advisories.

The sales training-agent tenant also advertises the seller-level vendor-metric
optimization capability fields needed to exercise the new vendor-metric
storyboards instead of capability-skipping them.

Add #4983 vendor-metric external-catalog precondition coverage as a separate 3.1
storyboard that accepts either compatibility acceptance or `TERMS_REJECTED`
rejection when vendor-catalog membership is unproven by the current harness,
with the future 3.2 true catalog-miss cutover documented in the storyboard narrative.
