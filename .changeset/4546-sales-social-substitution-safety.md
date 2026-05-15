---
---

compliance(sales-social): require preview_creative + substitution-safety phase

`sales-social` previously deferred runtime substitution-safety checks pending an observation-hook design (#2651, closed). The premise that social platforms have no AdCP-level preview hook didn't hold — Meta `creative_preview`, TikTok/Snap creative-preview APIs, and Amazon Ads/Walmart Connect previews all exercise catalog-item macro substitution as part of rendering.

Wire `sales-social` to the existing `substitution_observer_runner` test-kit contract using the same preview surface `creative-generative` already uses post-#2649. No new capability, no new schema.

Changes:

- `static/compliance/source/specialisms/sales-social/index.yaml`
  - Add `preview_creative` to `required_tools`
  - New `catalog_substitution_safety` phase with four steps: push probe catalog with attacker-shaped values → push DPA creative bound to the probe catalog → call `preview_creative` → observe substituted URLs via the runner contract
  - Update `catalog_driven_dynamic_ads` narrative — drop the "tracked under #2638" deferral
- `static/compliance/source/test-kits/substitution-observer-runner.yaml`
  - Add `sales_social` to `applies_to.specialisms`
  - Remove the deferred-pending-#2651 comment block

Coverage limitation (same as creative-generative): preview-time substitution may diverge from impression-time on platforms with different code paths. Serve-time attestation remains a known gap and is not gated for this phase.

Closes #4546.
