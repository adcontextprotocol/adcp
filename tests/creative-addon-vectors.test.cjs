// Executable reference checks for the normative vectors. This is not a seller runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { canonicalize } = require('@adcp/sdk');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schemas = path.join(__dirname, '../static/schemas/source');
const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true });
addFormats(ajv);
for (const file of fs.readdirSync(schemas, { recursive: true })) {
  if (!file.endsWith('.json')) continue;
  const schema = JSON.parse(fs.readFileSync(path.join(schemas, file)));
  if (schema.$id) ajv.addSchema(schema);
}
const validChain = ajv.getSchema('/schemas/core/creative-addon-chain.json');
const validClaims = ajv.getSchema('/schemas/core/creative-addon-chain.json#/definitions/Claims');
const validHeader = ajv.getSchema('/schemas/core/creative-addon-chain.json#/definitions/ProtectedHeader');
const validKey = ajv.getSchema('/schemas/core/creative-addon-signing-key.json');
const fixturePath = path.join(__dirname, '../static/compliance/source/test-vectors/creative-addon-chain.json');
const sha = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const jsonBytes = value => Buffer.from(canonicalize(value), 'utf8');
const encode = value => jsonBytes(value).toString('base64url');
function decode(value) {
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  const bytes = Buffer.from(value, 'base64url');
  assert.equal(bytes.toString('base64url'), value, 'noncanonical base64url');
  return bytes;
}
function keyThumbprint(key) { return sha(jsonBytes({ crv: key.crv, kty: key.kty, x: key.x })); }
function evaluate(chain, trust) {
  try {
    const jws = chain.signed_attestation;
    if (jws.profile !== 'adcp/addon-chain/v1') return 'profile';
    const header = JSON.parse(decode(jws.protected));
    if (!validHeader(header)) return 'header';
    const key = trust.key;
    if (!validKey(key) || key.kid !== header.kid) return 'key_purpose';
    if (trust.publisher_pin) {
      if (keyThumbprint(key) !== keyThumbprint(trust.publisher_pin)) return 'publisher_pin';
      for (const field of ['alg', 'use', 'adcp_use']) {
        if (trust.publisher_pin[field] !== undefined && trust.publisher_pin[field] !== key[field]) return 'publisher_pin';
      }
      if (trust.publisher_pin.key_ops && !trust.publisher_pin.key_ops.includes('verify')) return 'publisher_pin';
    }
    if (!crypto.verify(null, Buffer.from(`${jws.protected}.${jws.payload}`), crypto.createPublicKey({ key, format: 'jwk' }), decode(jws.signature))) return 'signature';
    const payloadBytes = decode(jws.payload);
    const claims = JSON.parse(payloadBytes);
    if (!jsonBytes(claims).equals(payloadBytes)) return 'canonicalization';
    if (!validChain(chain) || !validClaims(claims)) return 'schema';
    if (!Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > trust.now + 60) return 'time';
    for (const authority of [key, trust.publisher_pin].filter(Boolean)) {
      if (!authority.revoked_at) continue;
      const revoked = Date.parse(authority.revoked_at) / 1000;
      if (!Number.isFinite(revoked) || claims.iat >= revoked || !trust.observed_at || trust.observed_at >= revoked || trust.observed_at < claims.iat || trust.observed_chain_hash !== chain.chain_hash || trust.observed_attestation_hash !== sha(jsonBytes(jws))) return 'revocation';
    }
    for (const field of ['agent_url', 'publisher_domain', 'creative_id', 'format_kind', 'variant_id', 'media_buy_id', 'package_id', 'placement_id', 'revision_id', 'locale_variant_id']) {
      if (claims[field] !== trust.expected[field]) return 'context';
    }
    if (claims.typ !== 'adcp-addon-chain+jws' || claims.creative_id !== chain.creative_id || claims.creative_hash !== chain.creative_hash || chain.creative_hash !== trust.expected.creative_hash) return 'creative_hash';
    if (sha(jsonBytes(chain.entries)) !== chain.chain_hash || claims.chain_hash !== chain.chain_hash) return 'chain_hash';
    if (sha(jsonBytes(chain.configuration)) !== claims.configuration_hash) return 'configuration_hash';
    if (chain.configuration.complete !== true || chain.configuration.scope !== 'product' || chain.configuration.product_id !== trust.expected.product_id) return 'configuration';
    let lastApplied = [-1, -1, -1];
    let sawOmission = false;
    let lastOmission = -1;
    const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    for (const [i, entry] of chain.entries.entries()) {
      if (entry.order !== i || 'content' in entry || 'auth' in entry) return 'entry';
      const vendor = chain.configuration.vendors[entry.registration_index];
      if (!vendor || entry.agent_name !== vendor.agent_name || entry.source !== vendor.source || entry.agent_url !== vendor.agent_url) return 'entry';
      if (entry.status === 'applied') {
        if (sawOmission || !vendor.positions.includes(entry.position) || !vendor.format_kinds.includes(claims.format_kind)) return 'order';
        const tuple = [entry.position === 'prepend' ? 0 : 1, entry.registration_index, entry.fragment_index];
        if (compare(tuple, lastApplied) <= 0) return 'order';
        lastApplied = tuple;
        if (vendor.source === 'static_reference' && entry.content_hash !== vendor.static_content_hash) return 'entry';
      } else if (entry.status === 'omitted') {
        sawOmission = true;
        if (entry.registration_index <= lastOmission) return 'order';
        lastOmission = entry.registration_index;
        if (vendor.mode === 'required') return 'required_omission';
        if (!['failure', 'vendor_omission'].includes(entry.reason) || (entry.reason === 'failure') !== ('error_code' in entry)) return 'entry';
      } else return 'entry';
    }
    for (const [index, vendor] of chain.configuration.vendors.entries()) {
      const entries = chain.entries.filter(entry => entry.registration_index === index);
      if (!vendor.format_kinds.includes(claims.format_kind)) { if (entries.length) return 'entry'; continue; }
      if (!entries.length || (entries.some(e => e.status === 'omitted') && entries.length !== 1)) return 'coverage';
      const fragments = entries.filter(e => e.status === 'applied').map(e => e.fragment_index).sort((a, b) => a - b);
      if (fragments.some((value, index) => value !== index)) return 'entry';
    }
    return 'verified';
  } catch { return 'encoding'; }
}
function assemble(input) {
  // Model the seller decision boundary; vendors are supplied as recorded outcomes.
  const applied = []; const omitted = [];
  let pending = false;
  for (const [registration_index, vendor] of input.vendors.entries()) {
    if (vendor.mode === 'required' && vendor.first_failure_seconds !== undefined &&
        input.elapsed_seconds >= vendor.first_failure_seconds + vendor.max_hold_seconds) {
      return { status: 'failed', code: 'ADDON_REQUIRED_UNAVAILABLE' };
    }
    if (vendor.source === 'static_reference') {
      applied.push({ registration_index, fragment_index: 0, position: vendor.position, content: vendor.content });
      continue;
    }
    const invalid = vendor.fragments?.some(f => sha(Buffer.from(f.content, 'utf8')) !== f.content_hash || !['prepend', 'append'].includes(f.position));
    const failed = vendor.error_code || invalid || !vendor.fragments?.length;
    if (failed) {
      if (vendor.mode === 'required') {
        const deadline = (vendor.first_failure_seconds ?? 0) + vendor.max_hold_seconds;
        if (!input.async || input.elapsed_seconds >= deadline) return { status: 'failed', code: 'ADDON_REQUIRED_UNAVAILABLE' };
        pending = true;
        continue;
      }
      omitted.push({ registration_index, reason: vendor.error_code || invalid ? 'failure' : 'vendor_omission' });
      continue;
    }
    vendor.fragments.forEach((f, fragment_index) => applied.push({ ...f, registration_index, fragment_index }));
  }
  if (pending) return { status: 'working', task_id: input.task_id };
  applied.sort((a, b) => (a.position === 'prepend' ? 0 : 1) - (b.position === 'prepend' ? 0 : 1) || a.registration_index - b.registration_index || a.fragment_index - b.fragment_index);
  return { status: 'completed', fragments: applied.map(f => f.content), omitted };
}

test('published addon vectors exist and verify using independent crypto and JCS implementations', () => {
  assert.ok(fs.existsSync(fixturePath), 'missing published creative addon vectors');
  const fixture = JSON.parse(fs.readFileSync(fixturePath));
  for (const vector of fixture.valid) {
    assert.equal(sha(Buffer.from(vector.fragment, 'utf8')), vector.fragment_hash, vector.id);
    assert.equal(sha(jsonBytes(vector.creative_hash_input)), vector.chain.creative_hash, vector.id);
    assert.equal(evaluate(vector.chain, vector.trust), 'verified', vector.id);
    assert.equal(crypto.sign(null, Buffer.from(`${vector.chain.signed_attestation.protected}.${vector.chain.signed_attestation.payload}`), crypto.createPrivateKey({ key: fixture.test_private_key, format: 'jwk' })).toString('base64url'), vector.chain.signed_attestation.signature, `${vector.id} deterministic signature`);
  }
});

test('negative signature vectors reject altered chains, wrong authority and mismatched delivery context', () => {
  assert.ok(fs.existsSync(fixturePath), 'missing published creative addon vectors');
  const fixture = JSON.parse(fs.readFileSync(fixturePath));
  const failures = [];
  for (const vector of fixture.invalid) {
    const base = structuredClone(fixture.valid[vector.base || 0]);
    for (const edit of vector.edits) {
      let target = base;
      const keys = edit.path.split('.');
      const last = keys.pop();
      for (const key of keys) target = target[key];
      if (edit.remove) delete target[last]; else target[last] = edit.value;
    }
    const actual = evaluate(base.chain, base.trust);
    if (actual !== vector.expected) failures.push({ id: vector.id, actual, expected: vector.expected });
  }
  assert.deepEqual(failures, []);
});

test('behavior vectors preserve required holds and explicit best-effort omissions', () => {
  assert.ok(fs.existsSync(fixturePath), 'missing published creative addon vectors');
  const fixture = JSON.parse(fs.readFileSync(fixturePath));
  const actual = fixture.behavior.map(vector => ({ id: vector.id, result: assemble(vector.input) }));
  const expected = fixture.behavior.map(vector => ({ id: vector.id, result: vector.expected }));
  assert.deepEqual(actual, expected);
});

// Check a recorded recovery exchange, including the identity boundary between
// transport replay and a fresh vendor evaluation. No network/runtime is simulated.
function verifyRecoveryTrace(trace) {
  const first = trace[0];
  for (let i = 1; i < trace.length; i++) {
    const before = trace[i - 1]; const after = trace[i];
    if (after.task_id !== first.task_id || after.deadline !== first.deadline) return 'seller_operation_changed';
    const sameKey = before.request.idempotency_key === after.request.idempotency_key;
    if (sameKey && !jsonBytes(before.request).equals(jsonBytes(after.request))) return 'idempotency_conflict';
    if (before.outcome === 'ambiguous' && !sameKey) return 'unresolved_attempt';
    if (before.outcome !== 'ambiguous' && sameKey && after.outcome !== before.outcome) return 'changed_replay';
    if (after.at >= after.deadline && after.outcome === 'applied') return 'late_delivery';
  }
  return 'valid';
}

test('required empty response can recover with fresh evaluation and feedback while ambiguous retries preserve the exact request', () => {
  const first = { task_id: 'seller-task-1', deadline: 60, at: 1,
    request: { idempotency_key: 'vendor-attempt-0001', creatives: [{ creative_id: 'c', format_kind: 'image' }] }, outcome: 'empty' };
  const repairedRequest = { ...first.request, idempotency_key: 'vendor-attempt-0002', prior_failures: [{ error_code: 'ADDON_MALFORMED_FRAGMENT', creative_id: 'c', format_kind: 'image', timestamp: '2026-10-14T12:00:01Z' }] };
  const pending = { ...first, at: 20, request: repairedRequest, outcome: 'ambiguous' };
  const recovered = { ...pending, at: 25, outcome: 'applied' };
  assert.equal(verifyRecoveryTrace([first, pending, recovered]), 'valid');
  assert.equal(verifyRecoveryTrace([first, { ...pending, request: { ...repairedRequest, idempotency_key: first.request.idempotency_key } }]), 'idempotency_conflict');
  assert.equal(verifyRecoveryTrace([first, pending, { ...recovered, request: { ...repairedRequest, idempotency_key: 'vendor-attempt-0003' } }]), 'unresolved_attempt');
  assert.equal(verifyRecoveryTrace([first, { ...pending, deadline: 90 }]), 'seller_operation_changed');
  assert.equal(verifyRecoveryTrace([first, pending, { ...recovered, at: 60 }]), 'late_delivery');
});
