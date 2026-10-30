---
"adcontextprotocol": minor
---

Make a separate account on an account change opt-in, and give the refusal its own code.

- `request_account` gains an optional `allow_separate_account` (default `false`) for change requests. A seller may resolve a change as `created`, opening a separate account with the change and leaving the named account unchanged, only when the request set it to `true`.
- New error code `ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT` (correctable). The seller would accept the change only as a separate account, and the caller didn't allow one. The named account is unchanged, and the buyer can tell this from a plain refusal: it opens a new account itself, resends with `allow_separate_account: true`, or keeps the account as it is.
- A `sync_accounts` settings update has no opt-in, so its review request never resolves as `created`. A seller that would only take the change on a new account rejects it with `ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT`.
- `matched`, pointing to an account the caller already holds, needs no opt-in.
