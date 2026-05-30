---
"adcontextprotocol": patch
---

Add storyboard coverage for task webhook `operation_id` echo semantics. The webhook-emission universal now sends an explicit `push_notification_config.operation_id` that differs from the runner's URL capture token, validates inbound task webhook payloads against `core/mcp-webhook-payload.json`, and asserts sellers echo the explicit operation id rather than deriving correlation from the opaque receiver URL.

Clarifies the webhook receiver runner contract and webhook documentation so URL path routing remains a buyer/runner implementation detail while the payload `operation_id` is the wire-level correlation field.
