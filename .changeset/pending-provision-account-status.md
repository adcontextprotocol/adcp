---
"adcontextprotocol": minor
---

Add `pending_provision` to `Account.status` enum for sellers that auto-approve accounts but require downstream technical provisioning (advertiser ID assignment, ad-server adapter wiring, third-party billing setup). Extends the `setup` field description and operations matrix to cover the new state. Inline enum copies in `list-accounts-request.json` and `sync-accounts-response.json` updated in lockstep with the canonical `enums/account-status.json`.
