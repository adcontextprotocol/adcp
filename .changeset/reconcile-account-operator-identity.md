---
"adcontextprotocol": minor
---

Allow buyers to reconcile an existing advertiser account's operator identity through revision-checked `sync_accounts` settings updates. Sellers advertise supported operator and operator-unit changes, preserve the account and its attached resources during atomic rekeying, expose pending approval state through account reads, and tombstone former natural keys with an `ACCOUNT_MOVED` repair reference instead of provisioning duplicate accounts.
