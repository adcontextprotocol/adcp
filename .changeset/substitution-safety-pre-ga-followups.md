---
"adcontextprotocol": patch
---

spec + compliance: three substitution-safety follow-ups pulled forward to 3.0 GA (closes #2650, #2654, #2655)

Three follow-ups from the #2647 review cycle, originally milestoned 3.1, evaluated by expert reviewers as pre-GA-appropriate and landed here:

## #2650 — Unicode NFC normalization pinned (spec)

The #2620 substitution rule did not pin a Unicode normalization form. Two implementations satisfying the unreserved-whitelist rule produced different bytes for the same visual string (`café` NFC = `%C3%A9` vs NFD = `e%CC%81`). Shipping 3.0 without this rule would lock in an interop gap.

Fix: one normative paragraph in `docs/creative/universal-macros.mdx#substitution-safety-catalog-item-macros`:

> Prior to percent-encoding, catalog-item values that are not already in Unicode Normalization Form C (NFC) MUST be normalized to NFC per Unicode Standard Annex #15. Sellers and buyers MAY send catalog values in any normalization form at `sync_catalogs` ingest (the catalog is stored as-supplied); the normalization to NFC is a step in the substitution pipeline immediately before percent-encoding, not a catalog-ingest requirement. NFKC / NFKD are **not** acceptable substitutes — their compatibility folding silently mutates fullwidth/halfwidth variants and other visually-distinct glyphs that legitimately appear in Japanese/Korean retailer catalogs.

Plus added `nfc-normalization-before-encoding` vector to `static/test-vectors/catalog-macro-substitution.json` — value `cafe\u0301-amsterdam` (NFD, 15 bytes) → expected `caf%C3%A9-amsterdam` (NFC-normalized then encoded). Fixture header updated to note the NFC rule. All 8 vectors verified: NFC normalization + strict-RFC-3986 encoding reproduces each expected byte-exactly.

## #2654 — PHASE_TEMPLATE block (compliance, docs-only)

Two consumers of `substitution_observer_runner` now exist (sales-catalog-driven, creative-generative) with ~150 LOC near-identical three-step phases. Before the third consumer copies-and-drifts, added an advisory `phase_template:` block to `static/compliance/source/test-kits/substitution-observer-runner.yaml` with `<<PLACEHOLDER>>` markers for the five fields that vary across specialisms (specialism slug, domain, catalog_id prefix, correlation_id prefix, template URL). Block is YAML comment, not runtime-enforced — deviation is legitimate; the value is that starting from the template avoids silent drift on the load-bearing fields (`require_every_binding_observed: true`, fixture-lookup binding shape, `requires_contract`).

## #2655 — vector_name authoring-time lint (compliance, new script)

New lint at `scripts/lint-substitution-vector-names.cjs` (120 LOC, mirrors `lint-error-codes.cjs`). Walks every storyboard for `task: expect_substitution_safe` steps, extracts `catalog_bindings[].vector_name`, and asserts each is canonical in `static/test-vectors/catalog-macro-substitution.json`. Also cross-checks the runner contract's `canonical_vector_names` list against the fixture — drift between contract and fixture fails the lint.

Wired in as `test:substitution-vector-names` in the aggregate `test` pipeline. Runs in CI; catches typos (`reserved-character-break0ut`) at build time rather than runtime. Non-canonical bindings with `raw_value`/`expected_encoded` overrides grade as warnings, not errors — custom vectors remain opt-in per the contract.

## Out of scope (still 3.1)

- **#2651 (sales-social observation hook)** — stays 3.1. PM review recommended a narrower pre-GA win (attestation phase + one-line spec note) as separate work; not bundled here to keep this PR focused on pull-forwards that are already-reviewed and ready.
- **#2654 options 2 and 3** (schema `include:` directive, first-class phase_type macro) — stay 3.1 per DX review.
