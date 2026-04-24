---
---

`framework-server.ts` `toAdaptedResponse`: stop passing
`replayed: false` to `wrapEnvelope`. The SDK's `injectReplayed` helper
explicitly strips `replayed: false` (per `protocol-envelope.json`:
the field MUST be omitted on fresh execution to avoid polluting task
payloads under `additionalProperties: false` response schemas). The
framework stamps `replayed: true` only on idempotency replays — which
is already correct.

This was a no-op in practice (the SDK was stripping our value), but
matches the envelope spec exactly now. The lingering
`idempotency/create_media_buy_initial` storyboard failure is a
storyboard assertion bug — `field_value: replayed [false]` fails when
the field is correctly absent on fresh exec. Filed upstream as
adcp-client#857.
