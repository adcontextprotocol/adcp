---
---

Training agent `/mcp-strict` now enforces the webhook-registration downgrade-resistance rule from `security.mdx#webhook-callbacks`: unsigned requests carrying `push_notification_config.authentication` are rejected with `request_signature_required`, even when a valid bearer is presented. Closes the last `signed_requests` conformance gap (vector 027). The sandbox `/mcp` route stays permissive for pre-3.0 storyboards that wire legacy HMAC webhooks over bearer.
