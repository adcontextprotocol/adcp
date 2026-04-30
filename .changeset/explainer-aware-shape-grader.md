---
---

Make the shape grader explainer-aware so its prevalence numbers align
with the Voice rule's explicit carve-out (closes #3660):

- `classifyQuestion` adds an `isExplainer` flag and gives explainer-shape
  questions a wider cap (500-word floor) so the grader stops flagging
  policy-allowed verbosity as length_cap.
- Detection is conservative: a "strong" prefix (`walk me through`,
  `explain`) always passes. "Soft" prefixes (`what is`, `how does`,
  `how is X different from Y`, `what's the difference`, `why does`,
  `why do`) pass only when no transactional noun is present
  (`cost`, `tier`, `billing`, `payment`, `register`, `member`, etc.).
  Mirrors the counter-example list in identity.md Voice.
- `shape-eval-prod-sample.ts` now reports an "actionable violation" rate
  alongside the all-up rate, splitting explainer length_cap from
  non-explainer length_cap. The actionable rate is what to track for
  verbosity regressions; the all-up rate inflates with policy-allowed
  explainer length.
- Adds `good question` to `BANNED_RITUAL_LITERALS` — observed leaking
  in the latest prod sample.
