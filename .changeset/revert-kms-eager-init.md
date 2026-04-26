---
---

fix(boot): drop GCP KMS eager-init at boot

The eager-init added in #3283 took down the prod deploy: when KMS auth is
misconfigured, the gRPC client retries forever inside `getPublicKey`, the app
never binds port 8080, and Fly's health-check times out without surfacing the
underlying KMS error.

Lazy init in `getGcpKmsSigningProvider()` is the safer default — a broken
signing path fails per-call (logged + generic message to LLM via the
call-site try/catch in `adcp-tools.ts`) while the rest of the server boots
normally so operators can SSH in and inspect.

Re-enabling eager init needs either a hard timeout on the `getPublicKey`
round-trip or a deploy-time probe outside the boot critical path.
