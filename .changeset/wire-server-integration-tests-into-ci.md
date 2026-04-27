---
---

ci: run `server/tests/integration/` in `build-check.yml` against a Postgres service container so PRs that break integration tests fail their checks. Adds a new `test:server-integration` script and skips currently-broken suites under #3289 / #3080 with comments pointing at the umbrella issue. Closes #3094.
