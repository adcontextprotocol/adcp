---
"adcontextprotocol": patch
---

Add `account` field to `AcquireRightsRequest`, clarify `GOVERNANCE_DENIED` wire-arm placement, and gate storyboard `check: error_code` values against the spec enum.

**Item 1 — schema:** `acquire-rights-request.json` gains an optional `account: AccountReference` field. Governance-aware brand agents need operator+brand to resolve the account-scoped governance binding registered via `sync_governance`; without it they fall back to `buyer.domain`, which is the brand not the buyer account. Non-breaking: additive optional field on an experimental surface (`x-status: experimental`).

**Item 3 — doc:** `GOVERNANCE_DENIED` enumDescription now clarifies canonical wire placement: return in `errors[].code` (e.g., `AcquireRightsError.errors[].code`), not in `AcquireRightsRejected.reason`. Non-breaking: description-only clarification; enum value and recovery classification unchanged.

**Item 7 — CI:** New `scripts/lint-storyboard-error-code-spec.cjs` walks every storyboard's `check: error_code` validations and fails the build if `value`/`allowed_values` entries cite codes not in `error-code.json`. Wired into `npm run build:compliance`. Companion fix: `protocols/brand/index.yaml` corrected from non-spec `brand_not_found`/`BRAND_NOT_FOUND`/`NOT_FOUND` to the canonical `REFERENCE_NOT_FOUND`.
