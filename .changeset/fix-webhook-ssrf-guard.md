---
---

fix(training-agent): SSRF guard on outbound webhook emitter (closes #2870)

`createWebhookEmitter` previously POSTed signed webhook bodies to any URL the
buyer registered via `push_notification_config.url` — loopback, link-local
(`169.254.169.254`), or RFC1918 included. In production this lets a caller
pull signed metadata-endpoint deliveries out of the training agent's
environment.

Adds `createWebhookFetch()` in `server/src/training-agent/webhook-fetch.ts`:
a `fetch`-shaped wrapper that rejects non-`http(s)` schemes, literal private
addresses, and hostnames that resolve to private addresses. Wired into
`getWebhookEmitter()` with `allowPrivateIp: process.env.NODE_ENV !==
'production'` so dev/CI conformance storyboards (which use `127.0.0.1`
loopback receivers) keep working while production deliveries are gated.

Unit tests cover literal IPv4/IPv6 private ranges, metadata endpoints,
`localhost` variants, non-http schemes, and public hostname pass-through.
