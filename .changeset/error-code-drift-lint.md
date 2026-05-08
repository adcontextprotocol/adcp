---
---

ci(error-codes): lint enum drift between source and the 3.0.x maintenance branch

Adds `scripts/lint-error-code-drift.cjs` and a per-code disposition registry at `scripts/error-code-drift-dispositions.json`, wired into `build-check.yml` as `npm run test:error-code-drift`. The lint compares the source error-code enum on the current branch against `origin/3.0.x:static/schemas/source/enums/error-code.json` and forces a recorded disposition for every code that's ahead. The dispositions registry encodes the policy that 3.0.x is wire-stable: new enum values are wire changes and default to `held-for-next-minor`; `backport-pending` is reserved for prose-only fixes to existing codes. Pre-seeded with the 17 codes currently ahead of 3.0.x (provenance family, billing/scope codes, agent-block surface, etc.). Failure modes covered: missing disposition (error), invalid disposition value (error), 3.0.x ahead of main (error), stale disposition entry for a code no longer ahead (warn), `unclassified` placeholder (warn). No-ops on the 3.0.x branch itself.
