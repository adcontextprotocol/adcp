---
---

`framework-server.ts` `toAdaptedResponse`: stop passing
`replayed: false` to `wrapEnvelope`. Per `protocol-envelope.json`, the
field MUST be omitted on fresh execution to avoid polluting task
payloads under `additionalProperties: false` response schemas. The
framework stamps `replayed: true` only on idempotency replays — which
is already correct.

Previously we emitted `replayed: false` on every fresh response
(`wrapEnvelope`'s success path writes any key passed in opts; the
strip-on-false allowlist only applies to `adcp_error` envelopes). Now
matches the envelope spec exactly. The lingering
`idempotency/create_media_buy_initial` storyboard failure was a
storyboard assertion bug — `field_value: replayed [false]` fired when
the field was correctly absent on fresh exec. Fixed in adcp-client#859
and mirrored into this repo's compliance source overlay.
