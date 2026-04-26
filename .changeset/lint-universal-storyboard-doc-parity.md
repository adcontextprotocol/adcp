---
---

chore(compliance): lint that universal-storyboard doc tables match the filesystem

New build-time + unit-test lint that prevents the drift #3099 just fixed from re-accumulating. Every graded universal storyboard MUST appear in both `docs/building/conformance.mdx` and `docs/building/compliance-catalog.mdx`; every backtick-quoted slug in those tables MUST resolve to a real graded storyboard on disk.

**Why patch / `--empty` changeset.** Build-script + tests + new lint logic — no protocol-spec surface change. The lint encodes existing convention (the two index pages should agree with `static/compliance/source/universal/`), it doesn't introduce a new normative rule.

**What it catches:**

- New universal storyboard ships without a doc-table row → forward parity fails (specific "missing rows for X" error).
- Doc keeps a row for a renamed/deleted storyboard → reverse parity fails ("references X but no graded storyboard exists" error).
- Either index page loses its "Universal" heading → "missing expected heading" error.

**Wiring:**

- `scripts/lint-universal-storyboard-doc-parity.cjs` — new module exporting `lint({ sourceDir, repoRoot })` plus helpers, with a CLI entrypoint.
- `scripts/build-compliance.cjs` — calls the lint inside `generateIndex`, between `verifyEnumParity` and `lintStoryboardIdempotency`. Build fails loudly if drift is present.
- `tests/lint-universal-storyboard-doc-parity.test.cjs` — 10 tests: source-tree guard, clean-fixture, non-graded-fixture filtering, forward parity (both docs), reverse parity (both docs), missing-heading, helper unit tests.
- `package.json` — new `test:storyboard-doc-parity` script wired into the umbrella `test` target alongside the other storyboard lints, so CI's existing `npm run test` invocation picks it up automatically.

Identifies "graded" by the presence of a `phases:` array in the YAML. Filters out the three non-graded fixtures (`storyboard-schema.yaml`, `runner-output-contract.yaml`, `fictional-entities.yaml`) which live alongside graded storyboards but aren't run by the suite.
