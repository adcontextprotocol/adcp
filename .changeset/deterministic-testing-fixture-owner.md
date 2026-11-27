---
"adcontextprotocol": patch
---

Compliance (3.2.x backport of #8730, fixes #9211): the `deterministic_testing` storyboard now declares the Acme Outdoor / Pinnacle sandbox account as the owner of its product and pricing-option fixtures, and explicitly scopes media-buy, creative, delivery and budget controller calls to that same consuming account. Its separate `test.example` account-provisioning and account-state checks keep their own identity, with account listing filtered to the effective run account so unrelated visible accounts cannot supply the state-transition account ID. Without this, current runners refuse to seed the storyboard's fixtures on the 3.2 line ("Automatic fixture seeding needs an explicit context.account when a storyboard uses multiple accounts") and the universal storyboard fails before any request is sent.
