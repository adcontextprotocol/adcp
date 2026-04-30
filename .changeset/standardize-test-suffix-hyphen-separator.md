---
---

Standardize the integration-test `SUFFIX` separator on a hyphen across the
remaining three test files that still used `${process.pid}_${Date.now()}`.

Follow-up to #3656, which switched `brand-classifier-route`,
`brand-enrichment-route`, and `prospect-triage-function` to a hyphen separator
because their test domains were getting rejected by `enrichBrand`'s RFC 1035
regex. Three other test files used the same underscore pattern but happened to
pass today — `property-enhancement-function.test.ts`,
`brand-properties-parse.test.ts`, and `addie-brand-property-tools.test.ts` —
because their domains skip any regex-validating code path. Latent traps for
the next test that adds a real route call.

Hyphen-separator across the board removes the trap and matches the established
convention. No behavior change for code paths that don't validate.
