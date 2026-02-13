---
"adcontextprotocol": minor
---

Add `get_creative_features` task for creative governance

Introduces the creative analog of `get_property_features` — a general-purpose task for evaluating creatives and returning feature values. Supports security scanning, creative quality assessment, content categorization, and any other creative evaluation through the same feature-based pattern used by property governance.

New schemas:
- `get-creative-features-request.json` — accepts a creative manifest and optional feature_ids filter
- `get-creative-features-response.json` — returns feature results with discriminated union (success/error)
- `creative-feature-result.json` — individual feature evaluation (value, confidence, expires_at, etc.)

Also adds `creative_features` to the governance section of `get_adcp_capabilities` response, allowing agents to advertise which creative features they can evaluate.
