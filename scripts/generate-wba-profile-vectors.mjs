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
 * Usage:
 *   node scripts/generate-wba-profile-vectors.mjs          # write
 *   node scripts/generate-wba-profile-vectors.mjs --check  # verify committed files are current
 *
 * The keys are public test keys (Web Bot Auth section 6.8). Never use them in production.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

// ── Identities and keys ───────────────────────────────────────────────────
const BUYER = 'https://buyer-7k3q.com';
const BRAND = 'https://agent.brand-7k3q.com';
const RELAY = 'https://relay.agency-7k3q.com';
const buyer = key('buyer-request');
const brand = key('brand-request');
const relay = key('relay-request');

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
    { identity: RELAY, seed_name: 'relay-request', ...relay.jwk, _private_d_for_test_only: relay.d },
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

/** The Accept-Signature member the verifier sends with a 403 (RFC 9421 section 5.1). */
function acceptSignature(label, components, freshNonce = false) {
  const doc = { label, components, parameters: ['created', 'expires', 'nonce', 'keyid', 'tag'], tag: 'web-bot-auth' };
  if (freshNonce) doc.nonce = 'verifier-chosen';
  return doc;
}

const REFUSAL_NOTE =
  'The profile reports signature failures with HTTP status codes (Web Bot Auth sections 5.3 and 5.4). A 403 carries Accept-Signature naming the components and parameters the profile requires, so the signer can sign again. Conformance grades the status code; the accept_signature object describes the header the verifier sends, and the exact serialization is RFC 9421 section 5.1.';

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

// ── Positive 002: relay with two signatures ───────────────────────────────
const cb = compList('brand');
const pb = params(cb, brand.jwk.kid, nonce('brand'));
const [baseB, sigB] = signBase(brand.privateKey, requestLines('brand', BRAND), pb);
const RELAY_EXTRA = ['"signature-agent";key="brand"', '"signature-input";key="brand"', '"signature";key="brand"'];
const cr = compList('relay', RELAY_EXTRA);
const pr = params(cr, relay.jwk.kid, nonce('relay'), CREATED + 1, EXPIRES + 1);
const relayLines = [
  ...requestLines('relay', RELAY),
  `"signature-agent";key="brand": "${BRAND}"`,
  `"signature-input";key="brand": ${pb}`,
  `"signature";key="brand": :${sigB}:`,
];
const [baseR, sigR] = signBase(relay.privateKey, relayLines, pr);
const relayAgent = `brand="${BRAND}", relay="${RELAY}"`;
const hRelay = headers(relayAgent, `brand=${pb}, relay=${pr}`, `brand=:${sigB}:, relay=:${sigR}:`);
write('positive/002-relay-request-two-signatures.json', {
  name: "Relay: brand agent signs, agency relay forwards unchanged and adds a signature covering the brand agent's members",
  spec_reference: `${SPEC}#relays`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(hRelay),
  directories: { [BRAND]: { keys_ref: [brand.jwk.kid] }, [RELAY]: { keys_ref: [relay.jwk.kid] } },
  expected_signature_base: { brand: baseB, relay: baseR },
  expected_outcome: { success: true, identities: { brand: BRAND, relay: RELAY } },
  $comment:
    "Both web-bot-auth signatures must verify, each against its own covered components and its own identity's directory (Web Bot Auth section 5.2.2). The relay label covers the brand label's signature-agent, signature-input, and signature members, as section 5.2.2 requires of a signer that covers another signature and as Appendix D.2 illustrates. Whether the relay may act for the brand is an authorization question answered by the brand's brand.json, outside this profile.",
});

// ── Positive 003: signed key directory response ───────────────────────────
const dirBody = JSON.stringify({ keys: [buyer.jwk] }, null, 2);
const dirDigest = digest(dirBody);
const dirParams = `("@authority";req "content-digest");created=1790841000;expires=1790927400;keyid="${buyer.jwk.kid}";alg="ed25519";tag="http-message-signatures-directory"`;
const [dirBase, dirSig] = signBase(buyer.privateKey, ['"@authority";req: buyer-7k3q.com', `"content-digest": ${dirDigest}`], dirParams);
write('positive/003-signed-directory-response.json', {
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
  $comment: `The signature is cryptographically valid over its covered components, so a verifier that does not enforce the nonce requirement accepts it. The verifier answers 403 with Accept-Signature listing nonce among the required parameters. ${REFUSAL_NOTE}`,
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
    status: 403,
    accept_signature: acceptSignature('sig1', c1, true),
    reason: "The verifier MUST reject a nonce it has already seen for the same identity within the signature's lifetime.",
  },
  $comment: `The request is byte-identical to positive/001-single-signer-request.json. The verifier checks the nonce per signature and per identity, whether or not an edge verifier ran first. The 403 carries Accept-Signature with a verifier-chosen nonce value (RFC 9421 sections 5.1 and 7.2.2), which the signer uses on its next attempt; the value is not pinned by this vector. ${REFUSAL_NOTE}`,
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

// ── Negative 004: relay omits the inner signature members ─────────────────
const cRo = compList('relay');
const pRo = params(cRo, relay.jwk.kid, nonce('relay-omits-inner'), CREATED + 1, EXPIRES + 1);
const [baseRo, sigRo] = signBase(relay.privateKey, requestLines('relay', RELAY), pRo);
write('negative/004-relay-omits-inner-signature.json', {
  name: "Relay adds a second signature that does not cover the brand agent's signature members",
  spec_reference: `${SPEC}#relays`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(relayAgent, `brand=${pb}, relay=${pRo}`, `brand=:${sigB}:, relay=:${sigRo}:`)),
  directories: { [BRAND]: { keys_ref: [brand.jwk.kid] }, [RELAY]: { keys_ref: [relay.jwk.kid] } },
  expected_signature_base: { brand: baseB, relay: baseRo },
  expected_outcome: {
    success: false,
    status: 403,
    accept_signature: acceptSignature('relay', cr),
    reason:
      "The profile requires each later signer to cover the signature-agent, signature-input, and signature members of the signature before it. The relay label covers none of the brand label's members.",
  },
  $comment: `Both signatures verify on their own, so a verifier that checks only cryptographic validity accepts the request. The relay's signature then records nothing about the brand agent's signature having been present, which is the evidence the profile requires of a relay (Web Bot Auth section 5.2.2 and Appendix D.2). ${REFUSAL_NOTE}`,
});

// ── Negative 005: brand signature altered after the relay signed ──────────
const alteredSigB = (sigB[0] === 'A' ? 'B' : 'A') + sigB.slice(1);
// The base a verifier rebuilds from the request as sent: the relay's covered brand signature is the altered one.
const baseRAltered = [...relayLines.slice(0, -1), `"signature";key="brand": :${alteredSigB}:`, `"@signature-params": ${pr}`].join('\n');
write('negative/005-relay-inner-signature-altered.json', {
  name: "Brand agent's signature altered after the relay signed over it",
  spec_reference: `${SPEC}#relays`,
  signing_profile: 'web-bot-auth',
  reference_now: NOW,
  request: request(headers(relayAgent, `brand=${pb}, relay=${pr}`, `brand=:${alteredSigB}:, relay=:${sigR}:`)),
  directories: { [BRAND]: { keys_ref: [brand.jwk.kid] }, [RELAY]: { keys_ref: [relay.jwk.kid] } },
  expected_signature_base: { brand: baseB, relay: baseRAltered },
  expected_outcome: {
    success: false,
    status: 403,
    accept_signature: acceptSignature('relay', cr),
    reason:
      'The relay label claims to cover "signature";key="brand", but the value on the wire is not the one the relay signed, so the relay\'s signature fails. The brand label\'s signature fails as well.',
  },
  $comment: `Derived from positive/002-relay-request-two-signatures.json by changing the first character of the brand signature. Every web-bot-auth signature on a request must verify, so one failure rejects the request. The vector shows that the relay's signature binds the brand agent's signature bytes: changing or removing them breaks the relay's signature too. ${REFUSAL_NOTE}`,
});

// ── Negative 006: key not in the directory the header names ───────────────
const pWrong = params(c1, buyer.jwk.kid, nonce('buyer-claims-brand'));
const [baseWrong, sigWrong] = signBase(buyer.privateKey, requestLines('sig1', BRAND), pWrong);
write('negative/006-key-not-in-named-directory.json', {
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

// ── Negative 007: unparseable Signature-Agent ─────────────────────────────
write('negative/007-malformed-signature-agent.json', {
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

// ── Write or check ────────────────────────────────────────────────────────
const check = process.argv.includes('--check');
let stale = 0;
for (const sub of ['positive', 'negative']) {
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
    writeFileSync(path, rendered);
  }
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'verified' : 'wrote'} ${Object.keys(files).length} Web Bot Auth profile vector files`);
