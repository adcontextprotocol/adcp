---
---

fix(compliance): route hosted 3.0 runs through the 3.0.14 Basic-auth bundle

Uses `@adcp/sdk` 8.1.0-beta.18 so 3.0.14's `auth.type: basic` storyboard
steps send `Authorization: Basic ...` natively. Hosted compliance run options
now also mirror saved Bearer/Basic credentials into the runtime test kit so
the new static-auth probes actually execute in prod/Addie runs, with
profile-aware probe-task selection for non-creative agents. The training
agent's framework task-webhook emitter also preserves the buyer's
`operation_id` on the MCP webhook body so the stricter 3.0.14 receiver
validates outbound webhooks, and the training agent now accepts the SDK's
current `3.1-rc.4` compliance pin.
