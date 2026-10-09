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

// RFC 9421 section 4.2 makes the Signature member an RFC 8941 Byte Sequence
// (sections 3.3.5, 4.1.7, 4.2.7): standard base64 alphabet (+ and /), padded.
// Buffer.from(..., 'base64') also accepts base64url and missing padding, so the
// grammar and canonical encoding are checked before decoding.
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const decodeStandardBase64 = text => {
  if (!STANDARD_BASE64.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
};

test('strict standard base64 decoding rejects base64url and unpadded forms', () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x01, 0x02]);
  const standard = bytes.toString('base64');
  assert.match(standard, /[+/]/);
  assert.deepEqual(decodeStandardBase64(standard), bytes);
  const urlSafe = standard.replaceAll('+', '-').replaceAll('/', '_');
  assert.deepEqual(Buffer.from(urlSafe, 'base64'), bytes, 'Node tolerates base64url, so the strict check must reject it');
  assert.equal(decodeStandardBase64(urlSafe), null);
  assert.equal(decodeStandardBase64(standard.replace(/=+$/, '')), null);
  assert.equal(decodeStandardBase64('AB=='), null, 'non-canonical trailing bits');
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
    const signature = decodeStandardBase64(encodedSignature);
    assert.ok(signature, `${file}: Signature must be padded standard base64 (RFC 8941 Byte Sequence)`);
    assert.equal(signature.length, 64);
    const urlSafe = encodedSignature.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    assert.notEqual(urlSafe, encodedSignature);
    assert.equal(decodeStandardBase64(urlSafe), null);
    assert.equal(crypto.verify(null, Buffer.from(base), publicKey, signature), true);
    if (file.startsWith('positive/')) {
      // Ed25519 is deterministic: re-signing with the public test-only key reproduces the fixture.
      const privateKey = crypto.createPrivateKey({ key: { kty: key.kty, crv: key.crv, x: key.x, d: key._private_d_for_test_only }, format: 'jwk' });
      assert.equal(crypto.sign(null, Buffer.from(base), privateKey).toString('base64'), encodedSignature);
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
