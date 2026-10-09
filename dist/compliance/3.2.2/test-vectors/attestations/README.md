# Portable attestation vectors

These vectors exercise the shared AdCP attestation trust and resolution contract. They are served at `/compliance/{version}/test-vectors/attestations/vectors.json`.

The vectors deliberately use a fictional proof format. Portable attestations allow open proof formats, so cryptographic verification bytes are format-specific and belong in each format's own suite. Here, `resolver_result.signature_valid` represents the mathematical signature check and `signing_key_authorized_for_issuer` represents the format-specific authenticated issuer-key binding. Both must pass. The vectors test the shared behavior around that verifier: allowlist checks, delivery selection, validity, revocation, subject and digest comparison, stable outcomes, and the no-network rule for off-policy inputs.

Conformance runners MUST:

1. validate each `presentation` against `/schemas/core/attestation-reference.json`;
2. validate `capabilities` against `/schemas/core/attestation-capabilities.json`;
3. evaluate at `evaluation_time` using the [portable-attestation procedure](/docs/building/by-layer/L1/security#portable-attestations);
4. produce `expected.outcome`; and
5. perform exactly `expected.network_requests` outbound resolution requests.

`credential_bytes` is the UTF-8 credential representation whose SHA-256 is compared to `presentation.content_digest`. It is supplied explicitly so implementations do not silently substitute their native JSON serializer. Dual-delivery vectors also carry `embedded_result`; conformance requires independent proof verification and digest comparison of both the resolved and embedded bytes.
