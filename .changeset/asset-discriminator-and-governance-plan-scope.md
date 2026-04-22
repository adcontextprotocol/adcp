---
"adcontextprotocol": minor
---

Creative asset schemas now declare an `asset_type` discriminator (required const: `image`, `video`, `audio`, `vast`, `daast`, `text`, `url`, `html`, `javascript`, `webhook`, `css`, `markdown`, `brief`, `catalog`). The composite schemas `core/creative-manifest.json`, `core/creative-asset.json`, `core/offering-asset-group.json`, and `creative/list-creatives-response.json` now use `oneOf` + `discriminator: { propertyName: "asset_type" }` in place of the prior 14-branch `anyOf`. Validators with OpenAPI-style discriminator support (ajv 8 `discriminator: true`) now report errors against only the selected branch instead of every branch — on one storyboard step the allowlist drops from 55+ fingerprints to 2. Authors previously including `asset_type` in payloads (the norm across fixtures) are unaffected; payloads lacking `asset_type` must add it to validate.

Governance request schemas (`governance/report-plan-outcome-request.json`, `governance/check-governance-request.json`, `governance/get-plan-audit-logs-request.json`) now document on `plan_id` / `plan_ids` that the plan uniquely scopes account and operator and that an explicit `account` field is rejected by `additionalProperties: false`. Turns a silent rejection into a readable contract.
