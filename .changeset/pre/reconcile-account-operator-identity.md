---
"adcontextprotocol": minor
---

Allow buyers to reconcile an existing advertiser account's operator identity through revision-checked `sync_accounts` settings updates. Sellers advertise supported operator and operator-unit changes, return machine-readable dry-run impacts, preserve account continuity during atomic rekeying, route operator-domain handoffs through explicit approval with billing and grant revalidation, reject target-key collisions without merging, expose pending approval state through account reads, and tombstone former natural keys with an `ACCOUNT_MOVED` repair reference instead of provisioning duplicate accounts.
