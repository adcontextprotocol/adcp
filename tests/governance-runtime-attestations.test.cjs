const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const coreFixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/attestations/vectors.json'),
  'utf8',
));
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/governance-runtime-attestations/vectors.json'),
  'utf8',
));

let canonicalize;

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function coreVector(name) {
  const vector = coreFixture.vectors.find(candidate => candidate.name === name);
  assert.ok(vector, `missing core attestation vector ${name}`);
  return vector;
}

function buildEvaluation({ presentation, source, outcome, checkId }) {
  const evaluation = {
    reference_digest: sha256(canonicalize(presentation)),
    outcome,
    evaluated_at: fixture.evaluation_time,
    evaluated_by: 'https://governance.example/adcp',
    action_binding: {
      action_type: 'https://adcontextprotocol.org/actions/governance-check',
      action_id: checkId,
    },
  };

  if (source.resolver_result?.credential_bytes) {
    evaluation.credential_digest = sha256(source.resolver_result.credential_bytes);
    evaluation.proof_format = source.resolver_result.proof_format;
  }
  if (outcome === 'verified') {
    evaluation.confidence = 0.98;
    evaluation.valid_until = '2026-08-04T13:00:00Z';
  } else {
    evaluation.reason_codes = [`signal_attestation:${outcome}`];
  }
  return evaluation;
}

function bindingDigest(evaluations, findings) {
  const attestationBoundFindings = findings.filter(finding => finding.attestation_reference_digest);
  return sha256(canonicalize({ evaluations, findings: attestationBoundFindings }));
}

function typedSubjectMatches(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function runtimePolicyApplies(request) {
  return request.tool === 'activate_signal'
    && (request.payload?.action ?? 'activate') === 'activate';
}

function canReuse(previous, current) {
  return previous.reference_digest === current.reference_digest
    && previous.plan_hash === current.plan_hash
    && previous.check_id === current.check_id;
}

function semanticResponseIsBound(response) {
  return response.runtime_attestation_evaluations.every(evaluation => (
    evaluation.action_binding.action_type === 'https://adcontextprotocol.org/actions/governance-check'
    && evaluation.action_binding.action_id === response.check_id
  )) && response.runtime_attestation_binding_digest === bindingDigest(
    response.runtime_attestation_evaluations,
    response.findings || [],
  );
}

describe('governance runtime attestation vectors', () => {
  let validateRequest;
  let validateResponse;
  let validateCapabilities;
  let validateAuditLogs;

  before(async () => {
    canonicalize = (await import('canonicalize')).default;
    [validateRequest, validateResponse, validateCapabilities, validateAuditLogs] = await Promise.all([
      compile('/schemas/governance/check-governance-request.json'),
      compile('/schemas/governance/check-governance-response.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
      compile('/schemas/governance/get-plan-audit-logs-response.json'),
    ]);
  });

  it('publishes a schema-valid core allowlist plus governance action policy', () => {
    assert.equal(validateCapabilities(fixture.capability_response), true, JSON.stringify(validateCapabilities.errors));

    const globalClaims = new Set(fixture.capability_response.adcp.attestations.accepted_claim_types);
    for (const claimType of fixture.capability_response.governance.runtime_attestations.signal_activation.claim_types) {
      assert.equal(globalClaims.has(claimType), true, `${claimType} missing from shared allowlist`);
    }

    const missingSharedPolicy = clone(fixture.capability_response);
    delete missingSharedPolicy.adcp.attestations;
    assert.equal(validateCapabilities(missingSharedPolicy), false, 'runtime policy requires shared attestation capabilities');

    const nonSubsetPolicy = clone(fixture.capability_response);
    nonSubsetPolicy.governance.runtime_attestations.signal_activation.claim_types.push(
      'https://claims.example/audience/not-globally-accepted',
    );
    assert.equal(validateCapabilities(nonSubsetPolicy), true, JSON.stringify(validateCapabilities.errors));
    const nonSubsetGlobalClaims = new Set(nonSubsetPolicy.adcp.attestations.accepted_claim_types);
    assert.equal(
      nonSubsetPolicy.governance.runtime_attestations.signal_activation.claim_types.every(
        claimType => nonSubsetGlobalClaims.has(claimType),
      ),
      false,
      'the semantic subset check rejects action claims outside the shared allowlist',
    );
  });

  it('only permits runtime attestations on signal-activation checks', () => {
    const presentation = clone(coreVector('resolved-credential-verified').presentation);
    const valid = { ...clone(fixture.base_request), runtime_attestations: [presentation] };
    assert.equal(validateRequest(valid), true, JSON.stringify(validateRequest.errors));

    assert.equal(validateRequest({ ...clone(valid), purchase_type: 'media_buy' }), false);
    assert.equal(validateRequest({ ...clone(valid), tool: 'create_media_buy' }), false);
    assert.equal(validateRequest({ ...clone(valid), tool: undefined }), false);
    assert.equal(validateRequest({ ...clone(valid), payload: { ...valid.payload, action: 'activate' } }), true);
    assert.equal(validateRequest({ ...clone(valid), payload: { ...valid.payload, action: 'deactivate' } }), false);
  });

  it('does not apply required activation evidence to signal deactivation', () => {
    const request = clone(fixture.deactivation_request);
    assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
    assert.equal(runtimePolicyApplies(request), false);
    assert.equal(
      validateRequest({
        ...request,
        runtime_attestations: [clone(coreVector('resolved-credential-verified').presentation)],
      }),
      false,
      'deactivation cannot carry activation-time evidence',
    );

    const evidenceRequired = fixture.capability_response
      .governance.runtime_attestations.signal_activation.requirement === 'required';
    const governanceVerdict = evidenceRequired && runtimePolicyApplies(request) ? 'denied' : 'approved';
    assert.equal(governanceVerdict, 'approved', 'missing activation evidence must not block deactivation');
  });

  it('does not let the presenter supply an authoritative decision or confidence', () => {
    const presentation = clone(coreVector('resolved-credential-verified').presentation);
    presentation.decision = 'verified';
    presentation.confidence = 1;
    assert.equal(validateRequest({ ...clone(fixture.base_request), runtime_attestations: [presentation] }), false);
  });

  for (const vector of fixture.cases) {
    it(`${vector.name}: emits a bound response and audit readback`, () => {
      const source = coreVector(vector.presentation_vector);
      const presentation = clone(source.presentation);
      if (vector.subject_override) {
        presentation.subject = clone(vector.subject_override);
      }

      const request = { ...clone(fixture.base_request), runtime_attestations: [presentation] };
      assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));

      assert.equal(source.expected.network_requests, vector.expected_network_requests);
      const knownSubject = fixture.known_agent_state.signal_subjects_by_activation_id[
        request.payload.signal_agent_segment_id
      ];
      assert.ok(knownSubject, 'governance agent must resolve the activation handle to known signal state');
      const presentationSubjectMatches = typedSubjectMatches(presentation.subject, knownSubject);
      const credentialSubjectMatches = source.resolver_result?.credential?.subject
        ? typedSubjectMatches(source.resolver_result.credential.subject, knownSubject)
        : true;
      const actionSubjectMatches = presentationSubjectMatches && credentialSubjectMatches;
      const outcome = actionSubjectMatches ? vector.expected_outcome : 'subject_mismatch';
      assert.equal(outcome, vector.expected_outcome);

      const checkId = `check_${vector.name}`;
      const evaluation = buildEvaluation({ presentation, source, outcome, checkId });
      const findings = outcome === 'verified' ? [] : [{
        category_id: 'signal_quality',
        severity: 'critical',
        explanation: `Runtime signal attestation outcome: ${outcome}`,
        confidence: 1,
        attestation_reference_digest: evaluation.reference_digest,
      }];
      const response = {
        check_id: checkId,
        check_type: 'intent',
        verdict: vector.expected_verdict,
        plan_id: request.plan_id,
        explanation: outcome === 'verified' ? 'Required runtime evidence verified.' : 'Required runtime evidence did not verify.',
        runtime_attestation_evaluations: [evaluation],
        runtime_attestation_binding_digest: bindingDigest([evaluation], findings),
        ...(findings.length
          ? { findings }
          : {
              governance_context: 'header.payload.signature',
              expires_at: '2026-08-04T12:15:00Z',
            }),
      };

      assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
      assert.equal(semanticResponseIsBound(response), true);

      const audit = {
        status: 'completed',
        plans: [{
          plan_id: request.plan_id,
          plan_version: 1,
          status: 'active',
          budget: {},
          summary: {},
          governed_actions: [],
          entries: [{
            id: `entry_${vector.name}`,
            type: 'check',
            timestamp: fixture.evaluation_time,
            plan_id: request.plan_id,
            caller: request.caller,
            tool: request.tool,
            verdict: response.verdict,
            findings,
            runtime_attestations: [{ reference: presentation, evaluation }],
            runtime_attestation_binding_digest: response.runtime_attestation_binding_digest,
            governance_context: response.governance_context,
            purchase_type: request.purchase_type,
          }],
        }],
      };
      assert.equal(validateAuditLogs(audit), true, JSON.stringify(validateAuditLogs.errors));
    });
  }

  it('pins the governance binding digest bit-for-bit', () => {
    const {
      reference,
      evaluation,
      findings,
      expected_jcs: expectedJcs,
      expected_binding_digest: expectedDigest,
    } = fixture.binding_vector;
    const actualJcs = canonicalize({ evaluations: [evaluation], findings });
    assert.equal(actualJcs, expectedJcs);
    assert.equal(sha256(actualJcs), expectedDigest);
    assert.equal(sha256(canonicalize(reference)), evaluation.reference_digest);

    const audit = {
      status: 'completed',
      plans: [{
        plan_id: fixture.base_request.plan_id,
        plan_version: 1,
        status: 'active',
        budget: {},
        summary: {},
        governed_actions: [],
        entries: [{
          id: 'entry_binding_round_trip',
          type: 'check',
          timestamp: fixture.evaluation_time,
          findings,
          runtime_attestations: [{ reference, evaluation }],
          runtime_attestation_binding_digest: expectedDigest,
        }],
      }],
    };
    assert.equal(validateAuditLogs(audit), true, JSON.stringify(validateAuditLogs.errors));
    const retainedEntry = audit.plans[0].entries[0];
    for (const pair of retainedEntry.runtime_attestations) {
      assert.equal(sha256(canonicalize(pair.reference)), pair.evaluation.reference_digest);
    }
    assert.equal(
      bindingDigest(
        retainedEntry.runtime_attestations.map(pair => pair.evaluation),
        retainedEntry.findings,
      ),
      retainedEntry.runtime_attestation_binding_digest,
    );
  });

  it('rejects schema-valid evaluations transplanted to another check', () => {
    const binding = clone(fixture.binding_vector);
    const response = {
      check_id: 'check_signal_002',
      verdict: 'approved',
      plan_id: fixture.base_request.plan_id,
      explanation: 'Transplanted evaluation must not authorize this action.',
      expires_at: '2026-08-04T12:15:00Z',
      runtime_attestation_evaluations: [binding.evaluation],
      runtime_attestation_binding_digest: binding.expected_binding_digest,
    };
    assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
    assert.equal(semanticResponseIsBound(response), false, 'cross-field action equality is a verifier obligation');
  });

  it('requires reevaluation when the plan or governed action changes', () => {
    for (const vector of fixture.cache_reuse_vectors) {
      assert.equal(canReuse(vector.previous, vector.current), vector.expected_reuse, vector.name);
    }
  });

  it('required policy rejects an omitted attestation without making the request structurally invalid', () => {
    assert.equal(validateRequest(fixture.base_request), true, JSON.stringify(validateRequest.errors));
    assert.equal(
      fixture.capability_response.governance.runtime_attestations.signal_activation.requirement,
      'required',
    );
    const governanceVerdict = runtimePolicyApplies(fixture.base_request)
      && !fixture.base_request.runtime_attestations ? 'denied' : 'approved';
    assert.equal(governanceVerdict, 'denied');
  });
});
