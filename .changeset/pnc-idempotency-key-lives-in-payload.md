---
---

Clarify in the `push_notification_config` schema description that the `idempotency_key` receivers dedup on lives inside the webhook payload body (see `mcp-webhook-payload` and `docs/building/implementation/webhooks.mdx#reliability`), not in the `push_notification_config` transport-config object itself. Prevents implementers from placing the key in the config block and then finding the signed replay check has nothing to key off of.

Extracted from PR #2433 as a standalone editorial clarification.
