---
---
Fix regressions in the ads.txt managerdomain fallback so the feature actually works end-to-end:

- Restore the `DiscoveryMethod` type export (referenced by `AdAgentsValidationResult` but undefined → `tsc` error).
- Restore the `wasUrlReference` declaration in `validateDomainInternal` (referenced after the URL-reference branch but never declared → every successful validation threw `ReferenceError`, was caught by `classifySafeFetchError`, and surfaced as a spurious "network" error).
- Set `discovery_method: 'ads_txt_managerdomain'` and `manager_domain` on the validation result when authorization is discovered via the fallback (the spread of `managerResult` was inheriting `'direct'`, silently breaking the contract that distinguishes one-hop-via-manager from direct publisher attestation).
- Detect self-cycles (`MANAGERDOMAIN=<same publisher>`) by including the current domain in the visited set before the cycle check.
- Surface manager-side warnings (e.g. nested depth-limit) on the outer result when the inner validation fails, so callers can see why the fallback didn't validate.
- Fill in a missing mock in the multi-entry "last wins" test and assert `discovery_method` / `manager_domain` on the fallback path.
