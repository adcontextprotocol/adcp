---
"adcontextprotocol": minor
---

`reporting_webhook.authentication` and `create_media_buy.artifact_webhook.authentication` are no longer in `required[]` (#8176), so a 3.3 integration can be fully HMAC-free before 4.0.

- **Absent means signed:** when the block is absent, the seller MUST sign every delivery under the profile it advertises in `webhook_signing.profile`, and receivers MUST reject unsigned deliveries.
- **Non-signing sellers:** a seller that does not sign webhooks rejects an omitted block with `INVALID_REQUEST` naming the field, and never delivers unsigned webhooks.
- **Version gate:** a buyer MAY omit the block only when the request is served at 3.3 or later and the seller declares `webhook_signing.supported: true`. A request served below 3.3 still requires it, including a 3.3 seller serving a buyer pinned to 3.2.
- **`token` is not authentication:** it is a correlation echo and never substitutes for the block or a signature.

How a seller handles a request that carries the block is unchanged and stays in `security.mdx` §Webhook callbacks. Sending the block stays valid throughout 3.x, and #4288 still owns its 4.0 removal. The 3.2→3.3 migration guide and the reporting docs are updated.
