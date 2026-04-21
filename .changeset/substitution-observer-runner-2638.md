---
---

compliance: substitution-observer-runner test-kit contract + first consumer phase (#2638)

Closes #2638 (contract drafted; consumer phases beyond sales-catalog-driven tracked as follow-ups once #2640 merges).

The #2620 rule — sales agents MUST percent-encode catalog-item macro values (unreserved-whitelist, RFC 3986 §2.5 for non-ASCII) before substitution into URL contexts — has a library-level conformance artifact (the 6-vector unit-test fixture at `static/test-vectors/catalog-macro-substitution.json`). It had no runtime conformance test.

This PR lands the runtime side:

**`static/compliance/source/test-kits/substitution-observer-runner.yaml`** — new test-kit contract specifying how a black-box runner observes substituted tracker URLs in creative previews and asserts encoding safety. Mirrors the shape of `webhook-receiver-runner.yaml`:

- Two observation modes: `preview_html_inline` (default for lint/fast) parses `preview_html` from the response; `preview_url_fetch` (default for AdCP Verified) fetches `preview_url` over HTTPS with SSRF allowlist enforcement.
- `attacker_value_catalog` cross-references the 6 canonical vectors from the unit-test fixture so library-level and runtime-level conformance exercise the same payloads.
- `step_task: expect_substitution_safe` documented with full argument shape and 6 error modes (`substitution_encoding_violation`, `nested_macro_re_expansion`, `substitution_binding_missing`, `preview_source_unavailable`, `preview_url_fetch_failed`, `preview_body_not_html`).
- `client_primitives.substitution_observer` reserves the proposed `@adcp/client` surface (`parse_html`, `fetch_and_parse`, `assert_rfc3986_safe`, `assert_no_nested_expansion`) so conformance and production code paths share one implementation.
- Out-of-scope v1: non-catalog macros, HTML-attribute contexts, VAST XML, post-impression log introspection. All explicitly called out with rationale.

**`static/compliance/source/universal/storyboard-schema.yaml`** — registered `task: expect_substitution_safe` alongside the webhook task types so runners and storyboards share a single schema.

**`static/compliance/source/specialisms/sales-catalog-driven/index.yaml`** — new `substitution_safety` phase inserted between `catalog_sync` and `create_buy`. Three steps:

1. `sync_attacker_shaped_catalog` — pushes three of the canonical attacker-shaped values (reserved-char breakout, nested-expansion preservation, non-ASCII UTF-8) as catalog items.
2. `build_catalog_aware_creative` — builds a creative with `{SKU}` in impression/click trackers and `include_preview: true`.
3. `expect_substitution_safe` — gated on `substitution_observer_runner`. Runners that do not advertise the contract grade this step `not_applicable`; the earlier two steps still run and exercise the catalog-acceptance and build paths unconditionally.

Extending the `expect_substitution_safe` pattern to `sales-social` and `creative-generative` (both of which add their catalog phases in #2640) is tracked as a follow-up — not bundled here to keep this PR off a pre-#2640 main and avoid merge conflicts.

## Out of scope (follow-ups)

- Reference runner implementation (adcp-client `SubstitutionObserver`) — tracked separately in the adcp-client repo once the contract YAML is reviewed.
- Extension to `sales-social` / `creative-generative` once #2640 merges.
- `sales-retail-media` wiring — waits for the retail-media epic per #2640's scoping.
- Spec-level expansion of the #2620 rule to HTML-attribute contexts — explicitly deferred per #2620.

No schema change. No spec change. New phase grades not_applicable for existing runners, so no conformance regression.
