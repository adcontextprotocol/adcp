---
"adcontextprotocol": minor
---

Add an optional `account` field to `sync_accounts` response rows, echoed for settings-update-mode entries. Previously the response schema required `brand` + `operator` on every row, which made settings-update mode unimplementable for account-id-namespace sellers with no buyer-declared natural key, and made `action: "failed"` rows for such accounts unrepresentable entirely. The new discriminator mirrors the pattern `sync_governance` already uses. Closes #7517.
