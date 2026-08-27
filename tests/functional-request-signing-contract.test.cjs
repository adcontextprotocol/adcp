'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  loadSignedRequestsRunnerContract,
} = require('@adcp/sdk/testing/storyboard/request-signing');

const ROOT = path.resolve(__dirname, '..');
const contractPath = path.join(
  ROOT,
  'static/compliance/source/test-kits/signed-requests-runner.yaml'
);
const keysPath = path.join(
  ROOT,
  'static/compliance/source/test-vectors/request-signing/keys.json'
);

function loadContract() {
  return yaml.load(fs.readFileSync(contractPath, 'utf8'));
}

test('installed SDK beta.12 parses the source functional-dispatch contract', () => {
  const contract = loadSignedRequestsRunnerContract({
    complianceDir: path.join(ROOT, 'static/compliance/source'),
  });

  assert.ok(contract, 'SDK must load the source runner contract');
  assert.equal(contract.functional_dispatch.signing_keyid, 'test-ed25519-2026');
  assert.equal(contract.functional_dispatch.operation_selection.sign_required_for, true);
  assert.equal(contract.functional_dispatch.operation_selection.sign_supported_for, true);
  assert.deepEqual(contract.functional_dispatch.bootstrap_operations_unsigned, [
    'get_adcp_capabilities',
  ]);
});

test('functional dispatch reuses a non-revoked request-signing test key', () => {
  const contract = loadContract();
  const keyset = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const dispatch = contract.functional_dispatch;

  assert.equal(contract.endpoint_scope, 'sandbox');
  assert.equal(dispatch.signing_keyid, 'test-ed25519-2026');
  assert.equal(dispatch.signer_agent_url, 'https://compliance-runner.example');
  assert.equal(dispatch.operation_selection.capability_path, 'request_signing');
  assert.equal(dispatch.operation_selection.sign_required_for, true);
  assert.equal(dispatch.operation_selection.sign_supported_for, true);
  assert.equal(dispatch.content_digest_policy_source, 'request_signing.covers_content_digest');
  assert.equal(dispatch.preserve_transport_auth, true);
  assert.equal(dispatch.fresh_signature_per_dispatch, true);
  assert.deepEqual(dispatch.bootstrap_operations_unsigned, ['get_adcp_capabilities']);

  const declaration = contract.runner_signing_keys.find(
    entry => entry.keyid === dispatch.signing_keyid
  );
  const key = keyset.keys.find(entry => entry.kid === dispatch.signing_keyid);
  assert.ok(declaration, 'functional signing key must be declared by the runner contract');
  assert.ok(key, 'functional signing key must exist in keys.json');
  assert.equal(declaration.alg, 'ed25519');
  assert.equal(key.crv, 'Ed25519');
  assert.equal(key.adcp_use, 'request-signing');
  assert.ok(key._private_d_for_test_only, 'runner needs the published test-only private scalar');
  assert.notEqual(
    dispatch.signing_keyid,
    contract.stateful_vector_contract.revocation.pre_revoked_keyid,
    'functional requests must not use the pre-revoked negative-vector key'
  );
});

test('functional signing contract remains sandbox-only and preserves seller verification', () => {
  const contract = loadContract();
  const schema = fs.readFileSync(
    path.join(ROOT, 'static/compliance/source/universal/storyboard-schema.yaml'),
    'utf8'
  );
  const limitation = fs.readFileSync(
    path.join(ROOT, 'docs/reference/known-limitations.mdx'),
    'utf8'
  );

  assert.equal(contract.functional_dispatch.unavailable_behavior, 'not_applicable');
  assert.match(schema, /public conformance private scalar MUST\n#\s+NOT be used/);
  assert.match(schema, /This is NOT a sandbox-mode verifier bypass/);
  assert.match(schema, /Never fall back to unsigned dispatch/);
  assert.match(limitation, /should not weaken production authentication/);
  assert.match(limitation, /no runner should add a sandbox verifier bypass/);
});
