---
---

chore(deps): bump `@adcp/sdk` to ^7.1.0; re-baseline storyboard floors

7.1.0 ships [adcp-client#1714](https://github.com/adcontextprotocol/adcp-client/pull/1714) — the `findSecretEcho` fix that restored `account_setup` grading for sellers whose endpoints had been failing the secret-echo probe under the 7.0.0 strict-vs-passthrough path. External integrator (bidmachine) confirmed empirically: re-running the storyboard CLI against `https://adcp.bidmachine.io/adcp/mcp` with `@adcp/sdk@7.1.0` cleared `account_setup` from the failure list across both `media_buy_seller` and `sales_non_guaranteed` runs.

Re-baselined the per-tenant floors in `scripts/run-storyboards-matrix.sh` and `.github/workflows/training-agent-storyboards.yml` against the current matrix run. The published floors had drifted well below actuals across the 6.x → 7.0 → 7.1 bumps; new floors capture the post-7.1 ceiling so CI actually defends regressions instead of rubber-stamping a 50-step margin.

| Tenant            | clean (old → new) | passed (old → new) |
|-------------------|-------------------|--------------------|
| /signals          | 67 → 67           | 58 → 111           |
| /sales            | 67 → 67           | 258 → 314          |
| /governance       | 65 → 65           | 102 → 153          |
| /creative         | 66 → 66           | 118 → 169          |
| /creative-builder | 60 → 63           | 96 → 146           |
| /brand            | 66 → 66           | 45 → 96            |
