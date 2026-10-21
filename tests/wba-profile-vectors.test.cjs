/**
 * Grades the Web Bot Auth profile vectors under
 * static/compliance/source/test-vectors/wba-profile/ with the judge in
 * tests/wba-interop/: Cloudflare's web-bot-auth and http-message-sig at their
 * pinned versions, bare and with the profile's rules (policy.mjs). The judge
 * shares no code with the generator (scripts/generate-wba-profile-vectors.mjs).
 *
 * Each negative vector must get its expected status from the judge with the
 * policy. The bare library shows which rule rejects it: a vector the bare
 * library accepts breaks only an AdCP rule. Where a vector carries a valid
 * signature, the test shows that the signature verifies once the one targeted
 * rule no longer applies.
 *
 * Run `npm ci --prefix tests/wba-interop` first; `npm run test:wba-profile-vectors` does.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { before, describe, it } = require('node:test');

const VECTOR_DIR = path.join(__dirname, '../static/compliance/source/test-vectors/wba-profile');
const INTEROP = path.join(__dirname, 'wba-interop');
const keys = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, 'keys.json'), 'utf8')).keys;
const { parseDictionary, serializeDictionary } = createRequire(path.join(INTEROP, 'package.json'))('structured-headers');

function loadDir(sub) {
  return fs
    .readdirSync(path.join(VECTOR_DIR, sub))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(file => ({ file, vector: JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, sub, file), 'utf8')) }));
}

const publicKey = jwk => crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
const privateJwk = kid => {
  const k = keys.find(entry => entry.kid === kid);
  return { kty: k.kty, crv: k.crv, x: k.x, d: k._private_d_for_test_only };
};
const headerOf = (headers, name) => headers[Object.keys(headers).find(k => k.toLowerCase() === name)];

let judge;
before(async () => {
  judge = await import(path.join(INTEROP, 'judge.mjs'));
});

/** The directories a vector names, each served as a response the judge signs at the vector's clock. */
async function directoriesOf(vector, override) {
  const out = {};
  for (const [origin, { keys_ref }] of Object.entries(override ?? vector.directories ?? {})) {
    out[origin] = await judge.signDirectory({ keys: keys_ref.map(privateJwk), origin, now: vector.reference_now });
  }
  return out;
}

/** Verifies a request vector with the judge; replay state comes from verifying the replayed request first. */
async function verifyVector(vector, { bare = false, directories, request = vector.request } = {}) {
  const prior = (vector.test_harness_state?.replay_cache_entries ?? []).length > 0 ? [request] : [];
  return judge.verifyRequest({ request, directories: await directoriesOf(vector, directories), now: vector.reference_now, prior }, { bare });
}

/** The request with only `label` left in Signature and Signature-Input. */
function onlyLabel(request, label) {
  const headers = { ...request.headers };
  for (const name of Object.keys(headers).filter(k => ['signature', 'signature-input'].includes(k.toLowerCase()))) {
    const dictionary = parseDictionary(headers[name]);
    for (const other of [...dictionary.keys()].filter(l => l !== label)) dictionary.delete(other);
    headers[name] = serializeDictionary(dictionary);
  }
  return { ...request, headers };
}

/** Each label's committed signature is the Ed25519 signature of its expected_signature_base. */
function assertSignaturesMatchBases(vector) {
  const input = parseDictionary(headerOf(vector.request.headers, 'signature-input'));
  const signature = parseDictionary(headerOf(vector.request.headers, 'signature'));
  for (const [label, base] of Object.entries(vector.expected_signature_base)) {
    const jwk = keys.find(k => k.kid === input.get(label)[1].get('keyid'));
    assert.ok(crypto.verify(null, Buffer.from(base), publicKey(jwk), Buffer.from(signature.get(label)[0])), label);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

const positive = loadDir('positive');
const negative = loadDir('negative');

describe('Web Bot Auth profile test keys', () => {
  it('derives each key from its published seed name', () => {
    for (const k of keys) {
      const seed = crypto.createHash('sha256').update(`rfc004-test/${k.seed_name}`).digest();
      assert.equal(k._private_d_for_test_only, seed.toString('base64url'), k.seed_name);
      const privateKey = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x, d: k._private_d_for_test_only }, format: 'jwk' });
      assert.equal(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, k.x, k.seed_name);
    }
  });

  it('uses the RFC 7638 JWK thumbprint as each kid', () => {
    for (const k of keys) {
      const thumbprint = crypto.createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${k.x}"}`).digest('base64url');
      assert.equal(k.kid, thumbprint, k.seed_name);
    }
  });
});

describe('Web Bot Auth profile schema fields', () => {
  it('signing_profile has no default, so filling in defaults never adds it next to authentication', () => {
    for (const name of ['push-notification-config', 'notification-config', 'agent-notification-config']) {
      const schema = JSON.parse(fs.readFileSync(path.join(__dirname, `../static/schemas/source/core/${name}.json`), 'utf8'));
      const field = schema.properties.signing_profile;
      assert.equal(field.$ref, '/schemas/enums/webhook-signing-profile.json', name);
      assert.ok(!('default' in field), `${name}.signing_profile declares a default`);
      assert.ok(schema.properties.authentication, `${name} has no authentication field`);
    }
  });
});

describe('Web Bot Auth profile positive vectors', () => {
  for (const { file, vector } of positive.filter(e => !e.vector.response)) {
    it(`${file}: the judge verifies the signature and names the expected identity`, async () => {
      const result = await verifyVector(vector);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual({ [Object.keys(vector.expected_outcome.identities)[0]]: result.identity }, vector.expected_outcome.identities);
    });

    it(`${file}: the committed signature signs expected_signature_base`, () => {
      // With the judge's verification, this shows the library computes the same base.
      assertSignaturesMatchBases(vector);
    });
  }

  for (const { file, vector } of positive.filter(e => e.vector.response)) {
    it(`${file}: the judge verifies the directory response`, async () => {
      const origin = new URL(vector.request.url).origin;
      const result = await judge.verifyDirectory({ origin, response: vector.response, now: vector.reference_now });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.keyids, Object.keys(vector.expected_signature_base).map(label => parseDictionary(vector.response.headers['Signature-Input']).get(label)[1].get('keyid')));
    });
  }
});

// What the bare library answers for each negative vector: `pass` means the
// vector breaks only an AdCP rule, which the policy adds.
const TARGETS = {
  '001-missing-nonce.json': { bare: 'pass' },
  '002-replayed-nonce.json': { bare: 'pass' },
  '003-signature-agent-not-covered.json': { bare: 'refuse' },
  '004-key-not-in-named-directory.json': { bare: 'refuse' },
  '005-malformed-signature-agent.json': { bare: 'refuse' },
  '006-two-signatures.json': { bare: 'refuse' },
};

describe('Web Bot Auth profile negative vectors', () => {
  it('names the bare-library outcome for every negative vector', () => {
    assert.deepEqual(negative.map(e => e.file), Object.keys(TARGETS).sort());
  });

  for (const { file, vector } of negative) {
    it(`${file}: the judge rejects it with ${vector.expected_outcome.status}`, async () => {
      const result = await verifyVector(vector);
      assert.equal(result.ok, false);
      assert.equal(result.status, vector.expected_outcome.status, result.error);
    });

    it(`${file}: the bare library answers ${TARGETS[file]?.bare}`, async () => {
      assert.equal((await verifyVector(vector, { bare: true })).ok, TARGETS[file].bare === 'pass');
    });

    if (vector.expected_signature_base) {
      it(`${file}: each committed signature signs its expected_signature_base`, () => {
        assertSignaturesMatchBases(vector);
      });
    }
  }

  it('004: the request verifies when the named origin publishes the key, so only the lookup rejects it', async () => {
    const { vector } = negative.find(e => e.file === '004-key-not-in-named-directory.json');
    const named = parseDictionary(headerOf(vector.request.headers, 'signature-agent')).get('sig1')[0];
    const result = await verifyVector(vector, { directories: { [named]: { keys_ref: [keys.find(k => k.identity === 'https://buyer-7k3q.com').kid] } } });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.identity, named);
  });

  it('006: each signature verifies on its own, so only the one-signature rule rejects the request', async () => {
    const { vector } = negative.find(e => e.file === '006-two-signatures.json');
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    const identities = {};
    for (const label of Object.keys(vector.expected_signature_base)) {
      const result = await verifyVector(vector, { bare: true, request: onlyLabel(vector.request, label) });
      assert.equal(result.ok, true, `${label}: ${result.error}`);
      identities[label] = result.identity;
    }
    assert.deepEqual(identities, { sig1: 'https://buyer-7k3q.com', sig2: 'https://agent.brand-7k3q.com' });
    assert.equal(vector.expected_signature_base.sig1, original.expected_signature_base.sig1);
  });

  it('a Signature-Agent value that is not exactly an https origin is refused with 403', async () => {
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    const { headers, ...request } = original.request;
    const unsigned = { ...request, headers: { 'content-type': headerOf(headers, 'content-type') } };
    const key = privateJwk(parseDictionary(headerOf(headers, 'signature-input')).get('sig1')[1].get('keyid'));
    const now = original.reference_now;
    for (const value of ['http://buyer-7k3q.com', 'https://buyer-7k3q.com/', 'https://Buyer-7k3q.com', 'https://buyer-7k3q.com:443', 'https://buyer-7k3q.com/agent']) {
      // The library signs the value as given, and the value's origin serves the key, so the origin rule is the only one the request breaks.
      const signed = await judge.signRequest({ key, origin: value, request: unsigned, now });
      const origin = new URL(value).origin;
      const directories = { [origin]: await judge.signDirectory({ keys: [key], origin, now }) };
      const result = await judge.verifyRequest({ request: signed, directories, now });
      assert.deepEqual([result.status, result.rule], [403, 'signature-agent-origin'], `${value}: ${result.error}`);
      assert.equal((await judge.verifyRequest({ request: signed, directories, now }, { bare: true })).ok, true, value);
    }
  });

  it('002: the replayed request is byte-identical to positive/001', () => {
    const { vector } = negative.find(e => e.file === '002-replayed-nonce.json');
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    assert.deepEqual(vector.request, original.request);
  });
});

describe('Web Bot Auth interop harness grading', () => {
  const { spawnSync } = require('node:child_process');
  const node = JSON.stringify(process.execPath);
  const grade = adapter => spawnSync(process.execPath, [path.join(INTEROP, 'run.mjs'), '--adapter', adapter], { encoding: 'utf8', maxBuffer: 1 << 24 });

  for (const [name, adapter] of [
    ['an adapter that throws', `${node} -e "throw new Error('stub adapter crash')"`],
    ['an adapter that reports an adapter-crash rule', `${node} -e "process.stdout.write(JSON.stringify({ ok: false, status: 0, rule: 'adapter-crash', error: 'stub' }))"`],
    ['an adapter that writes a refusal and exits 1', `${node} -e "process.stdout.write(JSON.stringify({ ok: false, status: 403, rule: 'stub', error: 'stub' })); process.exitCode = 1"`],
  ]) {
    it(`${name} fails every check, including the refusals that expect no status`, () => {
      const run = grade(adapter);
      assert.equal(run.status, 1, run.stderr);
      const summary = run.stdout.match(/^(\d+) of (\d+) checks pass\.$/m);
      assert.ok(summary, run.stdout);
      assert.equal(summary[1], '0', run.stdout.split('\n').filter(line => line.startsWith('pass')).join('\n'));
    });
  }
});
