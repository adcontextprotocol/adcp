---
---

Harden the prompt-variant eval runner (server/tests/manual/prompt-variant-eval.ts):

- Variant transforms now declare `expectedSizeVsBaseline` (`'same' | 'smaller'
  | 'larger' | 'any'`). The runner validates each variant's actual prompt
  size against the declaration BEFORE making any API calls so a silent no-op
  transform — e.g., a future rule edit that renames a heading the strip
  targeted — fails loud instead of producing misleading "no signal" eval
  results.
- New `RUNS_PER_QUESTION` env var (default 1) reruns each question N times
  per variant and aggregates as fractional fires-per-question. AnyViol uses
  a majority-vote framing (question counts only if ≥50% of its runs fired
  any violation), so a 1/3-flake reads differently from a 3/3-consistent
  fire. Adds a `Heavy` (structurally heavy) column to surface the new
  shape-grader metric introduced in #3601.
