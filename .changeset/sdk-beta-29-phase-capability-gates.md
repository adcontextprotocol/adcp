---
"adcontextprotocol": patch
---

Bump `@adcp/sdk` to `9.0.0-beta.29` so hosted and local storyboard runs pick
up phase-level `requires_capability` enforcement. Protocol-specific phases in
universal storyboards now skip as `not_applicable` before dispatch when the
agent does not advertise the gated capability.

The training agent now also advertises and accepts the SDK runner's `3.1-rc.14`
wire pin so local storyboard matrices do not reject current prerelease probes
with `VERSION_UNSUPPORTED`.
