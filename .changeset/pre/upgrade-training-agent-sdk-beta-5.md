---
"adcontextprotocol": patch
---

Align the AdCP 3.2 beta compliance surface and training agent with `@adcp/sdk@14.0.0-beta.5`. The beta.5 validators carry the flexible-window availability vocabulary, so the `availability_windows` `list_with_horizon` step is no longer registered known-failing (closes the adcp-client#2637 exclusion) and the scenario grades all eight steps. Wire pins move from `3.2-beta.3` to `3.2-beta.4` across the training agent, compliance scenarios, and versioned reference docs.
