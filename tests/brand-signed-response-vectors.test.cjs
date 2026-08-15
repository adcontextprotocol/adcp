const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.join(__dirname, '..');
const scenario = YAML.parse(fs.readFileSync(path.join(
  root,
  'static/compliance/source/protocols/brand/scenarios/signed_response_envelope_vectors.yaml'
), 'utf8'));
const kit = YAML.parse(fs.readFileSync(path.join(
  root,
  'static/compliance/source/test-kits/signed-responses-runner.yaml'
), 'utf8'));

const expectedErrors = {
  fresh_valid: null,
  envelope_expired: 'SIGNED_RESPONSE_ENVELOPE_EXPIRED',
  replayed_request_hash_mismatch: 'SIGNED_RESPONSE_REQUEST_HASH_MISMATCH',
  tenant_mismatch: 'SIGNED_RESPONSE_TENANT_MISMATCH',
};

const schemaRoot = path.join(root, 'static/schemas/source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function signedOuter(taskName, response) {
  return {
    ...response,
    status: 'completed',
    signed_response: {
      protected: 'eyJhbGciOiJFZERTQSJ9',
      payload: {
        typ: 'adcp-response-payload+jws',
        task: taskName,
        brand_domain: kit.fixture_agent.expected_tenant,
        agent_url: kit.fixture_agent.agent_url,
        request_hash: `sha256:${'A'.repeat(43)}`,
        iat: 1786838370,
        exp: 1786838700,
        response,
      },
      signature: 'AA',
    },
  };
}

test('single and batch signed-response matrices cover the same ordered vectors', () => {
  assert.equal(scenario.phases.length, 2);
  const steps = scenario.phases.map(phase => phase.steps[0]);
  assert.deepEqual(steps.map(step => step.sample_request.params.task), [
    'verify_brand_claim',
    'verify_brand_claims',
  ]);
  for (const step of steps) {
    assert.deepEqual(Object.values(step.sample_request.params.vector_selectors), Object.keys(expectedErrors));
    assert.equal(step.requires_contract, 'signed_responses_runner');
  }
});

test('runner request and signed success-payload fixtures match source schemas', async () => {
  const profiles = [
    ['single', 'verify-brand-claim'],
    ['batch', 'verify-brand-claims'],
  ];
  for (const [profileName, schemaStem] of profiles) {
    const profile = kit.request_fixtures[profileName];
    const validateRequest = await compile(`/schemas/brand/${schemaStem}-request.json`);
    const validateResponse = await compile(`/schemas/brand/${schemaStem}-response.json`);
    for (const request of [profile.request, profile.replay_request]) {
      assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
    }
    const outer = signedOuter(profile.task, profile.response);
    assert.equal(validateResponse(outer), true, JSON.stringify(validateResponse.errors));
  }
});

test('published test-only response-signing key material is a valid Ed25519 pair', () => {
  const jwk = kit.test_key;
  assert.equal(jwk.adcp_use, 'response-signing');
  assert.deepEqual(jwk.key_ops, ['verify']);
  const publicKey = crypto.createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    format: 'jwk',
  });
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      d: jwk._private_d_for_test_only,
    },
    format: 'jwk',
  });
  const input = Buffer.from('AdCP signed brand response fixture');
  const signature = crypto.sign(null, input, privateKey);
  assert.equal(crypto.verify(null, input, publicKey, signature), true);
});

test('every graded assertion cites a normative DR-0001 source', () => {
  for (const phase of scenario.phases) {
    for (const step of phase.steps) {
      for (const validation of step.validations) {
        assert.match(validation.description, /^DR-0001 \/ /);
      }
    }
  }
});

test('storyboard result assertions and runner outcomes use registered exact errors', () => {
  for (const phase of scenario.phases) {
    const [step] = phase.steps;
    const trafficChecks = step.validations.filter(item => item.check === 'upstream_traffic');
    assert.equal(trafficChecks.length, 4);
    for (const validation of trafficChecks) {
      const fields = Object.fromEntries(validation.payload_must_contain.map(item => [item.path, item]));
      const vector = fields.vector_id.value;
      const expected = expectedErrors[vector];
      assert.equal(fields.decision.value, expected === null ? 'accept' : 'reject');
      if (expected === null) {
        assert.equal(fields.error_code.match, 'equals');
        assert.equal(fields.error_code.value, null);
      } else {
        assert.equal(fields.error_code.value, expected);
      }
      assert.equal(kit.vector_contract[vector].expected_error_code, expected);
    }
  }
});

test('negative vectors isolate expiry, request binding, and tenant binding', () => {
  assert.equal(kit.time_contract.expired_exp_offset_seconds, -61);
  assert.equal(kit.time_contract.clock_skew_seconds, 60);

  const replay = kit.vector_contract.replayed_request_hash_mismatch;
  assert.equal(replay.request_sent, 'replay_request');
  assert.equal(replay.request_hashed, 'original');

  const tenant = kit.vector_contract.tenant_mismatch;
  assert.equal(tenant.request_hash_brand_domain, 'mismatched_tenant');
  assert.equal(tenant.expected_brand_domain, 'expected_tenant');
  assert.equal(kit.signing_contract.outer_response_rule.includes('step 10'), true);
});
