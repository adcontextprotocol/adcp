# `format_schema` Fetch-Contract Test Fixtures

Reference fixtures for adopters implementing the `format_schema` fetch contract on `product-format-declaration.json#format_schema` (also applies to `platform_extensions[]` refs — the *transport* contract is identical regardless of the field name; only the *consumption* semantics differ).

The normative contract is documented at `static/schemas/source/core/product-format-declaration.json#format_schema` and in `docs/creative/canonical-formats.mdx#format_schema-fetch-contract-normative`. This directory provides paired positive + negative test vectors so reference SDKs (`adcp-client`, `adcp-go`, the Python SDK) converge on the same behavior.

## Layout

- `positive/` — well-formed responses that MUST validate cleanly
- `negative/` — adversarial responses that MUST be rejected per the contract
- Each fixture is a `.json` file describing the test vector (request URI shape, response payload or simulated failure, expected SDK outcome). Where the test requires non-JSON behavior (e.g., HTTP redirect chain, RFC 1918 target), the fixture documents the SETUP that simulates the failure rather than the response body itself.

## Expected SDK outcomes

| Outcome | Meaning |
|---|---|
| `pass` | Fetch + validate succeed; SDK consumes the schema |
| `fail:digest_mismatch` | SHA-256 of body ≠ declared digest; SDK MUST treat as unresolved + surface error |
| `fail:transport` | Scheme / redirect / SSRF / timeout / size violation; SDK MUST refuse to fetch or hard-fail |
| `fail:schema_invalid` | Body parses as JSON but isn't a valid JSON Schema; SDK MUST treat as unresolved |
| `fail:ref_violation` | `$ref` violates sandboxing (cross-origin, depth, count); SDK MUST reject |
| `fail:budget_exceeded` | Schema compile / validation exceeds CPU/memory budget; SDK MUST treat manifest as invalid |

## Categories covered (per the contract's 7 failure modes)

| Category | Positive | Negative |
|---|---|---|
| **Digest verification** | `positive/01_well_formed_digest_match.json` (body matches declared sha256) | `negative/01_digest_mismatch.json` (declared digest ≠ actual sha256) |
| **Transport** | (covered by positive/01 — https + 200 + size + timeout) | `negative/02_http_scheme.json` (http:// rejected), `negative/03_redirect_chain.json` (302/301 followed → MUST fail), `negative/04_oversized_body.json` (>1 MiB → cap during streaming) |
| **SSRF guards** | (covered by transport rules in positive/01) | `negative/05_ssrf_rfc1918.json` (target resolves to 10.0.0.0/8), `negative/06_ssrf_metadata_endpoint.json` (169.254.169.254 / metadata.google.internal) |
| **`$ref` sandboxing** | `positive/02_intra_document_ref.json` (same-origin + intra-document refs only) | `negative/07_ref_cross_origin.json` (cross-origin $ref → reject), `negative/08_ref_depth_exceeded.json` (transitive chain > 8 deep) |
| **Schema-compile budget** | (covered by positive/01) | `negative/09_catastrophic_regex.json` (pattern with exponential backtracking) |
| **Schema validity** | (covered by positive/01 — body is valid Draft 07 JSON Schema) | `negative/10_invalid_schema.json` (body is JSON but not a valid schema) |
| **Graceful degradation** | `positive/03_cached_after_404.json` (cache-hit on previously-fetched URI@digest survives a 404 on re-fetch) | `negative/11_persistent_404.json` (no cache, no previous fetch → SDK MUST treat declaration as unresolved + emit errors[]) |

## Using these fixtures

Reference implementations should write a test runner that walks each fixture, simulates the described condition (using a local HTTP mock, a malformed digest, or a regex-eval timer), and asserts the SDK's outcome matches the fixture's `expected_outcome` field. The test runner is NOT included here — the spec defines behavior, fixtures define test inputs, and each SDK author wires their own runner per language conventions.

[Issue #4699](https://github.com/adcontextprotocol/adcp/issues/4699) tracks adding a cross-SDK conformance harness that walks these fixtures uniformly. Until then: each SDK validates against the fixtures independently and reports outcomes for cross-comparison.

## Field shape (all fixtures)

```jsonc
{
  "test_id": "fetch-contract-01-digest-mismatch",
  "category": "digest_verification" | "transport" | "ssrf" | "ref_sandbox" | "compile_budget" | "schema_validity" | "graceful_degradation",
  "description": "Short prose describing the scenario",
  "setup": {
    // What the test runner needs to arrange — varies by category
    "request_uri": "https://example.invalid/extensions/x",
    "declared_digest": "sha256:abcd...",
    "response_status": 200,
    "response_body_sha256": "sha256:0000...",   // actual body hash (mismatch case)
    "response_body": { /* inline body OR reference */ },
    "response_headers": { "Content-Type": "application/json" }
    // category-specific keys: redirect_chain, body_size_bytes, target_ip, $ref_chain, etc.
  },
  "expected_outcome": "fail:digest_mismatch",
  "expected_error_code": "FORMAT_PROJECTION_FAILED",   // when the SDK should emit a structured advisory
  "rationale": "Why the contract requires this specific outcome — links to the contract clause"
}
```
