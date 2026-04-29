---
---

spec(schemas): PascalCase titles on error-details schemas (partial fix for #3145)

Six `static/schemas/source/error-details/*.json` files carry SCREAMING_SNAKE titles that propagate awkwardly through `json-schema-to-typescript` into `@adcp/client`'s public type surface (e.g., `RATE_LIMITEDDetails_ScopeValues`). Renames to PascalCase:

| File | Old title | New title |
|---|---|---|
| `account-setup-required.json` | `ACCOUNT_SETUP_REQUIRED Details` | `AccountSetupRequiredDetails` |
| `audience-too-small.json` | `AUDIENCE_TOO_SMALL Details` | `AudienceTooSmallDetails` |
| `budget-too-low.json` | `BUDGET_TOO_LOW Details` | `BudgetTooLowDetails` |
| `conflict.json` | `CONFLICT Details` | `ConflictDetails` |
| `creative-rejected.json` | `CREATIVE_REJECTED Details` | `CreativeRejectedDetails` |
| `policy-violation.json` | `POLICY_VIOLATION Details` | `PolicyViolationDetails` |

`rate-limited.json` already had PascalCase (`Rate Limited Details`) so no change there.

Schema `$id` values (the wire identifiers) are unchanged — `$id` keeps using kebab-case file paths. The `title` field affects only generated TypeScript names. No wire-format change.

**Partial fix**: this addresses the SCREAMING_SNAKE half of #3145. The other half — `Foo1`-suffixed enum dupes (`AgeVerificationMethod1`, `BriefAsset1`, `VASTAsset1`, `DAASTAsset1`, `CatalogAsset1`) — is downstream codegen behavior in `json-schema-to-typescript` reaching the same enum through different schema paths. The shared `$ref` is already in place upstream (e.g., both `targeting.json` and `get-adcp-capabilities-response.json` use `$ref: /schemas/enums/age-verification-method.json` to reach the same `$id`), so the dedup needs SDK-side post-process renaming. Tracked SDK-side in adcp-client#942.
