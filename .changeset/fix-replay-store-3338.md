---
---

fix(training-agent): isolate replay store on /mcp-strict (closes #3338)

The post-5.21.1 grader run surfaced `neg/016-replayed-nonce` accepting both submissions of the same `(keyid, nonce)` pair on `/mcp-strict` — a MUST-level RFC 9421 §3.3.2 violation.

Root cause: `/mcp-strict` was using the same `lazySigningAuth()` singleton as `/mcp`, so they shared one `InMemoryReplayStore`. The shared singleton was also bound to the *default* capability (`required_for: []`) rather than the strict one (`required_for: ['create_media_buy']`) — a quieter conformance gap that compounded with the replay leak.

Adds `buildStrictRequestSigningAuthenticator()` in `request-signing.ts` (parallel to the existing strict-required and strict-forbidden builders), and a matching `lazyStrictSigningAuth()` in `index.ts`. `/mcp-strict` now binds to its own replay store and the strict capability.

Un-skips the regression test at `server/tests/integration/training-agent-strict.test.ts:124` (was skipped per #3080 with a stale assertion); the message regex is updated to match the SDK's current `Signature required for create_media_buy.` text.

The triage's bug #1 ("bearer evaluated before signing") didn't reproduce against `@adcp/client@5.21.1` — `requireSignatureWhenPresent` already implements presence-first ordering. The per-route signing-auth instances eliminate any leftover bypass surface regardless.
