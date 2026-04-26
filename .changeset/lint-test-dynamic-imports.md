---
---

Fix announcement test flakiness at the source (#3118). The 7 announcement test
files (plus tests/addie/escalation-tools.test.ts and email-conversation-flow.test.ts)
used `vi.resetModules()` + dynamic `await import()` per test, re-resolving the
entire transitive module tree on every `it()` and opening a mock-queue race
under thread-pool contention. Converted them to top-level static imports +
`vi.hoisted` mock refs — which is what `vi.mock`'s hoisting already supports.

Adds `scripts/lint-test-dynamic-imports.cjs`, wired into the precommit chain,
to prevent the anti-pattern from regrowing. Two opt-out comments are supported
for legitimate cases (e.g. testing env-var-loaded module init):
`// lint-allow-resetmodules: <reason>` and `// lint-allow-test-imports-file: <reason>`.

Two existing files (tests/billing/organization-db.test.ts,
tests/addie/billing-tools.test.ts) use a different dynamic-import pattern
(reaching into mocked modules to grab fresh refs) — opted out with a TODO
pointing at a follow-up cleanup. tests/billing/stripe-client.test.ts
legitimately exercises `STRIPE_SECRET_KEY`-loaded module init and is opted
out permanently.
