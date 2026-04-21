---
---

compliance: substitution-observer-runner test-kit contract + first consumer phase (#2638)

Closes #2638 (contract drafted with v2 fixes from expert review; consumer phases beyond sales-catalog-driven tracked as follow-ups once #2640 merges).

The #2620 rule — sales agents MUST percent-encode catalog-item macro values (unreserved-whitelist, RFC 3986 §2.5 for non-ASCII) before substitution into URL contexts — has a library-level conformance artifact (the unit-test fixture at `static/test-vectors/catalog-macro-substitution.json`). It had no runtime conformance test.

**`static/compliance/source/test-kits/substitution-observer-runner.yaml`** — test-kit contract, shape mirrors `webhook-receiver-runner.yaml`:

- **Normative SSRF policy** in contract body (not deferred to library): explicit IPv4/IPv6 CIDR deny lists (loopback, RFC 1918, link-local incl. 169.254.169.254 IMDS, CGNAT, IPv6 ULA, multicast), cloud metadata hostnames, HTTPS-only scheme allowlist, DNS revalidation, strict `follow_redirects: false`, `host_literal_policy_verified: reject` in AdCP Verified mode.
- **Normative HTML attribute extraction set** — enumerated `tag_attribute_pairs`; `srcset` parsed per-descriptor; script text and comments explicitly out of scope.
- **Normative macro-position alignment algorithm** — parse template + observed URL with same WHATWG URL parser, align query pairs by key, align path segments positionally, compare byte-for-byte.
- **Normative hex case policy** — producers emit uppercase per RFC 3986 §2.1; verifiers use case-insensitive comparison on hex digits inside triplets only.
- **Single-source-of-truth vectors** — contract references fixture by name; `expected_encoded` strings dropped from contract. Vector names aligned to fixture's hyphen convention. No drift risk.
- **Simplified `catalog_bindings`** — `{macro, catalog_item_id, vector_name}`; runner looks up raw_value/expected_encoded from fixture. Custom vectors opt-in via optional override fields.
- **Error-report payload policy** — canonical vectors echo verbatim; custom vectors auto-redact to SHA-256 unless `--include-raw-payloads` flag (default off, disabled in Verified).
- **Split library surface** — `observer/` for runners; sibling `encoder/` for sellers. One library, disjoint APIs.
- **`require_all_bindings_observed` → `require_every_binding_observed`** with default `true`. Closes silent-strip bypass.
- **Collapsed error codes** — `preview_url_fetch_failed` + `preview_body_not_html` merged into `preview_url_unusable` with six sub-reasons including `ssrf_blocked`.
- **`substitution_scheme_injection`** error code added for `javascript:`-scheme injection at href-whole-value positions.
- **Preview/serve divergence** added to out-of-scope v1.
- **Structured `scope:` and `references:` blocks** — machine-readable.
- Fetch tuning: `max_body_bytes` 1 MiB → 256 KiB; `max_connect_seconds: 3`.
- Observation modes renamed: `preview_html_inline` / `preview_url_fetch` → `html_inline` / `url_fetch`.

**`static/test-vectors/catalog-macro-substitution.json`** — added `url-scheme-injection-neutralized` vector. Value `javascript:alert(0)` encodes to `javascript%3Aalert%280%29` per strict RFC 3986 (parens are NOT unreserved — encoders using `encodeURIComponent`-equivalent that leave parens unescaped fail this vector). All 7 vectors verified.

**`static/compliance/source/universal/storyboard-schema.yaml`** — `task: expect_substitution_safe` docs updated to match contract v2 shape.

**`static/compliance/source/specialisms/sales-catalog-driven/index.yaml`** — consumer phase updated to match contract v2: `require_every_binding_observed: true`, simplified bindings (vector_name lookup), `source: html_inline`, `content_id_type: "sku"` declared on probe catalog.

## Out of scope (follow-ups)

- Reference runner implementation (`@adcp/client` `SubstitutionObserver` + `SubstitutionEncoder` split) — adcp-client repo.
- Unicode normalization round-trip (NFC vs NFD) — spec gap, surface in #2620 first.
- Zero-width / invisible-char vectors — additive after NFC resolves.
- Extension to `sales-social` / `creative-generative` once #2640 merges.
- `sales-retail-media` wiring — retail-media epic per #2640.
