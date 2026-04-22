---
---

Delete `server/tests/manual/run-one-storyboard.ts`. Every use case the
script supported is now covered by the published `adcp` CLI (shipped in
`@adcp/client` 5.12):

- Single-storyboard diagnostic run →
  `npx adcp storyboard run <agent-url> <storyboard_id> --allow-http --auth <token> --json`
- Single-step debug →
  `npx adcp storyboard step <agent-url> <storyboard_id> <step_id> --json`
- Capability-driven filter + JUnit output → supported natively on the
  CLI via `--format junit` and capability resolution.

`run-storyboards.ts` stays — the dual-mode (legacy + framework) CI
matrix and per-storyboard `test_kit` / `/mcp-strict` routing it encodes
doesn't fit the helper's single-agent-one-config shape yet. Full
retirement is tracked upstream as the follow-up RFC on
`runAgainstLocalAgent` (per-storyboard config support).

Also removes the `run-one-storyboard.ts` path filter from
`.github/workflows/training-agent-storyboards.yml`.
