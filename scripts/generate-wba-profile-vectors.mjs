#!/usr/bin/env node
/**
 * Generates the Web Bot Auth profile conformance vectors under
 * static/compliance/source/test-vectors/wba-profile/.
 *
 * Keys: every private key is an Ed25519 seed derived as
 * SHA-256("rfc004-test/<seed_name>"), so anyone can reproduce every signature.
 * Each kid is the RFC 7638 JWK thumbprint (RFC 8037 Appendix A.3 for Ed25519).
 * Nonces are base64url(SHA-512("rfc004-test/nonce/<name>")), 64 bytes.
 *
 * Signatures: each RFC 9421 signature base is written out component by
 * component, followed by the "@signature-params" line, and signed with
 * Ed25519. Ed25519 is deterministic, so the output is byte-stable and
 * `--check` can compare it with the committed files.
 *
 * Negative vectors each break exactly one profile rule. Those that carry a
 * valid signature verify once the targeted check is skipped; the test suite
 * (tests/wba-profile-vectors.test.cjs) proves that for each of them.
 *
 * Governance vectors are compact JWS tokens (RFC 7515) that grade the two
 * governance checks: the key must be in the iss origin's directory, and the
 * iss origin must be the buyer's governance agent.
 *
 * Usage:
 *   node scripts/generate-wba-profile-vectors.mjs          # write
 *   node scripts/generate-wba-profile-vectors.mjs --check  # verify committed files are current
 *
 * The keys are public test keys (Web Bot Auth section 6.8). Never use them in production.
 */

import { createECDH, createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTOR_DIR = join(ROOT, 'static/compliance/source/test-vectors/wba-profile');
const SCRIPT = 'scripts/generate-wba-profile-vectors.mjs';
const SPEC = 'docs/building/by-layer/L1/wba-profile.mdx';

const b64 = buf => Buffer.from(buf).toString('base64');
const b64u = buf => Buffer.from(buf).toString('base64url');
const sha = (alg, data) => createHash(alg).update(data).digest();

// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function key(seedName) {
  const seed = sha('sha256', `rfc004-test/${seedName}`);
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = b64u(sha('sha256', JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })));
  return { privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', kid, x, use: 'sig' }, d: b64u(seed) };
}

const nonce = name => b64u(sha('sha512', `rfc004-test/nonce/${name}`));
const digest = body => `sha-256=:${b64(sha('sha256', body))}:`;

function signBase(privateKey, lines, params) {
  const base = [...lines, `"@signature-params": ${params}`].join('\n');
  return [base, b64(sign(null, Buffer.from(base), privateKey))];
}

/** Compact JWS (RFC 7515) over compact-JSON header and payload. */
function jws(privateKey, header, payload) {
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${signingInput}.${b64u(sign(null, Buffer.from(signingInput), privateKey))}`;
}

// ── Identities and keys ───────────────────────────────────────────────────
const BUYER = 'https://buyer-7k3q.com';
const BRAND = 'https://agent.brand-7k3q.com';
const GOVERNANCE = 'https://governance-7k3q.com';
const buyer = key('buyer-request');
const brand = key('brand-request');
const governance = key('governance-document');

const files = {};
const write = (rel, doc) => {
  files[rel] = doc;
};

write('keys.json', {
  $comment:
    "Public test keys for the Web Bot Auth profile conformance vectors. The private seeds are published so that implementations can reproduce every signature. Each seed is SHA-256 of the ASCII string 'rfc004-test/<seed_name>'. Web Bot Auth section 6.8: test keys MUST NOT be used in production, and verifiers SHOULD reject them when detected. Each kid is the RFC 7638 JWK thumbprint (RFC 8037 Appendix A.3 for Ed25519). Each entry's identity is the origin whose key directory publishes the key.",
  keys: [
    { identity: BUYER, seed_name: 'buyer-request', ...buyer.jwk, _private_d_for_test_only: buyer.d },
    { identity: BRAND, seed_name: 'brand-request', ...brand.jwk, _private_d_for_test_only: brand.d },
    { identity: GOVERNANCE, seed_name: 'governance-document', ...governance.jwk, _private_d_for_test_only: governance.d },
  ],
});

// ── Shared request ────────────────────────────────────────────────────────
const SELLER = 'seller-7k3q.com';
const TARGET = `https://${SELLER}/mcp/`;
const CREATED = 1790841600;
const EXPIRES = 1790841900;
const NOW = CREATED + 10;
const ZERO_SIG = b64(Buffer.alloc(64));

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'create_media_buy',
    arguments: {
      idempotency_key: '4f6c1a0e-8d2b-4b7e-9c3a-2e5d7f1b0a96',
      account: { account_id: 'acc_42' },
      proposal_id: 'prop_7',
      total_budget: { amount: 25000, currency: 'USD' },
    },
  },
});
const bodyDigest = digest(body);

const REQUEST_COMPONENTS = ['@method', '@target-uri', '@authority', 'content-type', 'content-digest'];

function compList(label, extra = [], includeAgent = true) {
  const comps = REQUEST_COMPONENTS.map(c => `"${c}"`);
  if (includeAgent) comps.push(`"signature-agent";key="${label}"`);
  return `(${[...comps, ...extra].join(' ')})`;
}

function requestLines(label, agentUrl, includeAgent = true) {
  const lines = [
    '"@method": POST',
    `"@target-uri": ${TARGET}`,
    `"@authority": ${SELLER}`,
    '"content-type": application/json',
    `"content-digest": ${bodyDigest}`,
  ];
  if (includeAgent) lines.push(`"signature-agent";key="${label}": "${agentUrl}"`);
  return lines;
}

function params(comps, kid, n, created = CREATED, expires = EXPIRES) {
  let p = `${comps};created=${created};expires=${expires}`;
  if (n !== null) p += `;nonce="${n}"`;
  return `${p};keyid="${kid}";alg="ed25519";tag="web-bot-auth"`;
}

const headers = (agent, sigInput, sig) => ({
  'Content-Type': 'application/json',
  'Content-Digest': bodyDigest,
  'Signature-Agent': agent,
  'Signature-Input': sigInput,
  Signature: sig,
});

const request = h => ({ method: 'POST', url: TARGET, headers: h, body });

/** The Accept-Signature member the verifier sends with a 403 or a 429 (RFC 9421 section 5.1). */
function acceptSignature(label, components, freshNonce = false) {
  const doc = { label, components, parameters: ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag'], tag: 'web-bot-auth' };
  if (freshNonce) doc.nonce = 'verifier-chosen';
  return doc;
}

const REFUSAL_NOTE =
  'The profile reports signature failures with HTTP status codes (Web Bot Auth sections 5.3 and 5.4). Conformance grades the status code. On a 403 or 429, the AdCP layer SHOULD add Accept-Signature naming the components and parameters the profile requires, so the signer can sign again (security.mdx, AdCP checks after Web Bot Auth verification); the accept_signature object describes that header, and the exact serialization is RFC 9421 section 5.1.';

// ── Positive 001: single signer ───────────────────────────────────────────
const c1 = compList('sig1');
const p1 = params(c1, buyer.jwk.kid, nonce('buyer'));
const [base1, sig1] = signBase(buyer.privateKey, requestLines('sig1', BUYER), p1);
const h1 = headers(`sig1="${BUYER}"`, `sig1=${p1}`, `sig1=:${sig1}:`);
write('positive/001-single-signer-request.json', {
  name: 'Single signer: buyer agent at https://buyer-7k3q.com sends create_media_buy over MCP',
  spec_reference: `${SPEC}#profile-rules`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(h1),
  directories: { [BUYER]: { keys_ref: [buyer.jwk.kid] } },
  expected_signature_base: { sig1: base1 },
  expected_outcome: { success: true, identities: { sig1: BUYER } },
  $comment:
    'The Signature-Agent member sig1 names an origin, so the verifier fetches https://buyer-7k3q.com/.well-known/http-message-signatures-directory, selects the key whose kid equals keyid, and attributes the request to that origin. Ed25519 is deterministic, so an implementation signing with the published seed reproduces the Signature value byte for byte.',
});

// ── Positive 002: signed key directory response ───────────────────────────
const dirBody = JSON.stringify({ keys: [buyer.jwk] }, null, 2);
const dirDigest = digest(dirBody);
const dirParams = `("@authority";req "content-digest");created=1790841000;expires=1790927400;keyid="${buyer.jwk.kid}";alg="ed25519";tag="http-message-signatures-directory"`;
const [dirBase, dirSig] = signBase(buyer.privateKey, ['"@authority";req: buyer-7k3q.com', `"content-digest": ${dirDigest}`], dirParams);
write('positive/002-signed-directory-response.json', {
  name: 'Signed key directory response for https://buyer-7k3q.com, one signature per key',
  spec_reference: `${SPEC}#key-directories`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: {
    method: 'GET',
    url: `${BUYER}/.well-known/http-message-signatures-directory`,
    headers: { Host: 'buyer-7k3q.com', Accept: 'application/http-message-signatures-directory+json' },
    body: '',
  },
  response: {
    status: 200,
    headers: {
      'Content-Type': 'application/http-message-signatures-directory+json',
      'Cache-Control': 'max-age=300',
      'Content-Digest': dirDigest,
      'Signature-Input': `key1=${dirParams}`,
      Signature: `key1=:${dirSig}:`,
    },
    body: dirBody,
  },
  expected_signature_base: { key1: dirBase },
  expected_outcome: { success: true, identities: { key1: BUYER } },
  $comment:
    'Web Bot Auth Appendix B.1: the directory server signs the response once per key, covering "@authority";req and content-digest, with created, expires, the key\'s thumbprint as keyid, and tag http-message-signatures-directory. The verifier validates the signature with the key the directory itself provides and validates Content-Digest against the body. Covering the request authority stops the key set from being served again from another domain. The verifier stores the signed response as its audit record of the fetch.',
});

// ── Negative 001: missing nonce ───────────────────────────────────────────
const pNn = params(c1, buyer.jwk.kid, null);
const [baseNn, sigNn] = signBase(buyer.privateKey, requestLines('sig1', BUYER), pNn);
write('negative/001-missing-nonce.json', {
  name: 'Signature-Input omits the nonce parameter',
  spec_reference: `${SPEC}#replay-protection`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(`sig1="${BUYER}"`, `sig1=${pNn}`, `sig1=:${sigNn}:`)),
  directories: { [BUYER]: { keys_ref: [buyer.jwk.kid] } },
  expected_signature_base: { sig1: baseNn },
  expected_outcome: {
    success: false,
    status: 403,
    accept_signature: acceptSignature('sig1', c1),
    reason: 'The profile requires an RFC 9421 nonce on every signed request. Without one the verifier cannot detect replay.',
  },
  $comment: `The signature is cryptographically valid over its covered components, so a verifier that does not enforce the nonce requirement accepts it. The verifier answers 403, and the Accept-Signature hint lists nonce among the required parameters. ${REFUSAL_NOTE}`,
});

// ── Negative 002: replayed nonce ──────────────────────────────────────────
write('negative/002-replayed-nonce.json', {
  name: 'Second submission of a request whose (identity, nonce) pair the verifier has already accepted',
  spec_reference: `${SPEC}#replay-protection`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW + 5,
  request: request(h1),
  directories: { [BUYER]: { keys_ref: [buyer.jwk.kid] } },
  test_harness_state: {
    $comment:
      'Preload the replay cache as if positive/001 was just verified. White-box harnesses inject the entry; black-box runners send positive/001 twice and grade the second response.',
    replay_cache_entries: [{ identity: BUYER, nonce: nonce('buyer'), ttl_seconds: 360 }],
  },
  expected_signature_base: { sig1: base1 },
  expected_outcome: {
    success: false,
    status: 429,
    accept_signature: acceptSignature('sig1', c1, true),
    reason: "The verifier MUST reject a nonce it has already seen for the same identity within the signature's lifetime.",
  },
  $comment: `The request is byte-identical to positive/001-single-signer-request.json. The verifier checks the nonce per signature and per identity, whether or not an edge verifier ran first. The Accept-Signature hint on the 429 carries a verifier-chosen nonce value (Web Bot Auth section 5.3; RFC 9421 sections 5.1 and 7.2.2), which the signer uses on its next attempt; the value is not pinned by this vector. ${REFUSAL_NOTE}`,
});

// ── Negative 003: Signature-Agent present but not covered ─────────────────
const cUnc = compList('sig1', [], false);
const pUnc = params(cUnc, buyer.jwk.kid, nonce('buyer-uncovered'));
const [baseUnc, sigUnc] = signBase(buyer.privateKey, requestLines('sig1', BUYER, false), pUnc);
write('negative/003-signature-agent-not-covered.json', {
  name: 'Signature-Agent header present, but the sig1 member is not a covered component',
  spec_reference: `${SPEC}#profile-rules`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(`sig1="${BUYER}"`, `sig1=${pUnc}`, `sig1=:${sigUnc}:`)),
  directories: { [BUYER]: { keys_ref: [buyer.jwk.kid] } },
  expected_signature_base: { sig1: baseUnc },
  expected_outcome: {
    success: false,
    status: 403,
    accept_signature: acceptSignature('sig1', c1),
    reason:
      'Web Bot Auth section 5.2.1: the Signature-Agent member keyed to the signature label MUST be signed as a component. An uncovered member is an unverified claim and MUST NOT be attributed (section 4.1).',
  },
  $comment: `The signature verifies over the components it does cover, so a verifier that reads the identity from the uncovered header and skips the coverage check accepts it and attributes the request to an origin nobody signed for. ${REFUSAL_NOTE}`,
});

// ── Negative 004: key not in the directory the header names ───────────────
const pWrong = params(c1, buyer.jwk.kid, nonce('buyer-claims-brand'));
const [baseWrong, sigWrong] = signBase(buyer.privateKey, requestLines('sig1', BRAND), pWrong);
write('negative/004-key-not-in-named-directory.json', {
  name: 'Signature-Agent names https://agent.brand-7k3q.com, but the signing key is published only by https://buyer-7k3q.com',
  spec_reference: `${SPEC}#identity`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(`sig1="${BRAND}"`, `sig1=${pWrong}`, `sig1=:${sigWrong}:`)),
  directories: { [BRAND]: { keys_ref: [brand.jwk.kid] }, [BUYER]: { keys_ref: [buyer.jwk.kid] } },
  expected_signature_base: { sig1: baseWrong },
  expected_outcome: {
    success: false,
    status: 403,
    accept_signature: acceptSignature('sig1', c1),
    reason:
      'Key lookup is keyed on the (origin, keyid) pair, never on keyid alone (Web Bot Auth section 5.4). The directory at the named origin holds no key with this thumbprint, so the request is unverified and MUST NOT be attributed to that origin (section 6.10).',
  },
  $comment: `The signature is valid under the buyer agent's key, and the directories object lists that key under its own origin so the harness can show the trap: a verifier that indexes keys by thumbprint alone finds the key, verifies, and attributes the request to the brand agent, an origin that never published the key. A conformant verifier resolves only https://agent.brand-7k3q.com/.well-known/http-message-signatures-directory and rejects. ${REFUSAL_NOTE}`,
});

// ── Negative 005: unparseable Signature-Agent ─────────────────────────────
write('negative/005-malformed-signature-agent.json', {
  name: 'Signature-Agent is not a parseable Structured Field Dictionary (unterminated string)',
  spec_reference: `${SPEC}#error-responses`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(`sig1="${BUYER}`, `sig1=${p1}`, `sig1=:${ZERO_SIG}:`)),
  directories: { [BUYER]: { keys_ref: [buyer.jwk.kid] } },
  expected_outcome: {
    success: false,
    status: 400,
    reason: 'Web Bot Auth section 5.4: a verifier that fails to parse Signature, Signature-Input, or Signature-Agent answers 400 Bad Request.',
  },
  $comment:
    "Signature is a 64-zero-byte placeholder: parsing fails before any key is resolved or any signature is checked, so a verifier that reaches cryptographic verification has skipped the parse step. No Accept-Signature is sent, because the signer's headers, not its signature, need fixing.",
});

// ── Negative 006: two web-bot-auth signatures on one request ──────────────
const c2 = compList('sig2');
const p2 = params(c2, brand.jwk.kid, nonce('brand'));
const [base2, sig2] = signBase(brand.privateKey, requestLines('sig2', BRAND), p2);
write('negative/006-two-signatures.json', {
  name: 'Two web-bot-auth signatures on one request: positive/001 plus a second valid signature from https://agent.brand-7k3q.com',
  spec_reference: `${SPEC}#verification`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(`sig1="${BUYER}", sig2="${BRAND}"`, `sig1=${p1}, sig2=${p2}`, `sig1=:${sig1}:, sig2=:${sig2}:`)),
  directories: { [BUYER]: { keys_ref: [buyer.jwk.kid] }, [BRAND]: { keys_ref: [brand.jwk.kid] } },
  expected_signature_base: { sig1: base1, sig2: base2 },
  expected_outcome: {
    success: false,
    status: 403,
    accept_signature: acceptSignature('sig1', c1),
    reason:
      'The profile takes exactly one web-bot-auth signature and one Signature-Agent member per request (RFC 9421 section 3.2.1). Web Bot Auth section 5.2.2 permits more than one signature; the profile does not accept one.',
  },
  $comment: `The sig1 label is byte-identical to positive/001-single-signer-request.json, and the sig2 label is a second valid signature over the same request from another identity. Each verifies on its own against its own directory, so a verifier that loops over every label and accepts when each verifies has skipped the count check. ${REFUSAL_NOTE}`,
});

// ── Governance tokens: one agent per purpose ──────────────────────────────
// Purpose belongs to the agent, not the key. The verifier accepts a governance
// token when the key is in the iss origin's directory AND the iss origin is the
// buyer's governance agent. Each negative token breaks one of the two.
const GOVERNANCE_DIRECTORY = `${GOVERNANCE}/.well-known/http-message-signatures-directory`;
const BUYER_DIRECTORY = `${BUYER}/.well-known/http-message-signatures-directory`;
const ROLE_LISTING = { 'adcp:governance': [GOVERNANCE] };
const GOVERNANCE_DIRECTORIES = {
  [GOVERNANCE]: { keys_ref: [governance.jwk.kid] },
  [BUYER]: { keys_ref: [buyer.jwk.kid] },
};
const ROLE_NOTE =
  'role_listing stands in for the record the verifier already trusts: in deployment, the governance-typed agents[] entry in the buyer\'s brand.json, or the adcp:governance role in trust.json once #7809 lands. The token\'s other claims (aud, phase, sub, action binding, revocation, replay) follow the existing governance checklist and are not graded here.';

const governanceHeader = (kid, directory) => ({ alg: 'Ed25519', typ: 'adcp-gov+jws', jku: directory, kid });
const governancePayload = (iss, jti) => ({ iss, aud: TARGET, phase: 'intent', jti, iat: 1790841500, exp: 1790842400 });

function governanceVector(rel, { name, header, payload, signer, expected, comment }) {
  write(rel, {
    name,
    spec_reference: `${SPEC}#one-agent-per-purpose`,
    signing_profile: 'web-bot-auth',
    document_type: 'governance_context',
    reference_now: NOW,
    jws: jws(signer, header, payload),
    decoded: { header, payload },
    directories: GOVERNANCE_DIRECTORIES,
    role_listing: ROLE_LISTING,
    expected_outcome: expected,
    $comment: `${comment} ${ROLE_NOTE}`,
  });
}

governanceVector('governance/001-governance-token.json', {
  name: 'Governance token issued by the governance identity https://governance-7k3q.com with its own key',
  header: governanceHeader(governance.jwk.kid, GOVERNANCE_DIRECTORY),
  payload: governancePayload(GOVERNANCE, '01J9ZQ4M8T6W3R5Y2K7N1P0B9C'),
  signer: governance.privateKey,
  expected: { success: true, issuer: GOVERNANCE },
  comment:
    "The token in RFC #7878's illustrations. jku is the WBA directory of the iss origin, the kid is in that directory, the signature verifies, and the iss origin is listed in the governance role.",
});

governanceVector('governance/002-governance-token-key-not-in-issuer-directory.json', {
  name: 'Governance token naming the governance agent as issuer, signed with a key that only the buyer agent publishes',
  header: governanceHeader(buyer.jwk.kid, GOVERNANCE_DIRECTORY),
  payload: governancePayload(GOVERNANCE, '01J9ZQ4M8T6W3R5Y2K7N1P0B9D'),
  signer: buyer.privateKey,
  expected: {
    success: false,
    error_code: 'governance_key_unknown',
    reason: "The kid is not in the key directory of the iss origin. Key lookup is keyed on the pair of origin and key, so a key another agent publishes cannot sign as the governance agent.",
  },
  comment:
    'The signature is valid under the buyer agent\'s key, which the directories object lists under the buyer agent\'s origin. A verifier that looks keys up by thumbprint alone finds the key and accepts the token.',
});

governanceVector('governance/003-governance-token-from-non-governance-agent.json', {
  name: 'Governance token issued by the buyer agent https://buyer-7k3q.com, which is not the buyer\'s governance agent, with its own key and directory',
  header: governanceHeader(buyer.jwk.kid, BUYER_DIRECTORY),
  payload: governancePayload(BUYER, '01J9ZQ4M8T6W3R5Y2K7N1P0B9E'),
  signer: buyer.privateKey,
  expected: {
    success: false,
    error_code: 'governance_issuer_not_authorized',
    reason: "The iss origin is not the buyer's governance agent. The key, jku, and signature are all consistent, so this is the check that rejects the token.",
  },
  comment:
    'Every check up to the governance-agent check passes: jku is the iss origin\'s directory, the kid is in it, and the signature verifies. A token is accepted for who issued it, not for which key signed it. A verifier that checks only that the key sits in the iss directory accepts this token.',
});

// ── Failure scenarios ─────────────────────────────────────────────────────
// Scenarios are data, not signatures: a harness signs each one at run time
// with the reference library, so nothing committed here expires. Times are
// offsets in seconds from the harness's clock.
//
// tier "wba": the reference library with no AdCP policy already gives the
// expected outcome. tier "adcp": it gives the opposite outcome, and only the
// profile's rules give the expected one. A WBA MUST that the library does not
// enforce is tier "adcp" until it does; the harness reports the change.
const P256_SEED = sha('sha256', 'rfc004-test/p256-unused');
const p256 = (() => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(P256_SEED);
  const point = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) };
  return { ...jwk, kid: b64u(sha('sha256', JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))), use: 'sig' };
})();

const FULL = ['@method', '@target-uri', '@authority', 'content-type', 'content-digest', 'signature-agent;key={label}'];
const ok = { success: true, identity: BUYER };
const status = s => ({ success: false, status: s });
// A directory refusal has no status of its own: the request that needed the key gets 403.
const refused = { success: false };
const req = (id, name, tier, expected, basis, fields = {}) => ({ id, name, base: 'post', ...fields, expected, tier, basis });
const dirScenario = (id, name, tier, expected, basis, fields = {}) => ({ id, name, ...fields, expected, tier, basis });

write('scenarios.json', {
  $comment:
    'Failure scenarios for the Web Bot Auth profile, as data. A harness signs each request and directory scenario at run time with the reference library (http-message-sig signs any component and parameter set), applies after_signing, and grades the verifier on expected. created and expires are offsets in seconds from the harness clock; a null parameter is omitted; a nonce object asks for that many random bytes in that encoding. tier "wba": the reference library with no AdCP policy already gives the expected outcome. tier "adcp": the bare library gives the opposite outcome and only the profile rules give the expected one; a WBA MUST the library does not enforce stays "adcp" until it does. See README.md.',
  spec_reference: `${SPEC}#profile-rules`,
  signing_profile: 'web-bot-auth',
  signer: { identity: BUYER, kid: buyer.jwk.kid },
  requests: {
    post: { method: 'POST', url: TARGET, headers: { 'content-type': 'application/json' }, body },
    get: { method: 'GET', url: `${TARGET}tasks?id=a%7Eb&x=1`, headers: {}, body: '' },
  },
  components: { post: FULL, get: ['@method', '@target-uri', '@authority', 'signature-agent;key={label}'] },
  parameters: { created: -5, expires: 295, nonce: { bytes: 64, encoding: 'base64url' }, tag: 'web-bot-auth' },
  request_scenarios: [
    req('R00', 'Baseline', 'wba', ok, 'Profile rules'),
    req('R01', 'Body changed after signing', 'adcp', status(403), 'Content-Digest matches the body: RFC 9530; WBA section 5.2', { after_signing: { append_to_body: '\n' } }),
    req('R02', 'Covered header changed after signing', 'wba', status(403), 'RFC 9421 section 3.2', { after_signing: { headers: { 'content-type': 'text/plain' } } }),
    req('R03', 'Expired', 'wba', status(403), 'RFC 9421 section 3.2.1', { parameters: { created: -400, expires: -100 } }),
    req('R04', 'created 120 seconds in the future', 'wba', status(403), 'Profile: 60 seconds of clock skew', { parameters: { created: 120, expires: 400 } }),
    req('R05', 'created 30 seconds in the future', 'adcp', ok, 'Profile: 60 seconds of clock skew; the library allows none by default', { parameters: { created: 30, expires: 300 } }),
    req('R06', 'Lifetime of 3600 seconds', 'adcp', status(403), 'Profile: expires at most 300 seconds after created', { parameters: { created: -5, expires: 3595 } }),
    req('R07', 'Nonce of 32 bytes', 'wba', status(403), 'Profile: 64-byte nonce; validateNonce', { parameters: { nonce: { bytes: 32, encoding: 'base64url' } } }),
    req('R08', 'Nonce in canonical padded base64', 'wba', ok, 'Profile: unpadded base64url or canonical padded base64', { parameters: { nonce: { bytes: 64, encoding: 'base64' } } }),
    req('R09', 'Nonce in padded base64url', 'wba', status(403), 'Profile: unpadded base64url or canonical padded base64', { parameters: { nonce: { bytes: 64, encoding: 'base64url-padded' } } }),
    req('R10', 'No alg parameter', 'wba', status(403), 'Profile: alg required', { parameters: { alg: null } }),
    req('R11', 'alg other than ed25519', 'wba', status(403), 'Profile: alg is ed25519 and matches the key; RFC 9421 section 3.2', { parameters: { alg: 'ecdsa-p256-sha256' } }),
    req('R12', 'GET covering only @authority and the Signature-Agent member', 'adcp', status(403), 'Profile: cover @method, @target-uri, and @authority; WBA section 5.2 needs one of @authority or @target-uri', { base: 'get', components: ['@authority', 'signature-agent;key=sig1'] }),
    req('R13', 'Body without content-digest covered', 'adcp', status(403), 'Profile: a request with a body covers content-type and content-digest; WBA section 5.2', { components: ['@method', '@target-uri', '@authority', 'content-type', 'signature-agent;key=sig1'] }),
    req('R14', 'tag other than web-bot-auth', 'wba', status(403), 'WBA section 5.2: tag MUST be web-bot-auth', { parameters: { tag: 'adcp/request-signing/v1' } }),
    req('R15', 'Bare-string Signature-Agent', 'adcp', status(400), 'Profile: dictionary form only, so the field does not parse; WBA section 5.2.1 lets a verifier accept the bare string', { signature_agent: `"${BUYER}"`, components: [...FULL.slice(0, 5), 'signature-agent'] }),
    req('R16', 'http:// Signature-Agent', 'adcp', status(403), 'WBA section 5.2.1: the origin MUST be https; the library does not check it', { signature_agent: 'sig1="http://buyer-7k3q.com"', directories: { 'http://buyer-7k3q.com': [buyer.jwk.kid] } }),
    req('R17', 'Signature-Agent with a path', 'adcp', status(403), 'WBA section 5.5: a directory member MUST be an origin; the library does not check it', { signature_agent: `sig1="${BUYER}/agents/a"`, directories: { [`${BUYER}/agents/a`]: [buyer.jwk.kid] } }),
    req('R18', 'Signature-Agent member with type=jwks_uri', 'adcp', status(403), 'Profile: only type=directory; WBA section 5.2.1 lets a verifier ignore other types', { signature_agent: `sig1="${BUYER}/jwks.json";type=jwks_uri`, directories: { [`${BUYER}/jwks.json`]: [buyer.jwk.kid] } }),
    req('R19', 'Signature-Agent member keyed differently from the label', 'adcp', status(403), 'WBA section 5.2.1: the member keyed to the label; the library does not check it', { signature_agent: `agent1="${BUYER}"`, components: [...FULL.slice(0, 5), 'signature-agent;key=agent1'] }),
    req('R20', 'Second signature with tag cdn-edge', 'adcp', ok, 'Profile: Signature-Input members with other tags are not read; the library requires a label when a request carries two signatures', {
      extra_signature: { label: 'cdn', kid: brand.jwk.kid, components: ['@method', '@authority'], parameters: { created: -5, expires: 295, nonce: null, tag: 'cdn-edge' } },
    }),
    req('R21', 'Two Signature-Agent members, one signature', 'adcp', status(403), 'Profile: exactly one Signature-Agent member', { signature_agent: `sig1="${BUYER}", sig2="${BRAND}"` }),
    req('R22', 'Label other than sig1', 'wba', ok, 'RFC 9421: the signer chooses the label', { label: 'wba' }),
    req('R23', 'Components in another order', 'wba', ok, "RFC 9421: the order is the signer's", { components: ['signature-agent;key=sig1', '@authority', 'content-digest', '@target-uri', 'content-type', '@method'] }),
  ],
  directory_scenarios: [
    dirScenario('D00', 'Baseline', 'wba', { success: true }, 'WBA Appendix B.1'),
    dirScenario('D01', 'Signed for another authority', 'wba', refused, 'WBA Appendix B.1: covers "@authority";req', { authority: 'agent.brand-7k3q.com' }),
    dirScenario('D02', 'Body changed after signing', 'adcp', refused, 'WBA Appendix B.1: the verifier MUST validate Content-Digest; the library does not compare it with the body', { after_signing: { append_to_body: '\n' } }),
    dirScenario('D03', 'Unsigned', 'wba', refused, 'Profile: every Ed25519 key signs (Appendix B.1 recommends it)', { keys: [], unsigned_keys: [buyer.jwk] }),
    dirScenario('D04', 'Signature created in the future', 'wba', refused, 'WBA Appendix B.1: reject a future created', { parameters: { created: 3600, expires: 90000 } }),
    dirScenario('D05', 'Covers "@authority";req only', 'adcp', refused, 'WBA Appendix B.1: covers content-digest', { components: ['@authority;req'] }),
    dirScenario('D06', 'Expired signature', 'wba', refused, 'RFC 9421 section 3.2.1', { parameters: { created: -7200, expires: -3600 } }),
    dirScenario('D07', 'Extra P-256 key that does not sign', 'wba', { success: true }, 'Profile: ignore keys the profile does not use (RFC 7517 section 5)', { unsigned_keys: [p256] }),
    dirScenario('D08', 'Media type application/json', 'adcp', refused, 'WBA section 5.5.1: the well-known directory MUST be served with application/http-message-signatures-directory+json', { content_type: 'application/json' }),
  ],
});

// ── Write or check ────────────────────────────────────────────────────────
const check = process.argv.includes('--check');
let stale = 0;
for (const sub of ['positive', 'negative', 'governance']) {
  if (!existsSync(join(VECTOR_DIR, sub))) continue;
  for (const file of readdirSync(join(VECTOR_DIR, sub)).filter(name => name.endsWith('.json'))) {
    if (!(`${sub}/${file}` in files)) {
      console.error(`${sub}/${file} is not produced by ${SCRIPT}; delete it or add it to the generator`);
      stale++;
    }
  }
}
for (const [rel, doc] of Object.entries(files)) {
  const rendered = `${JSON.stringify(doc, null, 2)}\n`;
  const path = join(VECTOR_DIR, rel);
  if (check) {
    if ((existsSync(path) ? readFileSync(path, 'utf8') : '') !== rendered) {
      console.error(`${rel} is stale; run node ${SCRIPT}`);
      stale++;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
  }
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'verified' : 'wrote'} ${Object.keys(files).length} Web Bot Auth profile vector files`);
