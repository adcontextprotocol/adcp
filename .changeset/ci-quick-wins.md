---
---

ci: path-filter broken-links, drop codeql single-language matrix, skip `npm ci` in changeset-check

- `broken-links.yml` now only runs when docs, README, addie rules, or the owned-links script actually change. Previously it ran on every PR (including schema- and training-agent-only PRs), pulling in a full workspace install plus Mintlify + Puppeteer.
- `codeql.yml` drops a single-entry `matrix:` that added noise without parallelism.
- `changeset-check.yml` stops running a full `npm ci` just to invoke one CLI; it now uses `npx --yes @changesets/cli@^2.31.0` so the check starts in seconds instead of ~1 min.
