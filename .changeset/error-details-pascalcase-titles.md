---
---

spec(schemas): Title Case titles on error-details schemas (partial fix for #3145)

Six `static/schemas/source/error-details/*.json` files carry SCREAMING_SNAKE titles that propagate awkwardly through `json-schema-to-typescript` into `@adcp/client`'s public type surface (e.g., `RATE_LIMITEDDetails_ScopeValues`). Renames to Title Case with spaces, matching the precedent set by PR #3149 for `rate-limited.json`:

| File | Old title | New title |
|---|---|---|
| `account-setup-required.json` | `ACCOUNT_SETUP_REQUIRED Details` | `Account Setup Required Details` |
| `audience-too-small.json` | `AUDIENCE_TOO_SMALL Details` | `Audience Too Small Details` |
| `budget-too-low.json` | `BUDGET_TOO_LOW Details` | `Budget Too Low Details` |
| `conflict.json` | `CONFLICT Details` | `Conflict Details` |
| `creative-rejected.json` | `CREATIVE_REJECTED Details` | `Creative Rejected Details` |
| `policy-violation.json` | `POLICY_VIOLATION Details` | `Policy Violation Details` |

`rate-limited.json` (`Rate Limited Details`) and `vendor-error-codes.json` (`Vendor Error Code Registry`) already used this style.

`json-schema-to-typescript` strips whitespace when generating TypeScript identifiers, so codegen output is `AccountSetupRequiredDetails` etc. — same as the no-spaces form would produce. The spaces are kept in source so the directory's 8 files share one style (precedent set by #3149).

Schema `$id` values (the wire identifiers) are unchanged. The `title` field is non-normative per JSON Schema draft-07 §10.1 — it controls only docgen / codegen output. No wire-format change.

**Partial fix**: this addresses the SCREAMING_SNAKE half of #3145. The other half — `Foo1`-suffixed enum dupes (`AgeVerificationMethod1`, `BriefAsset1`, `VASTAsset1`, `DAASTAsset1`, `CatalogAsset1`) — is downstream codegen behavior in `json-schema-to-typescript` reaching the same enum through different schema paths. The shared `$ref` is already in place upstream, so the dedup needs SDK-side post-process renaming. Tracked SDK-side (will be opened as a follow-up after this and the related VALIDATION_ERROR `issues[]` PR land).
