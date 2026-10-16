'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schemaRoot = path.join(__dirname, '..', 'static/schemas/source');
const vectorsRoot = path.join(__dirname, '..', 'static/compliance/source/test-vectors/request-signing');
const readSchema = ref => JSON.parse(fs.readFileSync(path.join(schemaRoot, ref.replace(/^\/schemas\//, '')), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true, loadSchema: async ref => readSchema(ref) });
addFormats(ajv);
const legacyRoot = path.join(__dirname, '..', 'dist/schemas/3.1.1');
const readLegacySchema = ref => JSON.parse(fs.readFileSync(path.join(legacyRoot, ref.replace(/^\/schemas\/3\.1\.1\//, '')), 'utf8'));
const legacyAjv = new Ajv({ strict: false, allErrors: true, loadSchema: async ref => readLegacySchema(ref) });
addFormats(legacyAjv);
// Signature faults must reach the verifier with a request that the operation
// can parse. Validate literal body bytes, including negative signature cases.
// Synthetic resource paths and protocol envelopes have separate wire contracts.
for (const operation of ['create_media_buy', 'update_media_buy', 'sync_creatives']) {
  test(`${operation} signing vector bodies match the maintained request schema`, async () => {
    const schema = readSchema(`${operation === 'sync_creatives' ? 'creative' : 'media-buy'}/${operation.replaceAll('_', '-')}-request.json`);
    const validate = ajv.getSchema(schema.$id) ?? await ajv.compileAsync(schema);
    const legacy = readLegacySchema(`${operation === 'sync_creatives' ? 'creative' : 'media-buy'}/${operation.replaceAll('_', '-')}-request.json`);
    const validateLegacy = legacyAjv.getSchema(legacy.$id) ?? await legacyAjv.compileAsync(legacy);
    let checked = 0;
    for (const kind of ['positive', 'negative']) {
      for (const file of fs.readdirSync(path.join(vectorsRoot, kind)).filter(file => file.endsWith('.json'))) {
        const vector = JSON.parse(fs.readFileSync(path.join(vectorsRoot, kind, file), 'utf8'));
        if (!new URL(vector.request.url).pathname.endsWith(`/${operation}`)) continue;
        const body = JSON.parse(vector.request.body);
        assert.equal(validate(body), true, `${kind}/${file}: ${JSON.stringify(validate.errors)}`);
        assert.equal(validateLegacy(body), true, `3.1.1 ${kind}/${file}: ${JSON.stringify(validateLegacy.errors)}`);
        checked++;
      }
    }
    assert.ok(checked > 0, `no ${operation} vector bodies validated`);
  });
}

test('all 37 routed fixtures have a validated operation', () => {
  const routed = ['positive', 'negative'].flatMap(kind => fs.readdirSync(path.join(vectorsRoot, kind))
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(vectorsRoot, kind, file), 'utf8'))))
    .filter(vector => ['create_media_buy', 'update_media_buy', 'sync_creatives']
      .some(operation => new URL(vector.request.url).pathname.endsWith(`/${operation}`)));
  assert.equal(routed.length, 37);
});

// RFC 9421 section 4.2 makes the Signature member an RFC 8941 Byte Sequence, and
// RFC 8941 section 3.3.5 specifies the standard base64 alphabet. The AdCP profile
// OVERRIDES that: docs/building/by-layer/L1/security.mdx ("Binary value encoding")
// requires Signature to be emitted as base64url WITHOUT padding, and states that a
// signer emitting `+`, `/` or `=` is non-conformant. Verifiers only SHOULD
// lenient-decode pure standard base64, so a conforming strict verifier may reject a
// standard-base64 Signature with request_signature_header_malformed — which is
// exactly what the maintained SDK does on an explicit 3.1 pin. These fixtures are
// emissions, so they must satisfy the emission MUST, not the verifier's lenience.
//
// This is a 3.0/3.1-ONLY profile. security.mdx on 3.2 INVERTS it: there these values
// are RFC 8941 sf-binary in the standard alphabet and base64url MUST be rejected, and
// the versioned fixtures deliberately preserve both profiles. Do NOT forward-port this
// commit to 3.2/main - the forward-merge conflict on these files is expected and must
// resolve to each line's own profile.
//
// Scope: this governs the Signature token only. Content-Digest is checked for
// truthfulness below and keeps its historical standard-base64 form. The same
// security.mdx rule names Content-Digest alongside Signature, so that form is a known,
// separately tracked discrepancy - this change neither resolves nor claims to resolve
// it. It is out of scope here for a concrete reason: content-digest is a COVERED
// COMPONENT, so its literal field value is part of expected_signature_base. Re-encoding
// it would change the signed base and require a genuine re-sign. A verifier rebuilds
// the base from the verbatim received field bytes and MUST NOT normalise Content-Digest
// to base64url first, or these vectors will fail to verify.
// Buffer.from(..., 'base64') tolerates both alphabets and missing padding, so the
// grammar and canonical round-trip are checked before decoding.
const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/;
const decodeBase64UrlUnpadded = text => {
  if (!BASE64URL_UNPADDED.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
};

test('strict base64url decoding rejects standard-alphabet and padded forms', () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x01, 0x02]);
  const urlSafe = bytes.toString('base64url');
  assert.match(urlSafe, /[_-]/);
  assert.doesNotMatch(urlSafe, /[+/=]/);
  assert.deepEqual(decodeBase64UrlUnpadded(urlSafe), bytes);
  const standard = bytes.toString('base64');
  assert.match(standard, /[+/]/);
  assert.deepEqual(Buffer.from(standard, 'base64url'), bytes, 'Node tolerates standard base64, so the strict check must reject it');
  assert.equal(decodeBase64UrlUnpadded(standard), null, 'standard alphabet must be rejected');
  assert.equal(decodeBase64UrlUnpadded(urlSafe + '='), null, 'padding must be rejected');
  assert.equal(decodeBase64UrlUnpadded('A_=='), null, 'mixed/padded forms must be rejected');
  assert.equal(decodeBase64UrlUnpadded('AB'), null, 'non-canonical trailing bits');
});

// The emission MUST applies to EVERY signed vector, not just the two corrected here.
// Byte-sequence tokens are delimited by ':' and the base64url alphabet excludes ':',
// so every token in a Signature header can be extracted and checked directly.
//
// Known limit: only 17 of the 38 tokens carry '-' or '_', because many negative vectors
// use an alphabet-neutral dummy signature. For the other 21 the two alphabets render
// identically, so this guard enforces the no-padding and canonical-length half of the
// grammar on them and cannot, even in principle, distinguish the alphabets. That is
// inherent to those tokens, not a gap in the check.
test('every signed vector emits Signature tokens as unpadded base64url', () => {
  const unsigned = new Set([
    'negative/001-no-signature-header.json',
    'negative/027-webhook-registration-authentication-unsigned.json',
    'negative/028-unsigned-protocol-method-required.json',
  ]);
  let signedVectors = 0;
  let tokens = 0;
  for (const kind of ['positive', 'negative']) {
    for (const name of fs.readdirSync(path.join(vectorsRoot, kind)).filter(file => file.endsWith('.json'))) {
      const file = `${kind}/${name}`;
      const headers = JSON.parse(fs.readFileSync(path.join(vectorsRoot, file), 'utf8')).request.headers;
      const header = Object.keys(headers).find(key => key.toLowerCase() === 'signature');
      if (header === undefined) {
        assert.ok(unsigned.has(file), `${file}: unexpected vector with no Signature header`);
        continue;
      }
      assert.equal(unsigned.has(file), false, `${file}: listed as unsigned but carries a Signature header`);
      signedVectors++;
      const found = [...headers[header].matchAll(/:([^:]*):/g)].map(match => match[1]);
      assert.ok(found.length > 0, `${file}: Signature header carries no byte-sequence token`);
      for (const token of found) {
        tokens++;
        assert.ok(decodeBase64UrlUnpadded(token),
          `${file}: Signature token must be unpadded base64url per the AdCP 3.1 profile override, got ${token}`);
      }
    }
  }
  // Pinned so a new vector cannot silently skip the grammar it is required to satisfy.
  assert.equal(signedVectors, 37);
  assert.equal(tokens, 38);
});

for (const file of ['positive/002-post-with-content-digest.json', 'negative/018-digest-covered-when-forbidden.json']) {
  test(`${file} retains a truthful digest and valid test signature`, () => {
    const vector = JSON.parse(fs.readFileSync(path.join(vectorsRoot, file), 'utf8'));
    const key = JSON.parse(fs.readFileSync(path.join(vectorsRoot, 'keys.json'), 'utf8')).keys
      .find(key => key.kid === 'test-ed25519-2026');
    const publicKey = crypto.createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: 'jwk' });
    const headers = vector.request.headers;
    const digest = headers['Content-Digest'].match(/^sha-256=:([^:]+):$/)?.[1];
    assert.equal(digest, crypto.createHash('sha256').update(vector.request.body).digest('base64'));
    assert.notEqual(digest, crypto.createHash('sha256').update(vector.request.body + ' ').digest('base64'));
    const base = [
      `"@method": ${vector.request.method}`,
      `"@target-uri": ${vector.request.url}`,
      `"@authority": ${new URL(vector.request.url).host}`,
      `"content-type": ${headers['Content-Type']}`,
      `"content-digest": ${headers['Content-Digest']}`,
      `"@signature-params": ${headers['Signature-Input'].slice('sig1='.length)}`,
    ].join('\n');
    if (vector.expected_signature_base !== undefined) assert.equal(vector.expected_signature_base, base);
    const encodedSignature = headers.Signature.match(/^sig1=:([^:]+):$/)[1];
    const signature = decodeBase64UrlUnpadded(encodedSignature);
    assert.ok(signature, `${file}: Signature must be unpadded base64url per the AdCP profile override`);
    assert.equal(signature.length, 64);
    // These two tokens are the ones this fix re-encoded. Both carry '-' and '_', so the
    // standard-alphabet form of the SAME bytes is a genuinely different string - this
    // asserts the re-encode was real, not a no-op on an alphabet-neutral token. The
    // grammar itself is covered by the strict-decoder unit test and the corpus guard.
    assert.match(encodedSignature, /[_-]/, `${file}: expected a base64url-distinctive character`);
    assert.notEqual(signature.toString('base64'), encodedSignature);
    assert.equal(crypto.verify(null, Buffer.from(base), publicKey, signature), true);
    if (file.startsWith('positive/')) {
      // Ed25519 is deterministic: re-signing with the public test-only key reproduces the fixture.
      const privateKey = crypto.createPrivateKey({ key: { kty: key.kty, crv: key.crv, x: key.x, d: key._private_d_for_test_only }, format: 'jwk' });
      assert.equal(crypto.sign(null, Buffer.from(base), privateKey).toString('base64url'), encodedSignature);
    }
    assert.equal(crypto.verify(null, Buffer.from(base + ' '), publicKey, signature), false);
    assert.equal(vector.expected_outcome.success, file.startsWith('positive/'));
    if (file.startsWith('negative/')) {
      assert.equal(vector.verifier_capability.covers_content_digest, 'forbidden');
      assert.equal(vector.expected_outcome.error_code, 'request_signature_components_unexpected');
      assert.equal(vector.expected_outcome.failed_step, 6);
    }
  });
}
