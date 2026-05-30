---
"adcontextprotocol": patch
---

`sync_accounts notification_configs`: clarify `subscriber_id` as the stable diff key and upsert semantics.

The existing "declarative replace semantics" language was silent on the match key used when diffing a sent `notification_configs[]` against persisted state. This left implementers to infer that `subscriber_id` is the key — which is the only coherent reading, but the `notification-config.json` field description said "duplicates are rejected with `errors[]`" without scoping that to within-request uniqueness, creating an apparent contradiction.

**Normative changes (description-only; no wire format change):**

- `notification-config.json` — `subscriber_id.description`: clarifies that the rejection-on-duplicate rule applies to sending two entries with the same `subscriber_id` within a **single** `sync_accounts` request array. A subsequent `sync_accounts` call that includes an entry whose `subscriber_id` already exists in persisted state **upserts (replaces)** that subscriber's active config — the seller MUST NOT create a duplicate. `subscriber_id` is now explicitly named as the stable match key for the per-account diff.

- `sync-accounts-request.json` — `notification_configs.description`: adds "using `subscriber_id` as the stable match key" to the declarative-replace sentence, plus an explicit "seller MUST NOT merge the new array with persisted state — entries in persisted state whose `subscriber_id` does not appear in the sent array are removed."

- `docs/accounts/tasks/sync_accounts.mdx` — prose section on account-level webhook subscriptions updated to reflect the same semantics.

These semantics match the reference implementation in Salesagent PR #561, which passes against Python SDK 6.1.0 beta models.

Closes #4977.
