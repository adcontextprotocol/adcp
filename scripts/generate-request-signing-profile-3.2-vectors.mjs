#!/usr/bin/env node
/**
 * Generates the AdCP 3.2 request-signing conformance vectors that mirror the
 * legacy 3.1 corpus with `content-digest` covered (adcp#7733).
 *
 * Every legacy vector in `positive/` and `negative/` is pinned to the 3.1
 * profile and most of them sign without `content-digest`. A verifier that
 * advertises `covers_content_digest: "required"` — the only posture a 3.2
 * signing peer may advertise — cannot grade them. This script derives a
 * 3.2 counterpart for each legacy positive vector and for each legacy negative
 * that tests checklist steps 2–12, plus the step-0 and step-1 negatives
 * (adcp#7733), under `profile-3.2/{positive,negative}/`. Each counterpart keeps
 * the SAME number and slug as the root vector it mirrors; root vectors that
 * are not mirrored leave gaps (negative/018 is the only intentional one:
 * `forbidden` is illegal in 3.2). Root positive/001
 * and positive/002 are both covered by the pre-existing hand-authored
 * profile-3.2/positive/001-post-with-content-digest (in 3.2 a basic POST is a
 * POST with content-digest), so they are not generated here.
 *
 * Derivation rules:
 * - Request shape (method, URL, body, sig-params) comes from the immutable
 *   legacy vector; only the body's idempotency_key is re-keyed so the 3.2
 *   vector is a distinct request.
 * - `Content-Digest` is sha-256 over the exact body bytes, RFC 8941 sf-binary
 *   (standard Base64, padded). `Signature` uses the same encoding.
 * - Covered components add `content-digest` (except the vector whose whole
 *   point is that it is missing).
 * - Canonical `@target-uri` / `@authority` values are read from the legacy
 *   vector's committed `expected_signature_base`, which SDKs have already
 *   cross-checked; the test suite recomputes them independently.
 * - Positive vectors and the post-crypto negatives (digest mismatch, replay)
 *   carry real signatures from the test keys in keys.json. Pre-crypto
 *   negatives keep the legacy 64-zero-byte placeholder so a verifier that runs
 *   crypto before the targeted check fails with `request_signature_invalid`
 *   (step-ordering canary), exactly like their 3.1 originals.
 * - Step-0/1 mirrors (adcp#7733) are single-fault: covering `content-digest`
 *   removes the step-6 fault a `required` verifier would otherwise find first.
 *   Where the fault does not depend on the signature bytes (021–024, 026,
 *   029–031) the Signature is real, so a signature the verifier can validate
 *   is not a second fault; 019 is a real Signature whose Signature-Input was
 *   stripped. 011 (unparseable Signature-Input, so no base exists) keeps the
 *   placeholder. Unsigned vectors (001, 027, 028) stay unsigned and carry only
 *   a correct Content-Digest. Duplicated members (023, 029, 030) repeat the
 *   same correct value so that keeping either member finds no second fault.
 * - Per-definition overrides: `paramsFrom` reads sig-params from another
 *   legacy vector (019 has no Signature-Input of its own), `keepHeaders`
 *   carries a legacy header such as Host, and `kind` selects unsigned /
 *   malformed-input / signature-only shapes. The test suite recomputes the
 *   base independently where a Signature-Input exists and otherwise checks
 *   the committed base.
 *
 * Ed25519 is deterministic. ES256 (ECDSA) is not, so an existing ES256
 * signature is kept whenever it still verifies over the regenerated base;
 * this keeps `--check` stable.
 *
 * Usage:
 *   node scripts/generate-request-signing-profile-3.2-vectors.mjs          # write
 *   node scripts/generate-request-signing-profile-3.2-vectors.mjs --check  # verify committed files are current
 *
 * The keys in keys.json are public test keys. Never use them in production.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTOR_DIR = join(ROOT, 'static/compliance/source/test-vectors/request-signing');
const PROFILE_DIR = join(VECTOR_DIR, 'profile-3.2');
const SCRIPT = 'scripts/generate-request-signing-profile-3.2-vectors.mjs';

const DIGEST_COMPONENTS = ['@method', '@target-uri', '@authority', 'content-type', 'content-digest'];
const ZERO_SIGNATURE = Buffer.alloc(64).toString('base64');
const PROFILE_NOTE =
  'AdCP 3.2 profile: the signature covers content-digest, binary values use RFC 8941 sf-binary (standard padded Base64), and the verifier advertises covers_content_digest=\'required\'.';
const UNSIGNED_PROFILE_NOTE =
  'AdCP 3.2 profile: the verifier advertises covers_content_digest=\'required\' and the request carries a correct Content-Digest, but no usable signature is presented, so the step-0 fault is the only fault.';
const MALFORMED_PROFILE_NOTE =
  'AdCP 3.2 profile: the verifier advertises covers_content_digest=\'required\' and the request carries a correct Content-Digest.';
const PLACEHOLDER_NOTE =
  'Signature is the 64-zero-byte placeholder (step-ordering canary): the targeted check runs before cryptographic verification, so a verifier that verifies first returns request_signature_invalid instead of the expected code.';

const keys = JSON.parse(readFileSync(join(VECTOR_DIR, 'keys.json'), 'utf8')).keys;

/**
 * Vector definitions. `from` is the legacy source vector; the profile-3.2
 * output path is the same relative path (same number and slug).
 */
const DEFINITIONS = [
  // ── Positive ────────────────────────────────────────────────────────────
  {
    from: 'positive/003-es256-post.json',
    name: 'AdCP 3.2 POST with ES256 algorithm (edge-runtime profile), content-digest covered',
    comment: 'ES256 signature uses IEEE P1363 (r||s) encoding per RFC 9421 §3.3.2. ECDSA is non-deterministic: verifiers MUST accept it; signers are not expected to reproduce the bytes.',
  },
  {
    from: 'positive/004-multiple-signature-labels.json',
    name: 'AdCP 3.2 multiple Signature-Input labels — verifier MUST process exactly one (sig1, content-digest covered)',
    extraLabel: {
      label: 'sig2',
      components: ['@method', '@target-uri'],
      nonce: 'DIFFERENT-NONCE-FOR-SIG2____',
    },
    expectedOutcome: { success: true, verified_label: 'sig1' },
    comment: 'sig1 is a valid signature covering content-digest. sig2 has a different covered-components set, a different nonce, and a zero-byte signature that would not verify. Verifiers MUST process exactly one Signature-Input label (conventionally sig1) and MUST ignore additional labels; attempting to verify sig2 and rejecting is non-conformant.',
  },
  {
    from: 'positive/005-default-port-stripped.json',
    name: 'AdCP 3.2 URL has explicit :443 port; canonicalization strips it (content-digest covered)',
  },
  {
    from: 'positive/006-dot-segment-path.json',
    name: 'AdCP 3.2 URL path has a /./ segment; canonicalization collapses it (content-digest covered)',
  },
  {
    from: 'positive/007-query-byte-preserved.json',
    name: 'AdCP 3.2 URL query string preserves byte order, not alphabetized (content-digest covered)',
  },
  {
    from: 'positive/008-percent-encoded-path.json',
    name: 'AdCP 3.2 URL path percent-encoded bytes normalized to uppercase hex (content-digest covered)',
  },
  {
    from: 'positive/009-percent-encoded-unreserved-decoded.json',
    name: 'AdCP 3.2 URL path percent-encoded unreserved bytes decoded per RFC 3986 §6.2.2.2 (content-digest covered)',
  },
  {
    from: 'positive/010-percent-encoded-slash-preserved.json',
    name: 'AdCP 3.2 URL path with %2F (reserved) preserved literally through remove_dot_segments (content-digest covered)',
  },
  {
    from: 'positive/011-ipv6-authority.json',
    name: 'AdCP 3.2 IPv6 literal authority; brackets preserved in @target-uri and @authority (content-digest covered)',
  },
  {
    from: 'positive/012-ipv6-authority-default-port-stripped.json',
    name: 'AdCP 3.2 IPv6 literal authority with explicit :443; port stripped, brackets preserved (content-digest covered)',
  },

  {
    from: 'positive/013-two-signature-labels-distinct.json',
    name: 'AdCP 3.2 two distinct labels on both Signature-Input and Signature — verifier processes sig1 and does not reject the dictionaries (content-digest covered)',
    extraLabel: {
      label: 'sig2',
      components: ['@method', '@target-uri', '@authority'],
      nonce: 'm4Fq2xYt9ZbCwLJd7sVn8g',
      signatureFromLegacy: true,
    },
    expectedOutcome: { success: true, verified_label: 'sig1' },
    comment: 'False-positive guard for negative/029 and 021. sig1 is a valid signature covering content-digest. sig2 has a different covered-components set, a different nonce, and a well-formed 64-byte value (the root vector\'s bytes, re-encoded as standard padded Base64) that does not verify. Verifiers MUST process exactly one label (conventionally sig1) and ignore the rest; attempting sig2 and rejecting is non-conformant.',
  },
  {
    from: 'positive/014-content-digest-two-algorithms.json',
    name: 'AdCP 3.2 Content-Digest carries sha-256 and sha-512, both correct — distinct algorithm keys are legal (content-digest covered)',
    contentDigest: body => `${contentDigestFor(body)}, ${contentDigestFor(body, 'sha512')}`,
    comment: 'False-positive guard for negative/023 and 030. Both members are the correct digest of the body in standard padded Base64, and the Signature is a real Ed25519 signature over expected_signature_base, which carries the Content-Digest value verbatim.',
  },
  {
    from: 'positive/015-bracketed-ipv6-host-with-port.json',
    name: 'AdCP 3.2 bracketed IPv6 literal with non-default port in both the URL and the Host header (content-digest covered)',
    keepHeaders: ['Host'],
    comment: 'False-positive guard for negative/031. The Host header byte-matches the authority of the canonical @target-uri, so @authority is [2001:db8::1]:8443 and the request verifies.',
  },

  // ── Negative (checklist steps 2–12) ─────────────────────────────────────
  {
    from: 'negative/002-wrong-tag.json',
    name: 'AdCP 3.2 signature tag is not adcp/request-signing/v1 (content-digest covered)',
    params: { tag: 'example-org/signing/v1' },
    placeholder: true,
  },
  {
    from: 'negative/003-expired-signature.json',
    name: 'AdCP 3.2 signature expired more than 60 s ago (content-digest covered)',
    params: { created: 1776520000, expires: 1776520300 },
    placeholder: true,
  },
  {
    from: 'negative/004-window-too-long.json',
    name: 'AdCP 3.2 signature validity window exceeds 300 s maximum (content-digest covered)',
    params: { expires: 1776522000 },
    placeholder: true,
  },
  {
    from: 'negative/005-alg-not-allowed.json',
    name: 'AdCP 3.2 signature alg is rsa-pss-sha512, not in AdCP allowlist (content-digest covered)',
    params: { alg: 'rsa-pss-sha512' },
    placeholder: true,
  },
  {
    from: 'negative/006-missing-covered-component.json',
    name: 'AdCP 3.2 covered components missing @authority (content-digest covered)',
    components: ['@method', '@target-uri', 'content-type', 'content-digest'],
    placeholder: true,
  },
  {
    from: 'negative/007-missing-content-digest.json',
    name: 'AdCP 3.2 signature on a body-bearing request omits content-digest from covered components',
    components: ['@method', '@target-uri', '@authority', 'content-type'],
    placeholder: true,
    comment: 'Under the 3.2 profile, checklist step 6 rejects any body-bearing signature that does not cover content-digest, regardless of operation. The request deliberately still carries a correct Content-Digest header: verifiers MUST check the covered-components list, not mere header presence.',
  },
  {
    from: 'negative/008-unknown-keyid.json',
    name: 'AdCP 3.2 keyid does not match any entry in the signer\'s JWKS (content-digest covered)',
    params: { keyid: 'not-a-real-kid' },
    placeholder: true,
  },
  {
    from: 'negative/009-key-ops-missing-verify.json',
    name: 'AdCP 3.2 presented JWK is scoped to governance signing, adcp_use != request-signing (content-digest covered)',
    params: { keyid: 'test-gov-2026' },
    placeholder: true,
    comment: 'The keyid test-gov-2026 resolves to a JWK in keys.json with adcp_use=\'governance-signing\'. Per step 8, the verifier MUST reject because adcp_use is not \'request-signing\'.',
  },
  {
    from: 'negative/010-content-digest-mismatch.json',
    name: 'AdCP 3.2 Content-Digest header does not match SHA-256 of received body',
    contentDigest: `sha-256=:${Buffer.alloc(32).toString('base64')}:`,
    comment: 'The Content-Digest header asserts the sha-256 of 32 zero bytes, which is not the digest of the body. The Signature IS a valid Ed25519 signature by test-ed25519-2026 over expected_signature_base (which includes the header value as sent), so step 10 passes and step 11 fails. Rejecting earlier with request_signature_invalid is non-conformant for this vector.',
  },
  {
    from: 'negative/012-missing-expires-param.json',
    name: 'AdCP 3.2 Signature-Input is missing the required \'expires\' parameter (content-digest covered)',
    params: { expires: null },
    placeholder: true,
  },
  {
    from: 'negative/013-expires-le-created.json',
    name: 'AdCP 3.2 signature expires equals created, zero-length validity window (content-digest covered)',
    params: { expires: 1776520800 },
    placeholder: true,
  },
  {
    from: 'negative/014-missing-nonce-param.json',
    name: 'AdCP 3.2 Signature-Input is missing the required \'nonce\' parameter (content-digest covered)',
    params: { nonce: null },
    placeholder: true,
  },
  {
    from: 'negative/015-signature-invalid.json',
    name: 'AdCP 3.2 Signature is well-formed but cryptographically invalid over the signature base (content-digest covered)',
    placeholder: true,
    includeBase: true,
    comment: 'Signature-Input has the same shape as profile-3.2/positive/001-post-with-content-digest; the body (and therefore the Content-Digest) differs. Signature contains 64 zero bytes (standard Base64: 86 \'A\'s plus \'==\' padding), which is not a valid Ed25519 signature over any base. The verifier passes steps 1–9 and fails at step 10. Run profile-3.2/positive/001 first: an implementation that fails both has a canonicalization bug, not a crypto bug.',
  },
  {
    from: 'negative/016-replayed-nonce.json',
    name: 'AdCP 3.2 second submission of a previously-accepted (keyid, nonce) within the replay window (content-digest covered)',
    harnessComment: 'Pre-populate the replay cache as if this exact request was just verified. Harness sets replay_cache[(test-ed25519-2026, KXYnfEfJ0PBRZXQyVXfVQA)] = valid-until 1776521100.',
    comment: 'This vector has the same shape as root negative/016 with content-digest covered, and is submitted after the replay cache has already recorded the (keyid, nonce) pair. The Signature is a valid Ed25519 signature by test-ed25519-2026 over expected_signature_base, so steps 1–11 pass. White-box harnesses MAY inject the cache entry directly (see test_harness_state). Black-box runners SHOULD send the request twice in sequence per test-kits/signed-requests-runner.yaml → stateful_vector_contract.replay_window; the first submission is accepted as a real create_media_buy and MUST be sent against a sandbox endpoint only (see endpoint_scope in the test-kit), the second MUST be rejected at step 12 with request_signature_replayed without reaching step 13\'s cache insert. The side_effects: mutating marker is a belt-and-suspenders signal for consumers that read vectors outside the storyboard runner: the black-box path for this vector has a first-request side effect by design.',
  },
  {
    from: 'negative/017-key-revoked.json',
    name: 'AdCP 3.2 signing keyid is listed in the revocation list (content-digest covered)',
    params: { keyid: 'test-revoked-2026' },
    placeholder: true,
    comment: 'Revocation (step 9) runs BEFORE cryptographic verification (step 10). A crypto-first verifier returns request_signature_invalid instead of request_signature_key_revoked, which is a graded mismatch and an exploitable step-ordering bug (cheap amplification on revoked-key replay). Black-box runners rely on the agent pre-configuring test-revoked-2026 as revoked per test-kits/signed-requests-runner.yaml → stateful_vector_contract.revocation.',
  },
  {
    from: 'negative/020-rate-abuse.json',
    name: 'AdCP 3.2 per-keyid replay cache entry cap exceeded (content-digest covered)',
    placeholder: true,
    comment: 'When the per-keyid replay cache has reached its configured cap, new signatures from that keyid MUST be rejected with request_signature_rate_abuse — not silently evicted, not accepted. The nonce is fresh; the rejection is due to the cap, not replay. The cap check (step 9a) runs BEFORE crypto verify (step 10); a crypto-first verifier returns request_signature_invalid instead. Black-box runners target the cap declared in test-kits/signed-requests-runner.yaml → stateful_vector_contract.rate_abuse.',
  },
  {
    from: 'negative/025-jwk-alg-crv-mismatch.json',
    name: 'AdCP 3.2 JWK declares alg=EdDSA but crv=P-256, parameter mismatch on presented key (content-digest covered)',
    placeholder: true,
  },
  // ── Negative (pre-check 0 and checklist step 1, adcp#7733) ─────────────
  // These are single-fault under `required`: content-digest is covered (where
  // a Signature-Input exists), so the step-0/1 fault is the only one.
  {
    from: 'negative/001-no-signature-header.json',
    name: 'AdCP 3.2 unsigned request to an operation in required_for (Content-Digest sent, nothing signed)',
    kind: 'unsigned',
  },
  {
    from: 'negative/011-malformed-header.json',
    name: 'AdCP 3.2 Signature-Input present but syntactically invalid (downgrade protection; Content-Digest sent)',
    kind: 'malformed-input',
    comment: 'The Signature-Input value is not parseable, so there is no covered-components list in which content-digest could be covered and no signature base to sign.',
  },
  {
    from: 'negative/019-signature-without-signature-input.json',
    name: 'AdCP 3.2 Signature header present but Signature-Input header absent (downgrade loophole; content-digest covered in the stripped shape)',
    kind: 'signature-only',
    paramsFrom: 'positive/001-basic-post.json',
    // Pre-check bullets are ordered in the spec (required_for with no credential, then the header pair), so an
    // operation outside required_for keeps the header-pair rule the only rule that applies.
    requiredFor: [],
    comment: 'The operation is not in required_for, so the unpaired Signature is the only fault whatever order the pre-check bullets are read in. The request is a correctly signed 3.2 request (content-digest covered) whose Signature-Input a proxy stripped. The Signature is a real Ed25519 signature by test-ed25519-2026 over expected_signature_base, the base the stripped Signature-Input would have described; no other fault is present, so rejecting at step 1 is the only conformant outcome.',
  },
  {
    from: 'negative/021-duplicate-signature-input-label.json',
    name: 'AdCP 3.2 Signature-Input header declares label \'sig1\' twice (malformed structured dictionary, content-digest covered)',
    dupLabel: {
      components: ['@method', '@target-uri'],
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    },
    comment: 'The first sig1 member covers content-digest and its Signature is a valid Ed25519 signature over expected_signature_base, so the duplicate label is the only fault. The second sig1 member keeps the root vector\'s weaker component set, so a verifier that silently keeps one member accepts or rejects depending on which one it keeps; the only conformant outcome is rejecting the duplicate at step 1.',
  },
  {
    from: 'negative/022-multi-valued-content-type.json',
    name: 'AdCP 3.2 Content-Type header sent as multiple field values (malformed — covered field must be single-valued, content-digest covered)',
    comment: 'The Signature is a valid Ed25519 signature over expected_signature_base, which carries the Content-Type value exactly as sent, so the multi-valued field is the only fault.',
  },
  {
    from: 'negative/023-multi-valued-content-digest.json',
    name: 'AdCP 3.2 Content-Digest header sent as multiple field values (malformed, content-digest covered)',
    contentDigest: body => `${contentDigestFor(body)}, ${contentDigestFor(body)}`,
    comment: 'Both Content-Digest members are the correct sha-256 of the body, so a verifier that keeps either one finds a matching digest. The Signature is a valid Ed25519 signature over expected_signature_base, which carries the Content-Digest value exactly as sent, so the repeated algorithm is the only fault.',
  },
  {
    from: 'negative/024-unquoted-string-param.json',
    name: 'AdCP 3.2 Signature-Input sig-param string value sent unquoted (keyid=foo instead of keyid="foo", content-digest covered)',
    unquotedParams: ['keyid'],
    comment: 'The Signature is a valid Ed25519 signature over expected_signature_base, which carries the sig-params exactly as sent (unquoted keyid), so the unquoted string is the only fault.',
  },
  {
    from: 'negative/026-non-ascii-host.json',
    name: 'AdCP 3.2 URL authority contains raw IDN U-label (non-ASCII bytes in host, content-digest covered)',
    comment: 'The Signature is a valid Ed25519 signature over the base for the A-label form of the host (xn--bcher-kva.example.com), the base a signer that canonicalized correctly would produce. A verifier that silently re-normalizes the U-label would therefore verify the signature; docs/reference/url-canonicalization.mdx requires the comparer to reject a raw non-ASCII host instead, so the raw U-label on the wire is the only fault. The expected code follows root 026 (request_target_uri_malformed at step 10, per the maintainer decision on adcp#7905).',
  },
  {
    from: 'negative/027-webhook-registration-authentication-unsigned.json',
    name: 'AdCP 3.2 webhook registration with push_notification_config.authentication over bearer (unsigned); operation NOT in required_for (Content-Digest sent)',
    kind: 'unsigned',
  },
  {
    from: 'negative/028-unsigned-protocol-method-required.json',
    name: 'AdCP 3.2 unsigned tasks/cancel JSON-RPC POST; method is in protocol_methods_required_for (Content-Digest sent)',
    kind: 'unsigned',
  },
  {
    from: 'negative/029-duplicate-signature-label.json',
    name: 'AdCP 3.2 Signature header declares label \'sig1\' twice (malformed structured dictionary, content-digest covered)',
    duplicateSignature: true,
    comment: 'Signature-Input carries sig1 exactly once, covers content-digest, and is well formed; only the Signature header repeats the label. Both Signature members are the same valid Ed25519 signature over expected_signature_base, so a verifier that keeps either one verifies it and the repeated label is the only fault.',
  },
  {
    from: 'negative/030-content-digest-key-case.json',
    name: 'AdCP 3.2 Content-Digest carries SHA-256 and sha-256 (uppercase dictionary key is not a case-insensitive synonym, content-digest covered)',
    contentDigest: body => `${contentDigestFor(body).replace(/^sha-256/, 'SHA-256')}, ${contentDigestFor(body)}`,
    comment: 'Both members are the correct digest of the body in standard padded Base64, and the Signature is a valid Ed25519 signature over expected_signature_base, which carries the Content-Digest value exactly as sent, so the uppercase key is the only fault.',
  },
  {
    from: 'negative/031-malformed-host-authority.json',
    name: 'AdCP 3.2 Host header carries an unbracketed IPv6 literal (malformed authority) while the URL is clean (content-digest covered)',
    keepHeaders: ['Host'],
    comment: 'The URL is the valid bracketed form and the Signature is a real Ed25519 signature over the base computed from the URL authority [::1], so the Host header is the only fault. A verifier that derives @authority from the URL alone verifies it.',
  },
];

function keyByKid(kid) {
  const key = keys.find(entry => entry.kid === kid);
  if (!key) throw new Error(`keys.json has no key ${kid}`);
  return key;
}

function privateKeyFor(jwk) {
  const { _private_d_for_test_only: d, kty, crv, x, y } = jwk;
  return createPrivateKey({ key: { kty, crv, x, ...(y ? { y } : {}), d }, format: 'jwk' });
}

function publicKeyFor(jwk) {
  const { kty, crv, x, y } = jwk;
  return createPublicKey({ key: { kty, crv, x, ...(y ? { y } : {}) }, format: 'jwk' });
}

function signBase(jwk, base) {
  const data = Buffer.from(base, 'utf8');
  if (jwk.kty === 'OKP') return sign(null, data, privateKeyFor(jwk));
  return sign('sha256', data, { key: privateKeyFor(jwk), dsaEncoding: 'ieee-p1363' });
}

function verifyBase(jwk, base, signature) {
  const data = Buffer.from(base, 'utf8');
  if (jwk.kty === 'OKP') return verify(null, data, publicKeyFor(jwk), signature);
  return verify('sha256', data, { key: publicKeyFor(jwk), dsaEncoding: 'ieee-p1363' }, signature);
}

function contentDigestFor(body, algorithm = 'sha256') {
  const label = algorithm === 'sha512' ? 'sha-512' : 'sha-256';
  return `${label}=:${createHash(algorithm).update(body, 'utf8').digest('base64')}:`;
}

/** Parse the legacy sig1 parameters into an ordered map. */
function legacySigParams(legacy) {
  const input = legacy.request.headers['Signature-Input'];
  const match = /^sig1=\(([^)]*)\)((?:;[^,]*)?)/.exec(input);
  if (!match) throw new Error(`${legacy.__file}: cannot parse legacy Signature-Input`);
  const params = new Map();
  for (const part of match[2].split(';').filter(Boolean)) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    params.set(name, raw.startsWith('"') ? JSON.parse(raw) : Number.isNaN(Number(raw)) ? raw : Number(raw));
  }
  return params;
}

/** Decode a legacy Base64URL (or Base64) sf-binary member of the Signature header. */
function legacySignatureBytes(legacy, label) {
  const token = new RegExp(`${label}=:([^:]+):`).exec(legacy.request.headers.Signature)?.[1];
  if (!token) throw new Error(`${legacy.__file}: no ${label} Signature member`);
  const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 64) throw new Error(`${legacy.__file}: ${label} is ${bytes.length} bytes, expected 64`);
  return bytes;
}

function serializeParams(components, params, unquoted = []) {
  const list = `(${components.map(c => `"${c}"`).join(' ')})`;
  const parts = [];
  for (const [name, value] of params) {
    if (value === null || value === undefined) continue;
    parts.push(typeof value === 'number' || unquoted.includes(name) ? `${name}=${value}` : `${name}="${value}"`);
  }
  return `${list}${parts.length ? `;${parts.join(';')}` : ''}`;
}

/** Canonical @target-uri / @authority from the legacy committed signature base. */
function canonicalFromLegacy(legacy) {
  const base = legacy.expected_signature_base;
  if (base) {
    const target = /^"@target-uri": (.*)$/m.exec(base)?.[1];
    const authority = /^"@authority": (.*)$/m.exec(base)?.[1];
    if (target && authority) return { target, authority };
  }
  // Legacy negatives without a committed base all target the default endpoint.
  if (legacy.request.url === 'https://seller.example.com/adcp/create_media_buy') {
    return { target: legacy.request.url, authority: 'seller.example.com' };
  }
  throw new Error(`${legacy.__file}: no canonical @target-uri available`);
}

function componentValue(component, request, canonical) {
  switch (component) {
    case '@method':
      return request.method.toUpperCase();
    case '@target-uri':
      return canonical.target;
    case '@authority':
      return canonical.authority;
    case 'content-type':
      return request.headers['Content-Type'];
    case 'content-digest':
      return request.headers['Content-Digest'];
    default:
      throw new Error(`unsupported component ${component}`);
  }
}

function signatureBase(components, serializedParams, request, canonical) {
  return [
    ...components.map(c => `"${c}": ${componentValue(c, request, canonical)}`),
    `"@signature-params": ${serializedParams}`,
  ].join('\n');
}

function rekeyBody(body, legacyFile, outFile) {
  const legacyKey = `vector-${legacyFile.replace('/', '-').replace(/\.json$/, '')}`;
  const newKey = `vector-profile-3-2-${outFile.replace('/', '-').replace(/\.json$/, '')}`;
  if (!body.includes('"idempotency_key"')) return body;
  const needle = `"idempotency_key":"${legacyKey}"`;
  if (!body.includes(needle)) throw new Error(`${legacyFile}: expected idempotency_key ${legacyKey}`);
  return body.replace(needle, `"idempotency_key":"${newKey}"`);
}

function readExisting(outFile) {
  const path = join(PROFILE_DIR, outFile);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function buildVector(def) {
  const legacy = JSON.parse(readFileSync(join(VECTOR_DIR, def.from), 'utf8'));
  legacy.__file = def.from;
  const positive = def.out.startsWith('positive/');
  if (legacy.expected_outcome.success !== positive) {
    throw new Error(`${def.out}: polarity differs from ${def.from}`);
  }

  const body = rekeyBody(legacy.request.body, def.from, def.out);
  const kind = def.kind ?? 'signed';
  const contentDigest =
    typeof def.contentDigest === 'function' ? def.contentDigest(body) : (def.contentDigest ?? contentDigestFor(body));
  let request;
  let base;

  if (kind === 'unsigned' || kind === 'malformed-input') {
    // Nothing is signed: the legacy headers are kept and a correct Content-Digest is added.
    request = {
      method: legacy.request.method,
      url: legacy.request.url,
      headers: { ...legacy.request.headers, 'Content-Digest': contentDigest },
      body,
    };
    if (kind === 'malformed-input') {
      // The legacy placeholder is 66 zero bytes; the 3.2 corpus uses the 64-byte Ed25519 placeholder everywhere.
      request.headers.Signature = `sig1=:${ZERO_SIGNATURE}:`;
    }
  } else {
    const components = def.components ?? DIGEST_COMPONENTS;
    const paramsSource = def.paramsFrom
      ? JSON.parse(readFileSync(join(VECTOR_DIR, def.paramsFrom), 'utf8'))
      : legacy;
    const params = legacySigParams(paramsSource);
    for (const [name, value] of Object.entries(def.params ?? {})) {
      if (!params.has(name) && value !== null) throw new Error(`${def.out}: unknown param ${name}`);
      params.set(name, value);
    }
    const serialized = serializeParams(components, params, def.unquotedParams);
    const canonical = canonicalFromLegacy(legacy);

    request = {
      method: legacy.request.method,
      url: legacy.request.url,
      headers: {
        ...Object.fromEntries((def.keepHeaders ?? []).map(name => [name, legacy.request.headers[name]])),
        'Content-Type': legacy.request.headers['Content-Type'],
        'Content-Digest': contentDigest,
        'Signature-Input': `sig1=${serialized}`,
        Signature: '',
      },
      body,
    };
    base = signatureBase(components, serialized, request, canonical);

    let signature;
    if (def.placeholder) {
      signature = ZERO_SIGNATURE;
    } else {
      const jwk = keyByKid(params.get('keyid'));
      const existing = readExisting(def.out);
      const existingSig = existing?.request?.headers?.Signature?.match(/^sig1=:([^:]+):/)?.[1];
      if (jwk.kty !== 'OKP' && existingSig && verifyBase(jwk, base, Buffer.from(existingSig, 'base64'))) {
        signature = existingSig; // keep a still-valid non-deterministic ECDSA signature
      } else {
        signature = signBase(jwk, base).toString('base64');
      }
      if (!verifyBase(jwk, base, Buffer.from(signature, 'base64'))) {
        throw new Error(`${def.out}: generated signature does not verify`);
      }
    }

    request.headers.Signature = `sig1=:${signature}:`;
    if (def.extraLabel) {
      const extra = def.extraLabel;
      const extraParams = new Map(params);
      extraParams.set('nonce', extra.nonce);
      request.headers['Signature-Input'] += `, ${extra.label}=${serializeParams(extra.components, extraParams)}`;
      const extraSignature = extra.signatureFromLegacy
        ? legacySignatureBytes(legacy, extra.label).toString('base64')
        : ZERO_SIGNATURE;
      request.headers.Signature += `, ${extra.label}=:${extraSignature}:`;
    }
    if (def.duplicateSignature) request.headers.Signature += `, sig1=:${signature}:`;
    if (def.dupLabel) {
      // A second member under the SAME label; the Signature header still carries one member.
      const dupParams = new Map(params);
      dupParams.set('nonce', def.dupLabel.nonce);
      request.headers['Signature-Input'] += `, sig1=${serializeParams(def.dupLabel.components, dupParams)}`;
    }
    if (kind === 'signature-only') delete request.headers['Signature-Input'];
  }

  const capability = { ...legacy.verifier_capability, covers_content_digest: 'required' };
  if (def.requiredFor) capability.required_for = def.requiredFor;
  const vector = {
    name: def.name,
    spec_reference: `${legacy.spec_reference}; AdCP 3.2 profile per #content-digest-and-proxy-compatibility and #adcp-rfc-9421-profile binary value encoding`,
    signing_profile_version: '3.2',
    reference_now: legacy.reference_now,
    request,
    verifier_capability: capability,
  };
  if (legacy.jwks_override) vector.jwks_override = legacy.jwks_override;
  else vector.jwks_ref = legacy.jwks_ref;
  if (legacy.test_harness_state) {
    vector.test_harness_state = { ...legacy.test_harness_state };
    if (def.harnessComment) vector.test_harness_state.$comment = def.harnessComment;
  }
  const includeBase = base !== undefined && (def.includeBase || !def.placeholder);
  if (includeBase) vector.expected_signature_base = base;
  vector.expected_outcome = def.expectedOutcome ?? legacy.expected_outcome;
  if (legacy.requires_contract) vector.requires_contract = legacy.requires_contract;
  if (legacy.side_effects) vector.side_effects = legacy.side_effects;

  const notes = [
    `3.2-profile counterpart of ${def.from}.`,
    { unsigned: UNSIGNED_PROFILE_NOTE, 'malformed-input': MALFORMED_PROFILE_NOTE }[kind] ?? PROFILE_NOTE,
    def.comment,
    (def.placeholder && def.out !== 'negative/015-signature-invalid.json') || kind === 'malformed-input' ? PLACEHOLDER_NOTE : undefined,
    `Generated by ${SCRIPT} from the test keys in keys.json; do not hand-edit.`,
  ].filter(Boolean);
  vector.$comment = notes.join(' ');
  return vector;
}

/** Guard: the generator must reproduce the hand-committed profile-3.2/positive/001 bytes. */
function selfCheck() {
  const existing = JSON.parse(readFileSync(join(PROFILE_DIR, 'positive/001-post-with-content-digest.json'), 'utf8'));
  const jwk = keyByKid('test-ed25519-2026');
  const expected = existing.request.headers.Signature.match(/^sig1=:([^:]+):$/)[1];
  const actual = signBase(jwk, existing.expected_signature_base).toString('base64');
  if (actual !== expected) throw new Error('self-check failed: cannot reproduce profile-3.2/positive/001 signature');
  if (contentDigestFor(existing.request.body) !== existing.request.headers['Content-Digest']) {
    throw new Error('self-check failed: cannot reproduce profile-3.2/positive/001 Content-Digest');
  }
}

// Hand-authored profile-3.2 vectors that predate this generator.
const HAND_AUTHORED = new Set([
  'positive/001-post-with-content-digest.json',
  'negative/001-base64url-sf-binary.json',
  'negative/002-multiple-trailing-dots.json',
]);

for (const def of DEFINITIONS) def.out = def.from;

selfCheck();
const check = process.argv.includes('--check');
let stale = 0;
// Any file that is neither generated nor hand-authored is stale output
// (e.g. left behind by a renamed definition). Report it in both modes.
const owned = new Set(DEFINITIONS.map(def => def.out));
for (const sub of ['positive', 'negative']) {
  for (const file of readdirSync(join(PROFILE_DIR, sub)).filter(name => name.endsWith('.json'))) {
    const rel = `${sub}/${file}`;
    if (!owned.has(rel) && !HAND_AUTHORED.has(rel)) {
      console.error(`${rel} is not produced by ${SCRIPT} and is not a known hand-authored vector; delete or register it`);
      stale++;
    }
  }
}
for (const def of DEFINITIONS) {
  const rendered = `${JSON.stringify(buildVector(def), null, 2)}\n`;
  const path = join(PROFILE_DIR, def.out);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== rendered) {
      console.error(`${def.out} is stale; run node ${SCRIPT}`);
      stale++;
    }
  } else {
    writeFileSync(path, rendered);
  }
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'verified' : 'wrote'} ${DEFINITIONS.length} profile-3.2 request-signing vectors`);
