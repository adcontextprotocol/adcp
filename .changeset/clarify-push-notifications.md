---
"adcontextprotocol": patch
---

Clarify push notification config flow in docs and schema.

- Fix `push_notification_config` placement and naming in webhook docs (task body, not protocol metadata)
- Add `push_notification_config` explicitly to `create_media_buy` request schema
- Fix `operation_id` description: client-generated, echoed by publisher
- Fix HMAC signature format to match wire implementation
