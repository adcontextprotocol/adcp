---
"adcontextprotocol": patch
---

docs(webhooks): clarify that the **registration channel** determines webhook envelope shape — there is no per-call discriminator. AdCP `push_notification_config` (task arg) always delivers the AdCP `mcp-webhook-payload` envelope; A2A `TaskPushNotificationConfig` (native A2A push registration) always delivers A2A `StreamResponse`-wrapped `Task` / `TaskStatusUpdateEvent` per A2A 1.0 §4.3.3. The two channels are independent and a buyer MAY register both.

This closes [adcontextprotocol/adcp#4246](https://github.com/adcontextprotocol/adcp/issues/4246) without a schema change. The issue's premise — "sellers default to match inbound transport, buyers need an override field to escape it" — was wrong: each registration channel is already purpose-built for its envelope shape, so the buyer picks the channel that matches the receiver. An A2A sync buyer that wants AdCP-shape webhooks puts `push_notification_config` in the AdCP task args inside the `SendMessage` body — no new field needed; an A2A buyer that wants A2A-shape webhooks registers through A2A's native push mechanism.

Verified against [a2a.proto §TaskPushNotificationConfig](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto): A2A 1.0's push config has no encoding-negotiation field, confirming that wire shape is fixed per-channel rather than per-registration.

**`docs/building/by-layer/L3/webhooks.mdx`** — replaces an earlier draft of a "Protocol override" subsection with §"Registration channel determines envelope shape": a two-row table mapping registration channel to delivered envelope, the rationale for channel-as-discriminator over transport-matched, and the typical "A2A sync, AdCP-shape webhooks" case worked example.
