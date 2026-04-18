---
"adcontextprotocol": patch
---

Tighten the AdCP RFC 9421 request-signing profile on interop and security-critical points surfaced by the TypeScript reference SDK implementation (adcp-client#575) and expert review. All changes are clarifications within the 3.0 substrate, not new behavior for signers that already match the reference vectors.

**Binary value encoding pinned (#2341).** `Signature` and `Content-Digest` sf-binary tokens are normatively **base64url without padding** (RFC 4648 §5), overriding RFC 8941 §3.3.5's standard-base64 default. Matches the existing `nonce` rule; avoids two proxy hazards — `/` that some intermediaries rewrite and `=` that some structured-field parsers treat as a parameter delimiter. Verifiers MUST accept base64url-no-padding. A time-bounded SHOULD lets verifiers lenient-decode pure standard-base64 through AdCP 3.2 for counterparties predating this clarification, with a hard MUST-reject on **mixed-alphabet tokens** (any char in `[+/=]` plus any char in `[-_]` in the same value) to close the ambiguity where a mixed token could decode to different bytes across verifiers and let an attacker stage a `Content-Digest` mismatch. Shipped positive vectors already encode base64url-no-padding; no regeneration.

**URL canonicalization algorithm expanded (#2343).** The `@target-uri` algorithm in `security.mdx` now:

- **Pins UTS-46 Nontransitional** (CheckHyphens=true, CheckBidi=true, UseSTD3ASCIIRules=true, Transitional_Processing=false) for IDN → Punycode. Closes the single largest silent divergence between the three reference SDKs — TypeScript, Go, and Python all default differently.
- **Rejects IPv6 zone identifiers** (RFC 6874) in signed URLs. Zone-ids are node-local per RFC 6874 §1 and have no meaning outside the signing host; an attacker signing `https://[fe80::1%25eth0]/op` on their LAN gains no verifiable identity at a remote verifier. Signers MUST NOT sign; verifiers MUST reject.
- **Preserves consecutive slashes byte-for-byte** (was: collapsed). Preserving closes a path-confusion attack surface — a signer that canonicalizes `/admin//foo` → `/admin/foo` while the server routes `/admin//foo` to a different handler lets an attacker sign one URL and execute another. Deployments MUST disable slash-folding on signed routes (`nginx merge_slashes off`, Express no pre-normalization, Go 1.22+ `http.ServeMux` with explicit handler).
- **Expands malformed-authority rejection** to cover bracket-mismatch IPv6 (`https://[::1/p`), bare IPv6 (`https://fe80::1/p`), empty authority (`https:///p`), userinfo-only (`https://user@/p`), port-only (`https://:443/p`), and raw non-ASCII host bytes.
- **`@authority` is derived from the wire `Host`** header (or HTTP/2+ `:authority` pseudo-header), not from reverse-proxy state; MUST byte-for-byte equal the canonical authority from `@target-uri`. Closes a cross-vhost replay vector on shared verifier pools.
- **Percent-encoding normalization** is spelled out for both directions: reserved characters stay encoded (`%3A` → `%3A`), unreserved are decoded per the full RFC 3986 §2.3 set (`%41` → `A`, not just `%7E` → `~`).
- **Combined dot-segment + consecutive-slash cases** (`/a/.//b` → `/a//b`, `/a//../b` → `/a/b`) are pinned explicitly; parsers that treat `//` as a single boundary produce wrong output.

**New conformance file: `canonicalization.json`.** Ships 31 fixed-input/expected-output cases (25 positive, 6 malformed-reject) exercising every step of the canonicalization algorithm, version-pinned to the 3.0 profile. Independent of crypto — SDKs can run the set without keys or a full verifier harness, making it the fastest way to surface cross-implementation divergence. Published at `/compliance/{version}/test-vectors/request-signing/canonicalization.json`.

**New error code: `request_target_uri_malformed`** in the transport error taxonomy. The previous profile used `request_signature_header_malformed` for both actual header malformation and URL-parse rejections — semantically confusing since URL rejections happen before any signature header is inspected. The new code covers empty authority, bare IPv6, IPv6 zone identifiers, bracket-mismatch, raw non-ASCII host, and `@authority` / `Host` mismatch. `request_signature_header_malformed` continues to cover actual `Signature` / `Signature-Input` header problems and `Signature` / `Content-Digest` mixed-alphabet rejection.

Closes #2341, #2343. Original profile: #2323 (3.0 GA).
