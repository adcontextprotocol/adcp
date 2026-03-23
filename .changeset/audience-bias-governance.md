---
"adcontextprotocol": minor
---

Add structured audience data for bias/fairness governance validation.

**Schemas**: audience-selector (signal ref or description), audience-constraints (include/exclude), policy-category-definition (regulatory regime groupings), attribute-definition (restricted data categories), match-id-type (identity resolution enum), restricted-attribute (GDPR Article 9 enum).

**Plan fields**: policy_categories, audience constraints (include/exclude), restricted_attributes, restricted_attributes_custom, min_audience_size. Separates brand.industries (what the company is) from plan.policy_categories (what regulatory regimes apply).

**Governance**: audience_targeting on governance-context and planned-delivery for three-way comparison. audience_distribution on delivery_metrics for demographic drift detection. restricted_attributes and policy_categories on signal-definition.json for structural governance matching.

**Registry**: 10 policy category definitions (children_directed, political_advertising, age_restricted, gambling_advertising, fair_housing, fair_lending, fair_employment, pharmaceutical_advertising, health_wellness, firearms_weapons). 8 restricted attribute definitions (GDPR Article 9 categories). 13 seed policies covering US (FHA, ECOA, EEOC, COPPA, FDA DTC, FTC health claims, TTB alcohol, state gambling), EU (DSA political targeting, prescription DTC ban, GDPR special category targeting), and platform (special ad categories, firearms) regulations.

**Media buy**: per-identifier-type match_breakdown and effective_match_rate on sync_audiences response (#1314).

**Docs**: Updated governance specification, sync_plans, check_governance, policy registry, sync_audiences, brand protocol, and signal/data provider documentation.

**Breaking changes** (pre-1.0 RC — expected):
- `brand.industry` (string) renamed to `brand.industries` (string array). See migration guide.
- `policy-entry.verticals` renamed to `policy-entry.policy_categories`.

**Design notes**:
- `policy_categories` on plans is intentionally freeform `string[]` (not an enum). Unlike GDPR Article 9 restricted attributes (a closed legal text), policy categories are open-ended — new jurisdictions and regulatory regimes add categories over time. Validation is at the registry level, not the schema level.
- `audience-selector.json` uses flat `oneOf` with four inline variants (signal-binary, signal-categorical, signal-numeric, description) rather than `allOf` composition with `signal-targeting.json`. This avoids codegen fragility — `allOf` with `$ref` breaks quicktype, go-jsonschema, and similar tools.
