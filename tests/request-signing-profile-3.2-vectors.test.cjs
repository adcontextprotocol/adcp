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

// Step-0/1 mirrors with no Signature-Input at all: unsigned requests (pre-check 0) and a
// Signature whose Signature-Input was stripped (019).
const NO_SIGNATURE_INPUT = new Set([
  '001-no-signature-header',
  '019-signature-without-signature-input',
  '027-webhook-registration-authentication-unsigned',
  '028-unsigned-protocol-method-required',
]);
const UNSIGNED = new Set([
  '001-no-signature-header',
  '027-webhook-registration-authentication-unsigned',
  '028-unsigned-protocol-method-required',
]);
// 011's Signature-Input is unparseable, so no signature base exists and the placeholder stays.
const UNPARSEABLE_INPUT = new Set(['011-malformed-header']);
// Step-1 mirrors whose fault is independent of the signature bytes carry a real signature,
// so the step-1 fault is the vector's only fault.
const REAL_SIGNATURE_STEP1 = new Set([
  '019-signature-without-signature-input',
  '021-duplicate-signature-input-label',
  '022-multi-valued-content-type',
  '023-multi-valued-content-digest',
  '024-unquoted-string-param',
  '026-non-ascii-host',
  '029-duplicate-signature-label',
  '030-content-digest-key-case',
  '031-malformed-host-authority',
]);
const MIRRORED_PRECHECK = new Set([...UNSIGNED, ...UNPARSEABLE_INPUT, ...REAL_SIGNATURE_STEP1]);
const MULTI_VALUED_DIGEST = new Set(['023-multi-valued-content-digest', '030-content-digest-key-case']);

const slugKey = id => path.basename(id);

/** Split the sig1 member of a Signature-Input header into components + raw params. */
function parseSig1Input(header) {
  const match = header === undefined ? null : /^sig1=(\(([^)]*)\)[^,]*)/.exec(header);
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
        return [part.slice(0, eq), raw.startsWith('"') ? JSON.parse(raw) : Number.isNaN(Number(raw)) ? raw : Number(raw)];
      })
  );
  return { serialized: match[1], components, params };
}

function sig1Bytes(header) {
  const token = header === undefined ? undefined : /^sig1=:([^:]*):/.exec(header)?.[1];
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

// Operation the SDK resolves for vectors that are not create_media_buy; 028 is a JSON-RPC protocol method.
const SDK_OPERATION = {
  'negative/011-malformed-header': 'sync_creatives',
  'negative/027-webhook-registration-authentication-unsigned': 'update_media_buy',
  'negative/028-unsigned-protocol-method-required': undefined,
};

async function sdkVerify(vector, id) {
  const relId = id.replace(/^profile-3\.2\//, '');
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
      operation: relId in SDK_OPERATION ? SDK_OPERATION[relId] : 'create_media_buy',
      adcpVersion: '3.2',
    }
  );
}

// @adcp/sdk 14.2.0 in adcpVersion '3.2' mode converts a raw IDN U-label to its A-label instead of
// rejecting it (docs/reference/url-canonicalization.mdx: the comparer MUST reject raw non-ASCII), so it
// verifies the single-fault 026 mirror, and it derives @authority from the URL rather than the Host header, so
// it verifies 031. Both are sibling-repo (adcp-client) fixes; remove an entry when the SDK rejects the vector.
const SDK_KNOWN_GAPS = {
  '026-non-ascii-host': '@adcp/sdk 14.2.0 (adcpVersion 3.2) verifies a raw U-label host instead of rejecting it',
  '031-malformed-host-authority': '@adcp/sdk 14.2.0 (adcpVersion 3.2) derives @authority from the URL and ignores the malformed Host header',
};

describe('AdCP 3.2 request-signing corpus covers content-digest (adcp#7733)', () => {
  it('mirrors every legacy positive vector under the same number and slug', () => {
    const files = new Set(profilePositive.map(e => e.file));
    // In 3.2 a basic POST is a POST with content-digest: root 001 and 002 both
    // map onto the hand-authored profile-3.2/positive/001. The absence of
    // positive/001-basic-post is by design.
    const COLLAPSED = new Set(['001-basic-post.json', '002-post-with-content-digest.json']);
    assert.ok(files.has('001-post-with-content-digest.json'));
    for (const { file } of legacyPositive) {
      if (COLLAPSED.has(file)) continue;
      assert.ok(files.has(file), `positive/${file} has no profile-3.2 counterpart with the same number and slug`);
    }
  });

  it('mirrors every legacy negative under the same number and slug, except those for postures 3.2 forbids', () => {
    const files = new Set(profileNegative.map(e => e.file));
    const unmirrored = [];
    for (const { file, vector } of legacyNegative) {
      // 'forbidden' is a legacy-only posture a 3.2 verifier cannot advertise.
      if (vector.verifier_capability.covers_content_digest === 'forbidden') {
        assert.ok(!files.has(file), `negative/${file} grades a posture 3.2 forbids and must not be mirrored`);
        unmirrored.push(file);
        continue;
      }
      assert.ok(files.has(file), `negative/${file} has no profile-3.2 counterpart with the same number and slug`);
    }
    assert.deepEqual(unmirrored, ['018-digest-covered-when-forbidden.json']);
  });

  it('keeps generated negatives as step-ordering canaries: pre-crypto steps carry the zero placeholder', () => {
    for (const { id, vector } of generated.filter(e => e.id.includes('/negative/'))) {
      const key = slugKey(id);
      const step = vector.expected_outcome.failed_step;
      if (UNSIGNED.has(key)) {
        assert.equal(vector.request.headers.Signature, undefined, `${id} must stay unsigned`);
        assert.equal(vector.request.headers['Signature-Input'], undefined, `${id} must stay unsigned`);
        continue;
      }
      const zero = sig1Bytes(vector.request.headers.Signature).bytes.equals(Buffer.alloc(64));
      if (REAL_SIGNATURE_STEP1.has(key)) {
        assert.ok(!zero, `${id} must carry a real signature so the step-1 fault is its only fault`);
        continue;
      }
      const preCrypto = step === '9a' || (typeof step === 'number' && step < 10);
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
      if (!parsed) {
        // Only the vectors whose fault is the absence or unparseability of Signature-Input have none to inspect.
        const key = slugKey(id);
        assert.ok(NO_SIGNATURE_INPUT.has(key) || UNPARSEABLE_INPUT.has(key) || HAND_AUTHORED.has(id), `${id} has no parseable Signature-Input`);
        continue;
      }
      const missingDigestCase = vector.expected_outcome.error_code === 'request_signature_components_incomplete'
        && slugOf(path.basename(id)) === 'missing-content-digest';
      assert.equal(parsed.components.includes('content-digest'), !missingDigestCase, `${id} content-digest coverage`);
    }
  });

  it('uses RFC 8941 standard padded Base64 for every sf-binary value in generated vectors', () => {
    for (const { id, vector } of generated) {
      for (const name of ['Signature', 'Content-Digest']) {
        const value = vector.request.headers[name];
        if (value === undefined) {
          assert.equal(name, 'Signature', `${id} must carry a Content-Digest`);
          assert.ok(UNSIGNED.has(slugKey(id)), `${id} must carry a Signature`);
          continue;
        }
        for (const token of value.matchAll(/:([^:]*):/g)) {
          assert.match(token[1], /^[A-Za-z0-9+/]*={0,2}$/, `${id} ${name}`);
          assert.equal(token[1].length % 4, 0, `${id} ${name} must be padded`);
        }
      }
    }
  });

  it('carries a Content-Digest equal to sha-256 of the body, except the digest-mismatch vector', () => {
    for (const { id, vector } of profileAll) {
      const expected = `sha-256=:${crypto.createHash('sha256').update(vector.request.body, 'utf8').digest('base64')}:`;
      const actual = vector.request.headers['Content-Digest'];
      if (vector.expected_outcome.error_code === 'request_signature_digest_mismatch') {
        assert.notEqual(actual, expected, id);
      } else if (MULTI_VALUED_DIGEST.has(slugKey(id))) {
        // Both members are the correct digest; the repeated algorithm (or its case) is the vector's only fault.
        const members = [expected, expected];
        if (slugKey(id) === '030-content-digest-key-case') members[0] = members[0].replace(/^sha-256/, 'SHA-256');
        assert.equal(actual, members.join(', '), id);
      } else if (id === 'profile-3.2/positive/014-content-digest-two-algorithms') {
        // Two distinct algorithms, both correct (positive/014).
        const sha512 = `sha-512=:${crypto.createHash('sha512').update(vector.request.body, 'utf8').digest('base64')}:`;
        assert.equal(actual, `${expected}, ${sha512}`, id);
      } else if (!HAND_AUTHORED.has(id) || id.includes('positive')) {
        assert.equal(actual, expected, id);
      }
    }
  });

  it('carries the Host header that the 031 fault and the 015 guard depend on', () => {
    const host = id => profileAll.find(e => e.id === id).vector.request.headers.Host;
    assert.equal(host('profile-3.2/negative/031-malformed-host-authority'), '::1');
    assert.equal(host('profile-3.2/positive/015-bracketed-ipv6-host-with-port'), '[2001:db8::1]:8443');
  });

  it('gives every step-0/1 and header/authority mirror a single fault: real signature over the base as sent, digest covered', () => {
    const step01 = generated.filter(e => e.id.includes('/negative/') && MIRRORED_PRECHECK.has(slugKey(e.id)));
    assert.deepEqual(
      step01.map(e => slugKey(e.id)).sort(),
      [...MIRRORED_PRECHECK].sort(),
      'the step-0/1 mirrors must be exactly the registered set'
    );
    for (const { id, vector } of step01) {
      const key = slugKey(id);
      assert.ok(vector.request.headers['Content-Digest'], `${id} must send a Content-Digest`);
      if (UNSIGNED.has(key)) continue;
      if (UNPARSEABLE_INPUT.has(key)) continue;
      assert.ok(REAL_SIGNATURE_STEP1.has(key), `${id} is a step-1 mirror and must be registered as carrying a real signature`);
      const parsed = parseSig1Input(vector.request.headers['Signature-Input']);
      if (parsed) {
        assert.ok(parsed.components.includes('content-digest'), `${id} must cover content-digest`);
      } else {
        // 019: the stripped Signature-Input is described by the committed base, which must cover content-digest.
        assert.match(vector.expected_signature_base, /^"content-digest": /m, `${id} committed base must cover content-digest`);
        assert.match(vector.expected_signature_base, /^"@signature-params": \(.*"content-digest".*\);/m, id);
      }
    }
  });
});

describe('AdCP 3.2 request-signing vectors verify independently', () => {
  for (const { id, vector } of generated) {
    const key = slugKey(id);
    const tokenOf = vector.request.headers.Signature === undefined ? undefined : sig1Bytes(vector.request.headers.Signature).token;
    const signed = tokenOf !== undefined && !/^A+==$/.test(tokenOf);

    it(`${id}: recomputed signature base matches and signature ${signed ? 'verifies' : 'is absent or the zero placeholder'}`, () => {
      if (UNSIGNED.has(key)) {
        assert.equal(vector.expected_signature_base, undefined);
        assert.equal(vector.expected_outcome.success, false);
        return;
      }
      const hasInput = parseSig1Input(vector.request.headers['Signature-Input']) !== undefined;
      const { bytes } = sig1Bytes(vector.request.headers.Signature);
      if (!signed) {
        assert.ok(bytes.equals(Buffer.alloc(64)), 'placeholder must be 64 zero bytes');
        assert.equal(vector.expected_outcome.success, false, 'positive vectors must be really signed');
        return;
      }
      let base;
      if (key === '026-non-ascii-host') {
        // The raw U-label cannot be canonicalized by a conformant verifier; the signed base uses the A-label.
        // WHATWG URL ToASCII of the wire URL must equal the signed @target-uri / @authority.
        base = vector.expected_signature_base;
        const wire = new URL(vector.request.url);
        assert.ok(/[^\x00-\x7f]/.test(vector.request.url.split('/')[2]), 'wire URL must carry a raw non-ASCII host');
        const baseLines = base.split('\n');
        assert.ok(baseLines.includes(`"@target-uri": https://${wire.hostname}${wire.pathname}`), `${id} base must carry the A-label @target-uri`);
        assert.ok(baseLines.includes(`"@authority": ${wire.hostname}`), `${id} base must carry the A-label @authority`);
      } else if (hasInput) {
        base = independentBase(vector);
        if (vector.expected_signature_base !== undefined) assert.equal(base, vector.expected_signature_base);
      } else {
        // 019: Signature-Input was stripped; the committed base is the one it would have described.
        base = vector.expected_signature_base;
        assert.ok(base, `${id} must commit the base the stripped Signature-Input described`);
      }
      const kidSource = hasInput ? vector.request.headers['Signature-Input'] : /keyid="([^"]+)"/.exec(base)[0];
      const kid = /keyid="?([^";]+)"?/.exec(kidSource)[1];
      assert.equal(cryptoVerify(keys.find(k => k.kid === kid), base, bytes), true);
    });

    const sdkTest = SDK_KNOWN_GAPS[key] ? { todo: SDK_KNOWN_GAPS[key] } : {};
    it(`${id}: @adcp/sdk 3.2 verifier returns the expected outcome`, sdkTest, async () => {
      const outcome = vector.expected_outcome;
      if (outcome.success) {
        const result = await sdkVerify(vector, id);
        assert.equal(result.status, 'verified');
        return;
      }
      await assert.rejects(sdkVerify(vector, id), err => {
        assert.equal(err.code, outcome.error_code);
        return true;
      });
    });
  }
});
