---
---

chore(testing): drop phantom enum entries, add required-clean allowlist, fix verify-version-sync for forward-merge window (refs #3803, #3823)

Two test-infrastructure cleanups surfaced during #3792's review.

**Phantom enum entries dropped from `static/compliance/source/universal/storyboard-schema.yaml`** (refs #3823 item 2). The file's `category:` enum comment listed entries that don't exist as protocol specialism enum values *and* don't exist as storyboard files: `sales_streaming_tv`, `sales_exchange`, `sales_retail_media`, `measurement_verification`, `behavioral_analysis`, `creative_sales_agent` (the last one was retired in #3792). It also had typos (`security` vs the real `security_baseline`, `si_session` vs the real `si_baseline`) and was missing real entries (`governance_aware_seller`).

The comment is rewritten to:
- enumerate specialism categories from the actual `/schemas/enums/specialism.json` (snake_case form, the wire-protocol authoritative source)
- describe universal/domain-level categories non-enumeratively (they aren't on the wire, and the list grows organically) with examples that match what's actually under `static/compliance/source/`

**Required-clean storyboard allowlist added to `.github/workflows/training-agent-storyboards.yml`** (refs #3803 item 1). The existing `min_clean_storyboards` and `min_passing_steps` floors gate on counts only — they catch regressions (count drops) but not rebalancing (one breaks, two new pass, count stays flat). A new "Verify required-clean storyboards" step pins specific scenario IDs whose conformance is wire-load-bearing; failure of any listed scenario fails CI regardless of total count.

Initial allowlist (6 entries, run on both legacy and framework dispatches):

- `media_buy_seller/provenance_enforcement` — wire contract from #3468
- `signed_requests` — RFC 9421 request signing / auth conformance
- `error_compliance` — universal rejection-code vocabulary
- `idempotency` — at-most-once execution contract
- `schema_validation` — request/response shape conformance
- `capability_discovery` — `get_adcp_capabilities` entry point

Per the testing-expert review's guidance: don't pin all 65 (that's just `KNOWN_FAILING_STORYBOARDS` inverted and gets noisy); pin only the handful of contracts whose conformance is genuinely load-bearing.

**`scripts/verify-version-sync.cjs` rewritten to match the dual-branch release model**. The original strict-equality check (package.json === published_version === adcp_version) was over-strict: it broke against `main` after every forward-merge from `3.0.x`, because the `--ours` strategy introduced in #3807 intentionally keeps `main`'s package.json at the in-progress dev version while the registry pulls in the freshly-released artifact (e.g., `adcp_version: 3.0.4` while `package.json: 3.0.3`). Every developer pushing from main was hitting a false-positive "version mismatch" on a state that's actually correct.

The semantic the script should enforce is: "the registry must NEVER fall BEHIND package.json." That preserves the original catch (someone bumped package.json without running `update-schema-versions`, leaving the registry stale) while permitting the inverse (registry briefly ahead during forward-merge windows). Three rules now:

1. `published_version` and `adcp_version` legacy alias must agree when both are set
2. Each must be `>=` package.json by semver compare (registry ahead is fine, behind is the bug we're catching)
3. `published_version` may be unset on `main` until the next `update-schema-versions` run; warn but don't fail

Release-time strict-equality belongs in the release workflow (CI can require it on tagged commits without burdening every developer's pre-push hook).

Non-protocol changes; no schema or task definition is affected.
