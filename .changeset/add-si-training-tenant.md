---
---

feat(training-agent): add `/si` tenant serving SI lifecycle tools (#3940)

Adds a new `si` training-agent tenant at `/si/mcp` that simulates the
brand-agent side of the Sponsored Intelligence session lifecycle. Learners
can now complete the S5 specialist capstone and C3 creative-SI exercises
without hitting `Unknown tool: si_initiate_session`.

**What ships:**
- `v6-si-platform.ts` — minimal `DecisioningPlatform` (no specialism
  methods; all four SI tools ride `customTools` pending SDK SI interface).
- `tenants/si.ts` — stub handlers for `si_get_offering`,
  `si_initiate_session`, `si_send_message`, `si_terminate_session`
  (Nova Brands training fixture, in-memory session state).
- `tenants/registry.ts` — registers the `si` tenant alongside the
  existing six.
- `tenants/tool-catalog.ts` — adds `si_*` → `['si']` discovery hints.
- Migration 465 — backfills `tenant_ids` for A3, C3, S5; fixes the C3
  `c3_ex2` phantom tool (`connect_to_si_agent` → `si_initiate_session`);
  appends stable recertification criterion IDs to S5's `s5_ex1`.

**Not included (human task):**
- Storyboard floors in `.github/workflows/training-agent-storyboards.yml`
  for the `si` tenant — add to smoke matrix after this merges.

Refs #3940.
