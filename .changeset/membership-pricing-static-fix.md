---
---

Site: `server/public/membership.html` — corrects stale prices in the static fallback HTML (sr-only summary, comparison table, FAQ paragraph, `<noscript>` block). Builder $2,500 → $3,000 and Partner $10,000 → $15,000, matching the dynamic CTA component (`join-cta.js`) and Stripe (`aao_membership_builder_3000`, `aao_membership_member_15000`). No tier renames; "Partner" remains the public label per `server/src/services/membership-tiers.ts` TIER_LABELS. Same page was rendering two different numbers depending on whether JS had loaded.
