'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/oauth-setup/vectors.json'),
  'utf8',
));
const runnerContract = yaml.load(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-kits/oauth-setup-runner.yaml'),
  'utf8',
));
const storyboard = yaml.load(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/universal/oauth-setup.yaml'),
  'utf8',
));
const securityStoryboard = yaml.load(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/universal/security.yaml'),
  'utf8',
));

function collectChecks(value, checks = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectChecks(item, checks);
  } else if (value && typeof value === 'object') {
    if (typeof value.check === 'string') checks.push(value);
    for (const child of Object.values(value)) collectChecks(child, checks);
  }
  return checks;
}

test('OAuth setup is scoped to the AdCP 3.2 feature line', () => {
  assert.equal(storyboard.introduced_in, '3.2');
  assert.equal(runnerContract.profile, 'adcp/oauth-metadata-graph/v1');
  assert.deepEqual(storyboard.requires_capability, {
    path: 'oauth.supported',
    equals: true,
  });
});

test('OAuth endpoint probes remain passive and credential-free', () => {
  assert.deepEqual(
    {
      mode: runnerContract.endpoint_probes.token_endpoint.mode,
      method: runnerContract.endpoint_probes.token_endpoint.method,
      credentials: runnerContract.endpoint_probes.token_endpoint.credentials,
      follow_redirects: runnerContract.endpoint_probes.token_endpoint.follow_redirects,
    },
    {
      mode: 'passive_transport_reachability',
      method: 'GET',
      credentials: 'none',
      follow_redirects: false,
    },
  );
  assert.equal(runnerContract.fetch_policy.credentials, 'none');
  assert.equal(runnerContract.fetch_policy.fresh_stateless_client, true);
  assert.equal(
    runnerContract.fetch_policy.address_requirement,
    'globally_routable_unicast_per_current_iana_special_purpose_registries',
  );
  assert.equal(runnerContract.graph_limits.max_authorization_servers, 16);
  assert.equal(runnerContract.graph_limits.max_total_requests, 64);
});

test('OAuth resource comparison matches the universal security storyboard', () => {
  const securityResourceCheck = collectChecks(securityStoryboard)
    .find((check) => check.check === 'resource_equals_agent_url');
  assert.ok(securityResourceCheck, 'security storyboard must define its resource comparison');
  assert.equal(
    runnerContract.discovery.protected_resource_metadata.resource_comparison,
    securityResourceCheck.check,
  );
  assert.match(
    runnerContract.discovery.protected_resource_metadata.resource_comparison_semantics,
    /default ports \(443 for HTTPS and 80 for HTTP\).*path remains case-sensitive/s,
  );
  assert.equal(
    runnerContract.discovery.authorization_server_metadata.issuer_comparison,
    'exact_string_equal_to_source_issuer_after_json_decoding_no_url_normalization',
  );
});

test('OAuth setup vector IDs and outcomes are deterministic', () => {
  assert.ok(vectors.positive.length >= 2, 'expected at least two positive vectors');
  assert.ok(vectors.negative.length >= 8, 'expected the required negative edge cases');

  const all = [...vectors.positive, ...vectors.negative];
  const ids = all.map((vector) => vector.id);
  assert.equal(new Set(ids).size, ids.length, 'vector IDs must be unique');

  for (const vector of vectors.positive) {
    assert.deepEqual(vector.expected_outcome, { success: true }, `${vector.id} must be a strict pass`);
  }

  const knownCodes = new Set(Object.keys(runnerContract.diagnostic_codes));
  const coveredCodes = new Set();
  for (const vector of vectors.negative) {
    assert.equal(vector.expected_outcome.success, false, `${vector.id} must be a strict failure`);
    assert.ok(
      knownCodes.has(vector.expected_outcome.error_code),
      `${vector.id} uses unknown diagnostic code ${vector.expected_outcome.error_code}`,
    );
    coveredCodes.add(vector.expected_outcome.error_code);
  }
  assert.deepEqual(coveredCodes, knownCodes, 'every stable diagnostic code must have a negative vector');
});

test('OAuth setup vectors cover the issue acceptance cases', () => {
  const all = [...vectors.positive, ...vectors.negative];
  const coverage = new Set(all.flatMap((vector) => vector.coverage));
  for (const required of [
    'missing_metadata',
    'mismatched_resource',
    'mismatched_issuer',
    'empty_authorization_servers',
    'off_origin_authorization_server',
    'unreachable_document',
    'unreachable_endpoint',
    'every_authorization_server',
    'normalization_near_miss',
    'client_credentials_only',
    'implicit_only',
    'grant_types_default',
    'passive_token_reachability',
    'response_types_empty_rejected',
    'ssrf',
    'mixed_dns_answers',
    'dns_rebinding',
    'url_credentials',
    'scheme_downgrade',
    'graph_budget',
    'missing_conditional_field',
    'invalid_issuer_url',
    'invalid_endpoint_url',
    'invalid_document',
    'ipv4_mapped_ipv6',
    'alternate_ipv4_notation',
    'special_use_range',
  ]) {
    assert.ok(coverage.has(required), `missing vector coverage: ${required}`);
  }

  const offOrigin = vectors.positive.find((vector) =>
    vector.coverage.includes('off_origin_authorization_server'));
  assert.ok(offOrigin, 'off-origin-but-explicit authorization server must have a positive vector');
  assert.equal(offOrigin.expected_outcome.success, true);

  const normalizedResource = vectors.positive.find((vector) =>
    vector.coverage.includes('resource_normalization'));
  assert.ok(normalizedResource, 'normalizable RFC 9728 resource must have a positive vector');
  assert.equal(normalizedResource.expected_outcome.success, true);
});

test('SSRF isolation vectors use authoritative routable fixture classes', () => {
  assert.match(vectors.fixture_contract.dns, /fixture_address_classes.*authoritative/s);

  const mixedAnswers = vectors.negative.find((vector) =>
    vector.id === '113-mixed-public-private-dns-blocked');
  assert.deepEqual(mixedAnswers.dns['mixed-dns.example.net'].fixture_address_classes, [
    'globally_routable_fixture_only',
    'private',
  ]);

  const rebinding = vectors.negative.find((vector) =>
    vector.id === '114-connected-peer-rebinding-blocked');
  assert.deepEqual(rebinding.dns['rebind.example.net'].fixture_address_classes, [
    'globally_routable_fixture_only',
  ]);
  assert.equal(
    rebinding.responses['GET https://rebind.example.net/.well-known/oauth-authorization-server']
      .connected_peer_address,
    '127.0.0.1',
  );
});

test('OAuth setup fixtures contain only passive HTTPS GET requests', () => {
  for (const vector of [...vectors.positive, ...vectors.negative]) {
    assert.match(vector.agent_url, /^https:\/\//, `${vector.id} agent URL`);
    for (const request of Object.keys(vector.responses)) {
      assert.match(request, /^GET https:\/\//, `${vector.id} fixture request ${request}`);
    }
  }
});

test('every advertised token endpoint in a positive vector has a passive GET fixture', () => {
  for (const vector of vectors.positive) {
    for (const response of Object.values(vector.responses)) {
      const tokenEndpoint = response.json?.token_endpoint;
      if (!tokenEndpoint) continue;
      assert.ok(
        Object.hasOwn(vector.responses, `GET ${tokenEndpoint}`),
        `${vector.id} must probe advertised token endpoint ${tokenEndpoint}`,
      );
    }
  }
});
