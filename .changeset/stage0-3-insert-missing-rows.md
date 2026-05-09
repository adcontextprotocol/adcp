---
---

Add `insert-missing-rows` phase to `stage0-domain-cleanup` (#4159 Stage 0.3): inserts `organization_domains` rows for member profiles where `primary_brand_domain` is set but no matching row exists. Source `manual`, verified true, is_primary true. Trust model: brand-claim DNS verification. Cross-org collisions surface (exit code 2), not stomped.
