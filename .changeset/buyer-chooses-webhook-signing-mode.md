---
"adcontextprotocol": patch
---

The buyer's webhook registration selects the webhook-signing mode, as it did through 3.2. The seller signs with the profile that `signing_profile` names, or with `adcp/webhook-signing/v1` when it is omitted. A buyer that needs legacy signing sends the `authentication` block, which stays deprecated for removal in 4.0. `legacy_hmac_fallback` is a discovery flag that a buyer checks before asking for legacy signing; it does not select the mode, and no onboarding record selects it either.

A seller whose `legacy_hmac_fallback` is `false` rejects a registration that carries `authentication` with the task error `UNSUPPORTED_FEATURE`, and `error.field` points at the block. This replaces the unreleased `webhook_hmac_not_supported`, which is removed from `request-signing-error-code.json`: that enum holds the `WWW-Authenticate` challenge codes, and this rejection answers a task.
