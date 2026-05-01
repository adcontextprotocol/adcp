---
---

Fix `discover_account` step in audience-sync storyboard: flip `stateful: false` → `stateful: true`.

The step's own narrative states "The account_id is captured for use in subsequent audience operations," yet `stateful: false` told the SDK runner not to count a passing result as establishing state. Explicit-mode adopters saw `sync_audiences` cascade-skip with `prerequisite_failed` even after `list_accounts` passed. This aligns audience-sync with the identical declaration in the `sales-social` storyboard and with the SDK runner's cascade-resolution behavior (adcp-client#1130).
