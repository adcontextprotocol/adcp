---
"adcontextprotocol": patch
---

Certification: three defense-in-depth follow-ups from the #4657 review.

- **#4659** — static-guard regex in `cert-not-completed-sentinel.test.ts` now matches multi-line backtick `return` literals (`[\s\S]` with non-greedy bound), so a future contributor can't slip a multi-line rejection past the wrapper-required guard. Added a regression test that synthesises a multi-line offender.
- **#4660** — added a CI guard test that scans every `.ts` file in `server/src/addie/mcp/` and asserts only `certification-tools.ts` may emit the `Module {ID} completed!` or `# Congratulations! The learner passed the capstone!` success-line prefixes. Prevents a future tool from echoing or summarising prior completions in a way that would trick Sage's rule into announcing success.
- **#4662** — `createCertificationToolHandlers` now pins `boundUserId` at construction and asserts on every `getUserId()` that the captured user hasn't been swapped. Doc comment on the factory clarifies the handler set MUST NOT be cached across users. Makes any future cross-tenant handler-set reuse fail loud rather than silently leaking state.
