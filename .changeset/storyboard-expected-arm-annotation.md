---
---

ci(storyboards): `expected_arm` annotation for oneOf disambiguation in path lints

Phase 2d follow-up from #3918's expert review. Closes the last item from the original meta-issue's expert-review follow-ups.

Both path lints (context-output-paths and validations-paths) currently accept any `oneOf` arm when validating a step's paths — the right default for "no prior info." But when a storyboard step semantically expects a specific arm (e.g., `acquire_rights` should return `AcquireRightsAcquired` on the success path), today's lints accept paths that resolve through a *different* arm. A storyboard could capture `terms` (Acquired-arm-only) on a step that at runtime returns `AcquireRightsRejected` and the lint says nothing.

### What this PR adds

1. **Storyboard step field `expected_arm: <discriminator-value>`** (documented in `static/compliance/source/universal/storyboard-schema.yaml`). When present, both lints restrict path resolution to the matching `oneOf`/`anyOf` branch only. Match rule: any property in the branch declares `const: "<expected_arm>"` (covers `status` for rights/media-buy responses, `type` / `state` for others).
2. **Inferred Error-arm restriction when `expect_error: true` is set without an explicit `expected_arm`.** Most response schemas have an Error arm whose `required` list includes `errors` and which has no const-style discriminator (e.g., `AcquireRightsError`). The lint walks `oneOf` for that shape and restricts to it. Saves storyboard authors from threading `expected_arm: "error"` on every error step.
3. **`unknown_expected_arm` violation rule** when an author names an arm value that doesn't match any branch — surfaces typos at storyboard-author time.

### Behavior summary

| Step state | Arm restriction |
|---|---|
| `expected_arm: "<value>"` set | Restricted to matching branch (`unknown_expected_arm` if none) |
| `expect_error: true` only | Restricted to Error arm (if findable) |
| Neither | Any `oneOf` arm (current behavior) |

### Code organization

The arm-resolution helpers (`findArmByDiscriminator`, `findErrorArm`, `resolveExpectedArmSchema`) are duplicated across the two lint scripts rather than extracted to a shared module. Same trade-off as PR #3942 — the two lints have semantically different scopes (capture vs. assert) and forcing a shared module is premature. Future refactor when a third lint surfaces.

### Test plan

- [x] `npm run test:storyboard-validations-paths` (20 tests pass — 7 new for arm filtering, error-arm inference, `unknown_expected_arm` violations, and full-schema fallback)
- [x] `npm run test:storyboard-context-output-paths` (14 tests pass — 3 new for the same behaviors on the capture-side lint)
- [x] Both lints clean across all 82 storyboard files — adding the rule didn't introduce regressions, meaning no existing storyboard relied on `expect_error: true` looseness to capture from non-error arms.
