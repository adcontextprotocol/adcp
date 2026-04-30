---
---

Fix three integration-test failures introduced in #3637 (tool_use route
contract tests) that were breaking the `Server integration tests` job on
`main`.

- **`property-enhancement-function.test.ts`**: the `AdAgentsManager` mock
  used `vi.fn().mockImplementation(() => ({...}))`, which returns an arrow
  function — and `property-enhancement.ts` instantiates with
  `new AdAgentsManager()`. Arrow functions cannot be called with `new`, so
  the test failed at module load with `TypeError: () => ({...}) is not a
  constructor`. Replaced with a `class FakeAdAgentsManager { ... }`.

- **`brand-classifier-route.test.ts`** and
  **`brand-enrichment-route.test.ts`**: `SUFFIX` used `${process.pid}_${Date.now()}`,
  putting an underscore into the test domain. `enrichBrand` and the seed
  loop in `expandHouse` validate against `^[a-z0-9.-]+\.[a-z]{2,}$`
  (underscores are invalid per RFC 1035) and returned
  `{status: 'failed', error: 'Invalid domain format'}` — yielding HTTP 500
  where the tests expected 200, and seeded=0 sub-brands where they expected
  2. Switched separator to a hyphen.

- **`prospect-triage-function.test.ts`** flakiness (not in the original
  failure list but reproducibly fails ~1-2/3 runs): `triageEmailDomain`
  fired `logTriageDecision` without awaiting, so the test could query
  `prospect_triage_log` before the `INSERT` landed. `logTriageDecision`
  swallows its own errors, so awaiting it is contract-preserving and
  cannot cause triage to fail. Removed the redundant outer `.catch`.
