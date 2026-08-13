#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const STORYBOARD_PATH = path.join(
  ROOT,
  'static/compliance/source/universal/trusted-match-publisher-authentication.yaml',
);
const KIT_PATH = path.join(
  ROOT,
  'static/compliance/source/test-kits/trusted-match-router-runner.yaml',
);

function loadYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function allSteps(storyboard) {
  return (storyboard.phases || []).flatMap((phase) => phase.steps || []);
}

test('Trusted Match publisher-auth runner contract pins guarded transport ownership', () => {
  const storyboard = loadYaml(STORYBOARD_PATH);
  const kit = loadYaml(KIT_PATH);
  const contract = kit.runner_contract;

  assert.deepEqual(storyboard.requires_capability, {
    path: 'experimental_features',
    contains: 'trusted_match.core',
  });
  assert.deepEqual(storyboard.requires, ['trusted_match_publisher_auth_runner']);
  assert.equal(contract.requirement, 'trusted_match_publisher_auth_runner');
  assert.deepEqual(contract.selection_order, ['requires_capability', 'requires']);
  assert.equal(contract.adapter_method, 'preparePublisherAuthProbe');
  assert.deepEqual(contract.adapter_arguments, ['operation', 'credentialState']);
  assert.deepEqual(contract.adapter_result, {
    credential_headers: 'optional_record',
    tls: {
      client_certificate_pem: 'optional_string',
      private_key_pem: 'optional_string',
      private_key_passphrase: 'optional_string',
      ca_certificate_pem: 'optional_string',
    },
  });
  assert.deepEqual(contract.required_endpoints, ['contextEndpoint', 'identityEndpoint']);
  assert.deepEqual(contract.credential_states, ['absent', 'invalid']);
  assert.equal(contract.network_request_owner, 'runner');
  assert.equal(contract.redirects, 'forbidden');
  assert.equal(kit.security.endpoint_validation, 'ssrf_safe_https');
  assert.equal(kit.security.http_client_construction, 'runner');
  assert.deepEqual(kit.security.forbidden_adapter_outputs, [
    'url_or_endpoint',
    'dispatcher_or_fetch_implementation',
    'method_or_body',
    'response',
    'proxy',
    'sni_override',
    'tls_verification_override',
  ]);
  assert.deepEqual(kit.security.forbidden_credential_headers, [
    'host',
    'content_framing',
    'hop_by_hop',
    'forwarding',
    'routing_override',
    'proxy',
  ]);
  assert.equal(kit.security.redirect_handling, 'runner_rejects');
  assert.equal(kit.security.timeout_enforcement, 'runner');
  assert.equal(kit.security.response_size_enforcement, 'runner');
  assert.equal(kit.security.response_redaction, 'required');
});

test('Trusted Match publisher-auth tasks map both operations and credential states', () => {
  const storyboard = loadYaml(STORYBOARD_PATH);
  const kit = loadYaml(KIT_PATH);
  const steps = allSteps(storyboard);
  const mapping = kit.runner_contract.task_mapping;

  const expectedMapping = {
    trusted_match_missing_auth_context_probe: {
      endpoint: 'contextEndpoint',
      operation: 'context',
      credential_state: 'absent',
    },
    trusted_match_invalid_auth_context_probe: {
      endpoint: 'contextEndpoint',
      operation: 'context',
      credential_state: 'invalid',
    },
    trusted_match_missing_auth_identity_probe: {
      endpoint: 'identityEndpoint',
      operation: 'identity',
      credential_state: 'absent',
    },
    trusted_match_invalid_auth_identity_probe: {
      endpoint: 'identityEndpoint',
      operation: 'identity',
      credential_state: 'invalid',
    },
  };

  assert.deepEqual(mapping, expectedMapping);
  assert.deepEqual(steps.map((step) => step.task), Object.keys(expectedMapping));

  for (const step of steps) {
    const contract = mapping[step.task];
    assert.ok(contract, `missing task mapping for ${step.task}`);
    assert.equal(
      step.schema_ref,
      `trusted-match/${contract.operation}-match-request.json`,
      `${step.task} must use the matching request schema`,
    );
    assert.ok(
      step.validations.some(({ check, value }) => check === 'http_status' && value === 401),
      `${step.task} must require HTTP 401`,
    );
    assert.ok(
      step.validations.some(
        ({ check, value }) => check === 'on_401_require_header' && value === 'www-authenticate',
      ),
      `${step.task} must require WWW-Authenticate`,
    );
  }
});
