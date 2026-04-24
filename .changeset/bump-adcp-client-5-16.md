---
---

Bump `@adcp/client` from `5.15.0` to `5.16.0` and restore positive
coverage on the fresh-path `replayed` assertion.

**5.16.0 brings** the two follow-ups our prior bump flagged:

- **`field_value_or_absent` matcher** (adcp-client#873 → 5.16.0).
  Passes when a field is absent OR present with a matching value;
  fails only when present with a disallowed value. The envelope-spec
  escape hatch we needed for `replayed` on fresh execution.
- **Context-rejection hints** (adcp-client#870 → 5.16.0). Runner
  emits non-fatal `context_value_rejected` hints when a seller's
  error response's `available:` list would have accepted a value
  that traces back to a prior-step `$context.*` write. Collapses
  the "SDK bug vs seller bug" triage surface. Pass/fail unchanged;
  hints surface on `StoryboardStepResult.hints[]`.

**Spec-side use of the new matcher.** `universal/idempotency.yaml`'s
`create_media_buy_initial` step regains a positive assertion on
`replayed`: "if reported, must be false." The previous PR dropped
that assertion entirely because `field_value` fired on spec-compliant
agents that omit the field. `field_value_or_absent` restores coverage
without penalizing omission. The replay step's `field_value:
allowed_values: [true]` is unchanged.

No training-agent code changes required — the catalog and handler
paths 5.15 exercised continue to pass. Storyboard baselines stay
52/52 in both dispatch modes.
