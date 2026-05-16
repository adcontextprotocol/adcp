---
---

Stage 1.2 of #4159: migrate `demotePublicAgentsOnTierDowngrade` (the visibility-demote path that strips public agents from brand.json on tier downgrade) and `/verify-brand` (the brand-claim verifier endpoint) from direct `member_profiles.primary_brand_domain` reads to `getBrandPrimaryDomain(orgId)`. Same lock-release reasoning as Stage 1.1: brand-primary read happens on the pool, outside the FOR UPDATE that protects the agents JSONB write.
