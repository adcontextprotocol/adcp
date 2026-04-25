---
---

fix(training-agent): restore 401 for unsigned create_media_buy on /mcp-strict

`resolveOperation` in `buildStrictAuthenticator` read `req.rawBody` exclusively and silently returned `undefined` when it was absent. In test harnesses that mount `express.json()` without the production `verify` callback, `rawBody` is never populated, so the `required_for: ['create_media_buy']` gate never fired and unsigned requests authenticated via bearer → 200.

**Two-part fix:**

1. `server/src/training-agent/index.ts` — `buildStrictAuthenticator`'s `resolveOperation` now falls back to `req.body` (already parsed by express.json) when `rawBody` is absent. Safe because `resolveOperation` drives only the `required_for` routing decision, not cryptographic verification — the signing authenticator's own `resolveOperation` deliberately remains `rawBody`-only.

2. `server/src/training-agent/request-signing.ts` — `enforceSigningWhenWebhookAuthPresent` applies the same fallback for the webhook-authentication downgrade-resistance check so a test harness without the `verify` callback still catches `push_notification_config.authentication` payloads.

3. `server/tests/integration/training-agent-strict.test.ts` — `beforeAll` now mirrors production `http.ts` by adding the `verify` callback to `express.json`, populating `req.rawBody` for all test requests.

Non-protocol server change; `--empty` changeset per playbook.

Closes #3080.
