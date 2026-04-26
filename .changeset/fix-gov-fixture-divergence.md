---
---

Governance storyboards: two more seed-fixture alignment fixes to get
both dispatch modes cleaner post-adcp-client#794.

- **`governance-spend-authority/index.yaml`** — rename the governance
  plan from `gov_acme_q2_2027` to `gov_acme_spend_authority_q2_2027`.
  `protocols/governance/index.yaml` already seeded a completely
  different plan under the same id (different budget, flight,
  policies), so the SDK's seed store rejected the second replay with
  `INVALID_PARAMS: Fixture for seed_plan:gov_acme_q2_2027 diverges
  from the previously seeded fixture`. The two plans are semantically
  distinct (spend-authority with unlimited reallocation vs. the
  media_buy_seller Q2 display-and-video flight), so unique ids are
  correct.
- **`governance-delivery-monitor/index.yaml`** — add the missing
  `products:` + `pricing_options:` fixtures for `outdoor_display_q2`
  and `outdoor_video_q2` (both referenced in the storyboard's
  `create_media_buy` packages). Values match the canonical seed in
  `protocols/governance/index.yaml` to avoid divergence.

Storyboard clean counts (overlay against compliance cache):
legacy 44 → 46, framework 38 → 39. Passing steps: legacy 362 → 373,
framework 362 → 372.
