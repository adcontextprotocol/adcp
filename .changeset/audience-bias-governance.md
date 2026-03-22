---
"adcontextprotocol": minor
---

Add structured audience data for bias/fairness governance validation. New schemas: audience-selector (signal ref or description), audience-constraints (include/exclude), policy-category-definition (regulatory regime groupings), attribute-definition (restricted data categories). Registry-level policy category definitions (8 categories: children_directed, political_advertising, age_restricted, fair_housing, fair_lending, fair_employment, pharmaceutical_advertising, health_wellness) and restricted attribute definitions (8 GDPR Article 9 categories). Adds audience targeting, policy_categories, and restricted_attributes to plans, governance context, planned delivery, and delivery metrics with drift detection. Separates brand.industry (what the company is) from plan.policy_categories (what regulatory regimes apply). Adds restricted_attributes and policy_categories to signal-definition.json for structural governance matching.
