/**
 * Independent verification of the AdCP 3.2 request-signing vectors under
 * static/compliance/source/test-vectors/request-signing/profile-3.2/.
 *
 * Two verifiers that share no code with the generator
 * (scripts/generate-request-signing-profile-3.2-vectors.mjs):
 *   1. A minimal RFC 9421 base builder here, using @adcp/sdk's URL
 *      canonicalizer, plus node:crypto signature and digest checks.
 *   2. @adcp/sdk's full verifyRequestSignature pinned to adcpVersion '3.2',
 *      with each vector's test_harness_state preloaded.
 *
 * Also locks in the adcp#7733 invariant: every legacy vector that a
 * covers_content_digest='required' verifier cannot grade has a 3.2 counterpart
 * that covers content-digest.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  canonicalTargetUri,
  canonicalAuthority,
  verifyRequestSignature,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('@adcp/sdk/signing');

const VECTOR_DIR = path.join(__dirname, '../static/compliance/source/test-vectors/request-signing');
const keys = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, 'keys.json'), 'utf8')).keys;

function loadDir(relDir) {
  const dir = path.join(VECTOR_DIR, relDir);
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(file => ({ id: `${relDir}/${file.replace(/\.json$/, '')}`, file, vector: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}

const slugOf = file => file.replace(/^\d+-/, '').replace(/\.json$/, '');
const legacyPositive = loadDir('positive');
const legacyNegative = loadDir('negative');
const profilePositive = loadDir('profile-3.2/positive');
const profileNegative = loadDir('profile-3.2/negative');
const profileAll = [...profilePositive, ...profileNegative];

// Hand-authored profile-3.2 vectors predating the generator; every other file is generated.
const HAND_AUTHORED = new Set([
  'profile-3.2/positive/001-post-with-content-digest',
  'profile-3.2/negative/001-base64url-sf-binary',
  'profile-3.2/negative/002-multiple-trailing-dots',
]);
const generated = profileAll.filter(entry => !HAND_AUTHORED.has(entry.id));

/** Split the sig1 member of a Signature-Input header into components + raw params. */
function parseSig1Input(header) {
  const match = /^sig1=(\(([^)]*)\)[^,]*)/.exec(header);
  if (!match) return undefined;
  const components = match[2].split(' ').filter(Boolean).map(c => JSON.parse(c));
  const params = Object.fromEntries(
    match[1]
      .slice(match[1].indexOf(')') + 1)
      .split(';')
      .filter(Boolean)
      .map(part => {
        const eq = part.indexOf('=');
        const raw = part.slice(eq + 1);
        return [part.slice(0, eq), raw.startsWith('"') ? JSON.parse(raw) : Number(raw)];
      })
  );
  return { serialized: match[1], components, params };
}

function sig1Bytes(header) {
  const token = /^sig1=:([^:]*):/.exec(header)?.[1];
  assert.ok(token !== undefined, 'Signature must carry a sig1 sf-binary member');
  return { token, bytes: Buffer.from(token, 'base64') };
}

function independentBase(vector) {
  const { request } = vector;
  const parsed = parseSig1Input(request.headers['Signature-Input']);
  const header = name => {
    const key = Object.keys(request.headers).find(k => k.toLowerCase() === name);
    return request.headers[key];
  };
  const value = component => {
    switch (component) {
      case '@method':
        return request.method.toUpperCase();
      case '@target-uri':
        return canonicalTargetUri(request.url, '3.2');
      case '@authority':
        return canonicalAuthority(request.url, '3.2');
      default:
        return header(component);
    }
  };
  return [
    ...parsed.components.map(c => `"${c}": ${value(c)}`),
    `"@signature-params": ${parsed.serialized}`,
  ].join('\n');
}

function publicKey(jwk) {
  return crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.y ? { y: jwk.y } : {}) }, format: 'jwk' });
}

function cryptoVerify(jwk, base, signature) {
  const data = Buffer.from(base, 'utf8');
  if (jwk.kty === 'OKP') return crypto.verify(null, data, publicKey(jwk), signature);
  return crypto.verify('sha256', data, { key: publicKey(jwk), dsaEncoding: 'ieee-p1363' }, signature);
}

function jwksFor(vector) {
  if (vector.jwks_override) return vector.jwks_override.keys;
  return vector.jwks_ref.map(kid => {
    const { _private_d_for_test_only, ...pub } = keys.find(k => k.kid === kid);
    return pub;
  });
}

async function sdkVerify(vector) {
  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  const state = vector.test_harness_state ?? {};
  const scope = canonicalTargetUri(vector.request.url, '3.2');
  for (const entry of state.replay_cache_entries ?? []) {
    replayStore.preload(entry.keyid, scope, entry.nonce, entry.ttl_seconds, vector.reference_now);
  }
  if (state.replay_cache_per_keyid_cap_hit) {
    replayStore.setCapHitForTesting(state.replay_cache_per_keyid_cap_hit.keyid);
  }
  if (state.revocation_list) revocationStore.load(state.revocation_list);
  return verifyRequestSignature(
    { method: vector.request.method, url: vector.request.url, headers: vector.request.headers, body: vector.request.body },
    {
      capability: vector.verifier_capability,
      jwks: new StaticJwksResolver(jwksFor(vector)),
      replayStore,
      revocationStore,
      now: () => vector.reference_now,
      operation: 'create_media_buy',
      adcpVersion: '3.2',
    }
  );
}

describe('AdCP 3.2 request-signing corpus covers content-digest (adcp#7733)', () => {
  it('mirrors every legacy positive vector under the same number and slug', () => {
    const files = new Set(profilePositive.map(e => e.file));
    // In 3.2 a basic POST is a POST with content-digest: root 001 and 002 both
    // map onto the hand-authored profile-3.2/positive/001.
    const COLLAPSED = new Set(['001-basic-post.json', '002-post-with-content-digest.json']);
    assert.ok(files.has('001-post-with-content-digest.json'));
    for (const { file } of legacyPositive) {
      if (COLLAPSED.has(file)) continue;
      assert.ok(files.has(file), `positive/${file} has no profile-3.2 counterpart with the same number and slug`);
    }
  });

  it('mirrors every legacy negative for checklist steps 2–12 under the same number and slug', () => {
    const files = new Set(profileNegative.map(e => e.file));
    for (const { file, vector } of legacyNegative) {
      const step = String(vector.expected_outcome.failed_step);
      const inSteps2to12 = /^([2-9]|1[0-2])a?$/.test(step);
      // 'forbidden' is a legacy-only posture a 3.2 verifier cannot advertise.
      if (!inSteps2to12 || vector.verifier_capability.covers_content_digest === 'forbidden') continue;
      assert.ok(files.has(file), `negative/${file} has no profile-3.2 counterpart with the same number and slug`);
    }
  });

  it('keeps generated negatives as step-ordering canaries: pre-crypto steps carry the zero placeholder', () => {
    for (const { id, vector } of generated.filter(e => e.id.includes('/negative/'))) {
      const step = vector.expected_outcome.failed_step;
      const preCrypto = step === '9a' || (typeof step === 'number' && step < 10);
      const zero = sig1Bytes(vector.request.headers.Signature).bytes.equals(Buffer.alloc(64));
      if (preCrypto) assert.ok(zero, `${id} (step ${step}) must carry the zero placeholder signature`);
      else if (vector.expected_outcome.error_code !== 'request_signature_invalid') {
        assert.ok(!zero, `${id} (step ${step}) must carry a real signature so only the targeted check fails`);
      }
    }
  });

  it('pins every profile-3.2 vector to the 3.2 profile and required digest coverage', () => {
    for (const { id, vector } of profileAll) {
      assert.equal(vector.signing_profile_version, '3.2', id);
      assert.equal(vector.verifier_capability.covers_content_digest, 'required', id);
      const parsed = parseSig1Input(vector.request.headers['Signature-Input']);
      const missingDigestCase = vector.expected_outcome.error_code === 'request_signature_components_incomplete'
        && slugOf(path.basename(id)) === 'missing-content-digest';
      assert.equal(parsed.components.includes('content-digest'), !missingDigestCase, `${id} content-digest coverage`);
    }
  });

  it('uses RFC 8941 standard padded Base64 for every sf-binary value in generated vectors', () => {
    for (const { id, vector } of generated) {
      for (const name of ['Signature', 'Content-Digest']) {
        for (const token of vector.request.headers[name].matchAll(/:([^:]*):/g)) {
          assert.match(token[1], /^[A-Za-z0-9+/]*={0,2}$/, `${id} ${name}`);
          assert.equal(token[1].length % 4, 0, `${id} ${name} must be padded`);
        }
      }
    }
  });

  it('carries a Content-Digest equal to sha-256 of the body, except the digest-mismatch vector', () => {
    for (const { id, vector } of profileAll) {
      const expected = `sha-256=:${crypto.createHash('sha256').update(vector.request.body, 'utf8').digest('base64')}:`;
      if (vector.expected_outcome.error_code === 'request_signature_digest_mismatch') {
        assert.notEqual(vector.request.headers['Content-Digest'], expected, id);
      } else if (!HAND_AUTHORED.has(id) || id.includes('positive')) {
        assert.equal(vector.request.headers['Content-Digest'], expected, id);
      }
    }
  });
});

describe('AdCP 3.2 request-signing vectors verify independently', () => {
  for (const { id, vector } of generated) {
    const signed = !/^A+==$/.test(sig1Bytes(vector.request.headers.Signature).token);

    it(`${id}: recomputed signature base matches and signature ${signed ? 'verifies' : 'is the zero placeholder'}`, () => {
      const base = independentBase(vector);
      if (vector.expected_signature_base !== undefined) assert.equal(base, vector.expected_signature_base);
      const { bytes } = sig1Bytes(vector.request.headers.Signature);
      if (!signed) {
        assert.ok(bytes.equals(Buffer.alloc(64)), 'placeholder must be 64 zero bytes');
        assert.equal(vector.expected_outcome.success, false, 'positive vectors must be really signed');
        return;
      }
      const kid = parseSig1Input(vector.request.headers['Signature-Input']).params.keyid;
      assert.equal(cryptoVerify(keys.find(k => k.kid === kid), base, bytes), true);
    });

    it(`${id}: @adcp/sdk 3.2 verifier returns the expected outcome`, async () => {
      const outcome = vector.expected_outcome;
      if (outcome.success) {
        const result = await sdkVerify(vector);
        assert.equal(result.status, 'verified');
        return;
      }
      await assert.rejects(sdkVerify(vector), err => {
        assert.equal(err.code, outcome.error_code);
        return true;
      });
    });
  }
});
