---
---

Standardize buyer-side compliance storyboards on the `account: { brand, operator }` identity shape instead of top-level `brand: { domain }`. Applied across 24 storyboards under `protocols/media-buy/**`, `specialisms/sales-*`, `specialisms/creative-template`, `specialisms/collection-lists`, and `specialisms/property-lists`: 36 steps converted from top-level brand to account+brand+operator, and 32 steps with redundant top-level brand alongside an existing account had the redundant brand stripped. (`specialisms/audience-sync` and `specialisms/measurement-verification` were already canonical-shape and did not need changes.)

The `account { brand, operator }` shape is strictly more expressive than top-level `brand.domain`: it carries agency/operator identity (needed for agency billing, governance trails, and proposal workflows) and mirrors real-world buyer → seller interactions where a buyer agent operates on behalf of a brand through an agency. Both forms resolve to the same session key on reference sellers, so this is a consistency and clarity improvement — not a behavior change.

Documented the canonical shape in `docs/accounts/overview.mdx`. Enforced going forward by the storyboard scoping lint (#2527) — both shapes remain valid identity sources for lint purposes.

Closes #2528. Follow-up filed: #2533 (pre-existing `operator: brand.domain` values in property-lists and collection-lists storyboards that this PR did not introduce but surfaced).
