---
---

feat(compliance): payload_attestation digest mode for query_upstream_traffic (#3830 item 2)

The fifth and last LOW-priority item from #3830, filed against #3816's expert review. Adds an opt-in digest mode for `query_upstream_traffic` so adopters under privacy/data-residency obligations can support `upstream_traffic` conformance without returning raw outbound payloads to the runner.

**Why**

The product-expert review of #3816 flagged a binary choice in the original contract: adopters either expose raw payload contents through `query_upstream_traffic` (necessary for `payload_must_contain` and `identifier_paths` echo verification) or grade `not_applicable` and lose the anti-façade signal entirely. EU adopters under GDPR processor obligations and US adopters whose sandboxes process production hashed PII can't legally return raw payloads to a runner buffer, even for sandbox diagnostics.

Digest mode preserves the load-bearing `identifier_paths` echo verification while keeping plaintext payloads inside the controller.

**What ships**

`comply-test-controller-request.json`:
- New `attestation_mode: "raw" | "digest"` param (default: `"raw"`).
- New `identifier_value_digests: [<sha256_hex>]` param (max 64). When digest mode, the runner sends SHA-256 of identifier values it wants echo-verified — plaintext identifiers never reach the controller.

`comply-test-controller-response.json`:
- New `attestation_mode` field on `recorded_calls[]` (echoes the request; adopters MAY unilaterally downgrade raw→digest per call when policy requires).
- New `payload_digest_sha256` (lowercase hex, 64 chars) — required when `attestation_mode: digest`. Canonicalized per RFC 8785 / JCS for `application/json` and `*+json`; raw bytes for non-JSON.
- New `payload_length` (integer) — required in digest mode so runners can detect adopter-side truncation.
- New `identifier_match_proofs[]` — per-digest `{ identifier_value_sha256, found: bool }` echo verification.
- `oneOf` discriminator on items: `RawAttestation` (payload required, digest fields absent) or `DigestAttestation` (digest fields required, payload absent). Mixed-mode responses are valid (some calls raw, some digest) — each item picks its own branch.

`storyboard-schema.yaml`:
- New optional `attestation_mode_required: "raw"` on `upstream_traffic`. When set, calls returned in digest mode grade the entire check `not_applicable`. Use sparingly — forcing raw excludes privacy-conscious adopters.
- Documents digest-mode behavior:
  - `payload_must_contain` arbitrary paths: NOT supported in digest mode (per-call `not_applicable`).
  - `identifier_paths`: supported via `identifier_match_proofs[]`.
  - `min_count`, `endpoint_pattern`, `purpose_filter`: unchanged across modes.

`runner-output-contract.yaml`:
- Documents `upstream_traffic_digest_mode` semantics in the synthesized-checks notes block.
- Mixed-mode responses produce partial coverage: digest-mode calls grade `payload_must_contain` not_applicable per entry without poisoning the overall validation; raw-mode calls in the same response continue to be assessed normally.

**Privacy boundary**

Plaintext identifiers never reach the controller (runner sends digests). Plaintext payloads never reach the runner in digest mode (controller emits digest + match-proof booleans). Both directions of the controller↔runner boundary stay closed for raw payload data and identifier values; the only crossing artifacts are SHA-256 digests and presence booleans.

**Trust model unchanged**

Same as #3816: this raises the bar against unintentional façades, not adversarial ones. Adopters self-report `identifier_match_proofs[]` — a determined façade can return `found: true` for any digest. Spec consumers MUST NOT treat digest-mode passing as cryptographic proof of adapter behavior, same as raw mode.

**Out of scope**

- Runner-side digest-mode implementation lives in adcp-client#1253 (tracked separately).
- Reference adopter-side recorder middleware in adcp-client#1290 / adcp-client-python#347 (tracked separately).

**Verification**

- ✅ `node scripts/build-compliance.cjs` passes all 9 lint stages.
- ✅ `npm run test:schemas` 7/7.
- ✅ `npm run test:examples` 36/36 (raw and digest examples validate against their respective oneOf branches).
