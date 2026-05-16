---
---

chore(hooks): storyboard matrix in pre-push — closes #3803 item 3

Adds `scripts/run-storyboards-matrix.sh` that loops the 6 per-tenant storyboard runs (signals, sales, governance, creative, creative-builder, brand) and gates on the same `min_clean_storyboards` / `min_passing_steps` floors as `.github/workflows/training-agent-storyboards.yml`. Wired into `.husky/pre-push` conditionally — only fires when changes touch `server/src/training-agent/**`, `server/tests/manual/run-storyboards.ts`, `static/compliance/source/**`, or the matrix script itself. Runtime is ~3 minutes, which is too slow for pre-commit but appropriate for pre-push (the issue's recommendation).

Closes the conformance-rigor follow-up filed at #3803 item 3 — storyboard regressions on relevant paths now block the push locally instead of waiting for CI feedback.

Also exposed as `npm run test:storyboards` for direct invocation.

Floors are mirrored in two places (workflow YAML and the script). When floors lift, both must move together — comment in the script flags this.
