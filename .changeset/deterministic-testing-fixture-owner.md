---
"adcontextprotocol": patch
---

Compliance: the `deterministic_testing` storyboard now declares the Acme Outdoor / Pinnacle sandbox account as the owner of its product and pricing-option fixtures, and explicitly scopes media-buy, creative, delivery and budget controller calls to that same consuming account. Its separate `test.example` account-provisioning and account-state checks keep their own identity, with account listing filtered to the effective run account so unrelated visible accounts cannot supply the state-transition account ID. The same filter preserves a caller-selected account ID when the seller does not support buyer account provisioning. This prevents later lifecycle controls from following the account selected by `sync_accounts` and targeting the wrong sandbox account.
