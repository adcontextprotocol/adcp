---
"adcontextprotocol": minor
---

Let ZIP bundles, inline HTML, and display-tag assets declare their rendered size independently of a product option. Add optional positive integer `width`/`height` pairs or a mutually exclusive non-empty `sizes` list, enforcing complete pairs and valid size entries across all display-tag delivery types. Unsized assets remain valid.

Document matching against fixed, multi-size, responsive, and unconstrained format options, and using asset dimensions for size-specific legacy delivery projection instead of non-standard creative-level `format_parameters`. Responsive bounds remain format-side constraints.

Clarify logical entry-canvas dimensions, technical completeness, enforceable size selection, backup coverage, and library-first validation. Distinct rendered sizes use existing served-execution variants and resolved manifests while preserving the reusable source revision.
