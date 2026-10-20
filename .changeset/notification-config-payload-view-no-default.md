---
"adcontextprotocol": patch
---

Drop the schema-level `default` on `notification-config.json` `product_payload_view` and state it in prose (absent means `legacy`). Serializers that materialize schema defaults no longer echo `product_payload_view: "legacy"` on account-only subscriptions, which made those configs, and every `list_accounts` response carrying them, fail the existing `product.*` rule. Sellers echoing configs MUST NOT add `product_payload_view` to a config with no `product.*` event. Closes #8313.
