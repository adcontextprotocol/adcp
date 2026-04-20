---
---

Harden the pre-commit test hook:

- Switch `test:unit` to `--pool=threads` (vitest 4's default `forks` pool zombied workers for days when something in the module graph leaks an open handle).
- Wrap `npm run test:unit` in `scripts/with-timeout.sh 60` so a sporadic teardown hang aborts pre-commit in 60s instead of blocking the developer indefinitely.
- Run the full `tests/` suite in CI via the Build Check workflow (it wasn't in any workflow before — the pre-commit hook was the only gate).
- Build Check now also triggers on pushes to `main`, not just PRs.
