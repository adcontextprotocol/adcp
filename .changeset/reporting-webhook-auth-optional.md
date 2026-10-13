---
"adcontextprotocol": minor
---

`reporting_webhook.authentication` and `create_media_buy.artifact_webhook.authentication` are no longer in `required[]` (#8176), so a 3.3 integration can be fully HMAC-free before 4.0.

- **Switch rule:** the same as `push_notification_config`. Presence selects the deprecated Bearer or HMAC-SHA256 scheme; absence selects the seller's webhook signing profile (RFC 9421 or Web Bot Auth). Sellers never sign both ways, and buyers apply `webhook_mode_mismatch`.
- **Version gate:** a buyer MAY omit the block only when the seller serves 3.3 or later and declares `webhook_signing.supported: true`. A request served below 3.3 still requires it.
- **Non-signing sellers:** a seller that does not sign webhooks rejects an omitted block with `INVALID_REQUEST` naming the field.

Sending the block stays valid throughout 3.x, and #4288 still owns its 4.0 removal. `security.mdx` §Webhook callbacks and the 3.2→3.3 migration guide are updated.
