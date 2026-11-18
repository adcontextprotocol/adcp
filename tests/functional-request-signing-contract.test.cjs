'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const vectorsDir = path.join(ROOT, 'static/compliance/source/test-vectors/request-signing');
const keysPath = path.join(vectorsDir, 'keys.json');

function loadContract() {
  return yaml.load(fs.readFileSync(contractPath, 'utf8'));
}

function listVectorFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listVectorFiles(entryPath);
    return entry.name.endsWith('.json') && entry.name !== 'keys.json' ? [entryPath] : [];
  });
}

function readSignatureKeyids(vectorPath) {
  const text = fs.readFileSync(vectorPath, 'utf8');
  return [...text.matchAll(/keyid=\\"([^"\\]+)\\"/g)].map(match => match[1]);
}

test('installed SDK beta.12 parses the source functional-dispatch contract', () => {
  const contract = loadSignedRequestsRunnerContract({
    complianceDir: path.join(ROOT, 'static/compliance/source'),
  });

  assert.ok(contract, 'SDK must load the source runner contract');
  assert.equal(contract.functional_dispatch.signing_keyid, 'test-functional-2026');
  assert.equal(contract.functional_dispatch.operation_selection.sign_required_for, true);
  assert.equal(contract.functional_dispatch.operation_selection.sign_supported_for, true);
  assert.deepEqual(contract.functional_dispatch.bootstrap_operations_unsigned, [
    'get_adcp_capabilities',
  ]);
});

test('functional dispatch signs with a declared non-revoked request-signing test key', () => {
  const contract = loadContract();
  const keyset = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const dispatch = contract.functional_dispatch;

  assert.equal(contract.endpoint_scope, 'sandbox');
  assert.equal(dispatch.signing_keyid, 'test-functional-2026');
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
  const { _private_d_for_test_only: d, ...publicJwk } = key;
  const derivedPublic = crypto
    .createPublicKey(crypto.createPrivateKey({ key: { ...publicJwk, d }, format: 'jwk' }))
    .export({ format: 'jwk' });
  assert.equal(derivedPublic.x, key.x, 'published private scalar must match the published public key');
  assert.notEqual(
    dispatch.signing_keyid,
    contract.stateful_vector_contract.revocation.pre_revoked_keyid,
    'functional requests must not use the pre-revoked negative-vector key'
  );
});

test('functional dispatch keyid is not shared with any conformance vector', () => {
  const dispatchKeyid = loadContract().functional_dispatch.signing_keyid;
  const vectorFiles = listVectorFiles(vectorsDir);
  const rateAbuseVectors = vectorFiles.filter(file => path.basename(file) === '020-rate-abuse.json');

  assert.equal(rateAbuseVectors.length, 2, 'root and profile-3.2 rate-abuse vectors must both exist');
  for (const vectorPath of rateAbuseVectors) {
    assert.deepEqual([...new Set(readSignatureKeyids(vectorPath))], ['test-ed25519-2026']);
  }
  for (const vectorPath of vectorFiles) {
    assert.ok(
      !fs.readFileSync(vectorPath, 'utf8').includes(dispatchKeyid),
      `${path.relative(vectorsDir, vectorPath)} must not use the functional-dispatch keyid; ` +
        'functional traffic would share its per-keyid replay-cache budget'
    );
  }
});

test('functional signing contract remains sandbox-only and preserves seller verification', () => {
  const contract = loadContract();
  const schema = fs.readFileSync(
    path.join(ROOT, 'static/compliance/source/universal/storyboard-schema.yaml'),
    'utf8'
  );
  const betaGuide = fs.readFileSync(
    path.join(ROOT, 'docs/reference/3-2-beta.mdx'),
    'utf8'
  );

  assert.equal(contract.functional_dispatch.unavailable_behavior, 'not_applicable');
  assert.match(schema, /public conformance private scalar MUST\n#\s+NOT be used/);
  assert.match(schema, /This is NOT a sandbox-mode verifier bypass/);
  assert.match(schema, /Never fall back to unsigned dispatch/);
  assert.match(betaGuide, /Do not weaken production authentication/);
});

test('unsigned MCP session ids cannot carry AdCP authority', () => {
  const securityGuide = fs.readFileSync(
    path.join(ROOT, 'docs/building/by-layer/L1/security.mdx'),
    'utf8'
  );
  const mcpGuide = fs.readFileSync(
    path.join(ROOT, 'docs/building/by-layer/L0/mcp-guide.mdx'),
    'utf8'
  );
  const brandGuide = fs.readFileSync(
    path.join(ROOT, 'docs/brand-protocol/building-a-brand-agent.mdx'),
    'utf8'
  );

  assert.match(securityGuide, /MCP transport sessions are non-authoritative/);
  assert.match(securityGuide, /`Mcp-Session-Id` is not a\s+covered component/);
  assert.match(
    securityGuide,
    /MUST NOT attribute identity, authorization, account selection,\s+resource access, or task ownership/s
  );
  assert.match(securityGuide, /does not\s+include recognized per-request credential channels such as `Authorization`/s);
  assert.match(securityGuide, /when request signing\s+applies/s);
  assert.match(securityGuide, /additionally keyed by the authenticated principal and\s+account/s);
  assert.match(securityGuide, /Rebinding.*MUST NOT\s+change the principal/s);
  assert.match(mcpGuide, /bind every task to the authenticated principal and account/);
  assert.match(mcpGuide, /`sessionId` may be retained only as secondary transport metadata/);
  assert.doesNotMatch(mcpGuide, /filters by `sessionId` on every operation/);
  assert.match(brandGuide, /extra\?\.auth\?\.principalId/);
  assert.doesNotMatch(brandGuide, /db\.isLinkedAccount\(sessionId\)/);
});
