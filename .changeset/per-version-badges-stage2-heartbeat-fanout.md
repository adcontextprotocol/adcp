---
---

backend(verification): heartbeat fan-out per AdCP version. Stage 2 of #3524. The compliance heartbeat now issues badges separately for each entry in the new `SUPPORTED_BADGE_VERSIONS` constant — for `'3.0'` today, ready to add `'3.1'` when the spec ships. Stage 1 added the data model; this PR turns on the fan-out.

A single `comply()` call still runs against each agent (one network round per heartbeat). The flat storyboard-status list it returns is then filtered per supported version before each `processAgentBadges()` call. Storyboards opt into a version via the SDK's existing `Storyboard.introduced_in` field — unset means "always applied," so a 3.0 target keeps every storyboard in the catalog today. When 3.1-only storyboards land they'll declare `introduced_in: "3.1"` and the 3.0 fan-out skips them.

What this PR ships:

- **`SUPPORTED_BADGE_VERSIONS`** constant (`['3.0']`) in `services/adcp-taxonomy.ts`. Adding `'3.1'` is a deliberate decision — flipping it on starts issuing 3.1 badges for every eligible agent on the next heartbeat, so the constant is intentionally not auto-derived from storyboards.
- **`getStoryboardsForVersion(adcpVersion)`** + **`getStoryboardIdsForVersion()`** in `services/storyboards.ts`. Filter the catalog by `introduced_in <= target` using a numeric comparator (`compareAdcpVersions`) — `'3.10'` correctly sorts above `'3.2'`, the bug that bit Stage 1's text ORDER BY before review caught it.
- **Heartbeat fan-out** in `addie/jobs/compliance-heartbeat.ts`. Iterates `SUPPORTED_BADGE_VERSIONS`, narrows `storyboardStatuses` to the version's applicable IDs, calls `processAgentBadges` once per version. Aggregates issued/revoked across versions for a single notification per agent.
- **JWT `adcp_version` claim** in `services/verification-token.ts`. Added to `VerificationTokenPayload` and signed alongside the existing `verification_modes` and `protocol_version`. Validated against `^[1-9][0-9]*\.[0-9]+$` at sign time — a poisoned DB row that smuggled a malformed value drops the claim rather than riding into a signed AAO token. `processAgentBadges` passes the version into the signer so the JWT identity matches the DB PK.

What this PR does NOT change:

- Badge SVG label still reads "Media Buy Agent (Spec)" without a version segment. Stage 3.
- Verification panel still renders one row per role. Stage 4 splits into one row per (role, version).
- brand.json enrichment shape unchanged. Stage 5 adds the `badges[]` array.

With `SUPPORTED_BADGE_VERSIONS = ['3.0']` the runtime behavior is byte-for-byte identical to Stage 1 — the same single round of badge issuance happens, just routed through the version-aware code path. The wiring is in place; flipping the constant to add `'3.1'` later turns on parallel-version badge issuance without further code changes.

12 new tests cover `compareAdcpVersions` (numeric sort behavior), `getStoryboardsForVersion` (filter contract), `SUPPORTED_BADGE_VERSIONS` (shape + isSupportedBadgeVersion), and the JWT `adcp_version` claim (round-trip, omit-when-absent, drop-on-malformed, leading-zero rejection, double-digit minor preservation).
