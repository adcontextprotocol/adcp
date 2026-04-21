---
---

spec(compliance): clarify non-OAuth auth path and document branchable-behavior pattern (#2605, #2606)

`universal/security.yaml` narrative now spells out the API-key-only path: declare `auth.api_key` in the test-kit and do not serve RFC 9728 protected-resource metadata. Failures inside the `oauth_discovery` phase are already non-fatal (optional-phase semantics), but the narrative did not make that explicit, leading implementers to stand up fake issuer URLs + stub RFC 8414 metadata documents just to "pass" discovery. The new narrative and the `oauth_discovery` phase header now cross-reference the API-key path so non-OAuth agents know to skip PRM entirely.

`docs/contributing/storyboard-authoring.md` adds an "Asserting on branchable behaviors" section documenting the parallel-optional-phases + `assert_contribution` pattern used by `past_start_reject_path` / `past_start_adjust_path` / `past_start_enforcement` in `universal/schema-validation.yaml`. This is the canonical shape for spec `MAY` branches where conformant agents pick one observable outcome; the single-code `check: error_code` pattern remains correct when the spec mandates one canonical code per scenario.

Audit finding for #2605: no additional storyboards carry single-branch `error_code:` assertions that mask spec `any_of` behaviors. The `past_start` split landed in #2389; remaining single-value asserts (`GOVERNANCE_DENIED`, `TERMS_REJECTED`, `MEDIA_BUY_NOT_FOUND`, `NOT_CANCELLABLE`, etc.) are scenario-specific and spec-mandated.
