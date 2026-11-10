---
"adcontextprotocol": patch
---

Stop the `webhook_emission` storyboard from failing sellers whose `create_media_buy` completes synchronously. When the primary trigger returns the media buy inline, the storyboard now checks that no task webhook arrives for it and skips the emitted-webhook phases. It still grades the webhook-signing JWKS of a synchronous seller that declares `webhook_signing.supported: true`. Triggers that return `submitted`, or `working` without a `media_buy_id`, are still graded on signed webhook delivery. A `working` response that carries `media_buy_id` is classified as synchronous, and its completion webhook fails `synchronous_trigger_silence`, until the runner reads the task status (adcontextprotocol/adcp-client#3682).
