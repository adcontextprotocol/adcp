---
"adcontextprotocol": minor
---

spec(errors): add `CONFIGURATION_ERROR` to canonical error catalog

Adds a standard error code for **adopter-side server misconfiguration** — a deployment that the seller has stood up incorrectly, that the buyer cannot fix, that is not transient, and that is not an opaque crash. The canonical catalog previously had no code that fit this slot: `INVALID_REQUEST` is buyer-fixable, `SERVICE_UNAVAILABLE` is transient, `UNSUPPORTED_FEATURE` is a capability mismatch, `ACCOUNT_SETUP_REQUIRED` is buyer-side onboarding, and `GOVERNANCE_UNAVAILABLE` is scoped to a registered governance agent. Concrete failure modes the new code fits: an account is declared with `mode: 'mock'` but no `mock_upstream_url` is populated; a platform is declared with `mode: 'live'` or `mode: 'sandbox'` but no `upstream_url` is declared; a required environment variable is unset on the seller process. Recovery is `terminal` — the buyer MUST surface to the seller's operator and MUST NOT auto-retry, since retries cannot resolve a misconfigured deployment until the operator intervenes.

Wire shape is unchanged — the code itself is the discriminator, no `error-details/configuration-error.json` is registered (mirroring the minimal-disclosure precedent of `AGENT_SUSPENDED` / `AGENT_BLOCKED`); `error.message` carries the operator-readable diagnostic. Sellers SHOULD calibrate that message to a level useful to a seller-side operator without leaking deployment internals to the buyer. The new code is additive — existing catalog entries are unchanged, and SDKs that fall back to the `recovery` classification on unknown codes will already treat unknown sightings as terminal per the forward-compatibility rule in `error-handling.mdx`.

Closes #3995.
