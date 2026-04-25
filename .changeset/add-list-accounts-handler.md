---
---

Add `handleListAccounts` to the training agent: cursor-based pagination, status/sandbox filters, explicit camelCase→snake_case mapping from `AccountState`, compliance fixture fallback pool for empty sessions, HANDLER_MAP wiring, and a `pagination-integrity-list-accounts.yaml` storyboard that bootstraps three accounts via `sync_accounts` and walks the cursor↔has_more invariant. Unblocks pagination conformance gating for `list_accounts`. Follows the `handleListCreatives` pattern from #3095/#3100.
