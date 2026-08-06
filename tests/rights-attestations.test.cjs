const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { before, describe, it } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const {
  assessBrandAgentAuthorization,
  canonicalizeFixtureUrl,
} = require('./helpers/reference-brand-response-authorizer.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/rights-attestations/vectors.json'),
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

function constraintDigest(constraint) {
  const projection = clone(constraint);
  delete projection.content_digest;
  delete projection.attestation_refs;
  delete projection.verification_url;
  return sha256(canonicalize(projection));
}

function issuerKey(value) {
  return canonicalize(value);
}

function finiteTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluationStoreKey(evaluator, referenceDigest) {
  return `${canonicalizeFixtureUrl(evaluator)}|${referenceDigest}`;
}

function localEvaluationStore(readback) {
  return new Map([[
    evaluationStoreKey(readback.evaluation.evaluated_by, readback.evaluation.reference_digest),
    clone(readback),
  ]]);
}

function readbackMatchesGrant(readback, constraints, evaluationTime, evaluator, evaluationStore) {
  const constraint = constraints.find(candidate => (
    candidate.rights_id === readback.rights_id
    && candidate.content_digest === readback.content_digest
    && candidate.attestation_refs?.some(reference => canonicalize(reference) === canonicalize(readback.reference))
  ));
  const { action_binding: actionBinding } = readback.evaluation;
  const validUntil = finiteTime(readback.evaluation.valid_until);
  const locallyStored = evaluationStore.get(evaluationStoreKey(evaluator, readback.evaluation.reference_digest));
  return Boolean(
    constraint
    && readback.evaluation.outcome === 'verified'
    && canonicalizeFixtureUrl(readback.evaluation.evaluated_by) === canonicalizeFixtureUrl(evaluator)
    && locallyStored
    && canonicalize(locallyStored) === canonicalize(readback)
    && readback.reference.subject.id === readback.rights_id
    && readback.reference.subject.content_digest === readback.content_digest
    && actionBinding.action_id === readback.rights_id
    && actionBinding.action_digest === readback.content_digest
    && readback.evaluation.reference_digest === sha256(canonicalize(readback.reference))
    && validUntil !== null
    && finiteTime(evaluationTime) < validUntil
  );
}

function applyMutation(name) {
  const constraint = clone(fixture.base_constraint);
  const capabilities = clone(fixture.capabilities);
  const result = clone(fixture.resolver_result);
  const holderAuthorization = clone(fixture.holder_authorization);
  const reference = constraint.attestation_refs[0];
  const credential = JSON.parse(result.credential_bytes);
  const revocation = JSON.parse(result.revocation_bytes);
  let refreshGrant = false;

  switch (name) {
    case 'none':
      break;
    case 'verification_url_only':
      constraint.verification_url = 'http://169.254.169.254/latest/meta-data';
      delete constraint.attestation_refs;
      delete constraint.content_digest;
      break;
    case 'private_verification_url':
      constraint.verification_url = 'http://169.254.169.254/latest/meta-data';
      break;
    case 'missing_holder':
      delete constraint.rights_holder;
      break;
    case 'off_policy_holder':
      constraint.rights_holder = { domain: 'attacker.example', brand_id: 'forged' };
      reference.issuer.brand = clone(constraint.rights_holder);
      break;
    case 'private_ip_holder':
      constraint.rights_holder = { domain: '169.254.169.254', brand_id: 'metadata' };
      reference.issuer.brand = clone(constraint.rights_holder);
      break;
    case 'off_list_resolver':
      reference.locator.resolver_id = 'attacker';
      break;
    case 'off_list_verifier':
      reference.verify_agent = { agent_url: 'https://verifier.attacker.example/adcp' };
      break;
    case 'issuer_claim_scope_rejection':
      capabilities.accepted_issuers[0].claim_types = ['https://claims.example/other'];
      break;
    case 'issuer_proof_scope_rejection':
      capabilities.accepted_issuers[0].proof_formats = ['https://formats.example/other'];
      break;
    case 'presentation_rights_id_mismatch':
      reference.subject.id = 'rgt_other';
      break;
    case 'presentation_namespace_mismatch':
      reference.subject.namespace = 'https://rights.attacker.example/adcp';
      break;
    case 'credential_digest_mismatch':
      credential.constraint_digest = `sha256:${'a'.repeat(64)}`;
      break;
    case 'credential_claim_mismatch':
      credential.claim_type = 'https://claims.example/unrelated';
      break;
    case 'restriction_omitted':
      constraint.restrictions.pop();
      break;
    case 'disclosure_mutated':
      constraint.disclosure.text = 'A weaker disclosure';
      break;
    case 'unauthorized_rights_agent':
      holderAuthorization.brand_json.brands[0].agents[0].type = 'brand';
      break;
    case 'wrong_rights_agent_id':
      holderAuthorization.envelope.agent_id = 'other_rights';
      break;
    case 'sibling_rights_agent':
      holderAuthorization.brand_json.brands[0].agents = [];
      break;
    case 'ambiguous_rights_agent':
      holderAuthorization.brand_json.brands[0].agents.push(clone(holderAuthorization.brand_json.brands[0].agents[0]));
      break;
    case 'wrong_key_purpose':
      holderAuthorization.jwks_by_uri['https://rights.novabrands.example/.well-known/jwks.json'].keys[0].adcp_use = 'response-signing';
      result.credential_verified_jwk.adcp_use = 'response-signing';
      break;
    case 'key_material_mismatch':
      result.credential_verified_jwk.x = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      break;
    case 'wrong_status_key':
      result.revocation_verified_jwk.kid = 'attacker-status-key';
      break;
    case 'status_key_material_mismatch':
      result.revocation_verified_jwk.x = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      break;
    case 'status_wrong_key_purpose':
      result.revocation_verified_jwk.adcp_use = 'response-signing';
      holderAuthorization.jwks_by_uri['https://rights.novabrands.example/.well-known/jwks.json'].keys[1].adcp_use = 'response-signing';
      break;
    case 'expired_credential':
      credential.valid_until = '2026-08-05T23:59:59Z';
      break;
    case 'future_credential':
      credential.valid_from = '2026-08-07T00:00:00Z';
      break;
    case 'malformed_credential_time':
      credential.valid_until = 'not-a-time';
      break;
    case 'revoked_credential':
      revocation.grant_status = 'revoked';
      break;
    case 'paused_grant':
      constraint.grant_status = 'paused';
      revocation.grant_status = 'paused';
      refreshGrant = true;
      break;
    case 'stale_status':
      revocation.valid_until = '2026-08-06T11:59:59Z';
      break;
    case 'missing_status_deadline':
      delete revocation.valid_until;
      break;
    case 'swapped_status':
      revocation.rights_id = 'rgt_other';
      break;
    case 'resolver_failure':
      result.status = 'failed';
      break;
    default:
      throw new Error(`unknown mutation ${name}`);
  }

  if (refreshGrant) {
    const digest = constraintDigest(constraint);
    constraint.content_digest = digest;
    reference.subject.content_digest = digest;
    credential.constraint_digest = digest;
    credential.subject.content_digest = digest;
    revocation.constraint_digest = digest;
  }

  result.credential_bytes = canonicalize(credential);
  result.revocation_bytes = canonicalize(revocation);
  return { constraint, capabilities, result, holderAuthorization };
}

function evaluateRights(input) {
  const { constraint, capabilities, result, holderAuthorization } = input;
  const [reference] = constraint.attestation_refs || [];
  let networkRequests = 0;
  if (!reference || !constraint.rights_holder) return { outcome: 'unverifiable', networkRequests };

  if (reference.claim_type !== fixture.claim_type) return { outcome: 'unsupported', networkRequests };
  if (issuerKey(reference.issuer.brand) !== issuerKey(constraint.rights_holder)) {
    return { outcome: 'untrusted_issuer', networkRequests };
  }
  const acceptedIssuer = capabilities.accepted_issuers.find(candidate => (
    issuerKey(candidate.issuer) === issuerKey(reference.issuer)
  ));
  if (!acceptedIssuer) return { outcome: 'untrusted_issuer', networkRequests };
  if (!capabilities.accepted_claim_types.includes(reference.claim_type)
    || !acceptedIssuer.claim_types?.includes(reference.claim_type)) {
    return { outcome: 'unsupported', networkRequests };
  }
  if (reference.locator?.type !== 'issuer_credential_id') return { outcome: 'unsupported', networkRequests };
  if (!capabilities.supported_delivery_methods.includes('issuer_credential_id')) {
    return { outcome: 'unsupported', networkRequests };
  }
  if (!acceptedIssuer.resolvers?.some(candidate => candidate.resolver_id === reference.locator.resolver_id)) {
    return { outcome: 'untrusted_resolver', networkRequests };
  }
  if (reference.verify_agent && !capabilities.accepted_verifiers?.some(candidate => (
    canonicalizeFixtureUrl(candidate.agent_url) === canonicalizeFixtureUrl(reference.verify_agent.agent_url)
  ))) {
    return { outcome: 'untrusted_resolver', networkRequests };
  }

  const subject = reference.subject;
  if (
    subject.type !== 'resource'
    || subject.resource_type !== fixture.subject_resource_type
    || subject.id !== constraint.rights_id
    || canonicalizeFixtureUrl(subject.namespace) !== canonicalizeFixtureUrl(constraint.rights_agent.url)
    || subject.content_digest !== constraint.content_digest
    || constraintDigest(constraint) !== constraint.content_digest
  ) {
    return { outcome: 'subject_mismatch', networkRequests };
  }

  networkRequests += 1;
  if (!result || result.status !== 'ok') return { outcome: 'resolution_failed', networkRequests };
  if (!capabilities.accepted_proof_formats.includes(result.proof_format)
    || !acceptedIssuer.proof_formats?.includes(result.proof_format)) {
    return { outcome: 'unsupported', networkRequests };
  }

  let credential;
  let revocation;
  try {
    credential = JSON.parse(result.credential_bytes);
    revocation = JSON.parse(result.revocation_bytes);
  } catch {
    return { outcome: 'invalid', networkRequests };
  }
  const credentialDigest = sha256(result.credential_bytes);
  const common = { networkRequests, credentialDigest, proofFormat: result.proof_format };
  if (!result.credential_signature_valid || !result.revocation_signature_valid) {
    return { outcome: 'invalid', ...common };
  }
  if (
    issuerKey(credential.issuer) !== issuerKey(reference.issuer)
    || credential.claim_type !== reference.claim_type
    || canonicalize(credential.subject) !== canonicalize(reference.subject)
    || credential.constraint_digest !== constraint.content_digest
    || canonicalize(credential.rights_agent) !== canonicalize(constraint.rights_agent)
    || canonicalize(credential.rights_holder) !== canonicalize(constraint.rights_holder)
  ) {
    return { outcome: 'invalid', ...common };
  }

  networkRequests += 2;
  function assessAuthority(verifiedJwk) {
    const authorization = clone(holderAuthorization);
    authorization.brand_ref = clone(constraint.rights_holder);
    authorization.envelope.kid = verifiedJwk.kid;
    authorization.verified_jwk = clone(verifiedJwk);
    return assessBrandAgentAuthorization(authorization, {
      agent_type: 'rights',
      key_purpose: 'attestation-signing',
    });
  }
  const credentialAuthority = assessAuthority(result.credential_verified_jwk);
  const statusAuthority = assessAuthority(result.revocation_verified_jwk);
  const authorizedCommon = { ...common, networkRequests };
  if (credentialAuthority.trust !== 'trusted' || statusAuthority.trust !== 'trusted') {
    return { outcome: 'invalid', ...authorizedCommon };
  }

  const now = finiteTime(fixture.evaluation_time);
  const credentialStart = finiteTime(credential.valid_from);
  const credentialEnd = finiteTime(credential.valid_until);
  const constraintStart = finiteTime(constraint.valid_from);
  const constraintEnd = finiteTime(constraint.valid_until);
  const checkedAt = finiteTime(revocation.checked_at);
  const statusEnd = finiteTime(revocation.valid_until);
  if ([now, credentialStart, credentialEnd, constraintStart, constraintEnd, checkedAt, statusEnd].includes(null)) {
    return { outcome: 'invalid', ...authorizedCommon };
  }
  if (
    issuerKey(revocation.issuer) !== issuerKey(reference.issuer)
    || revocation.credential_id !== credential.credential_id
    || revocation.rights_id !== constraint.rights_id
    || revocation.constraint_digest !== constraint.content_digest
    || checkedAt > now
  ) {
    return { outcome: 'invalid', ...authorizedCommon };
  }

  const freshness = {
    ...authorizedCommon,
    revocationCheckedAt: revocation.checked_at,
    evaluationValidUntil: new Date(Math.min(credentialEnd, constraintEnd, statusEnd)).toISOString(),
  };
  if (statusEnd <= now) return { outcome: 'unverifiable', ...freshness };
  if (revocation.grant_status === 'revoked' || revocation.grant_status === 'paused') {
    return { outcome: 'revoked', ...freshness };
  }
  if (revocation.grant_status !== 'active' || constraint.grant_status !== 'active') {
    return { outcome: 'unverifiable', ...freshness };
  }
  if (constraint.approval_status !== 'approved') return { outcome: 'invalid', ...freshness };
  if (credentialEnd <= now || constraintEnd <= now) return { outcome: 'expired', ...freshness };
  if (credentialStart > now || constraintStart > now) return { outcome: 'invalid', ...freshness };
  return { outcome: 'verified', ...freshness };
}

describe('rights attestation domain vectors', () => {
  let validateAcquire;
  let validateBrandJson;
  let validateBuildRequest;
  let validateCapabilities;
  let validateCapabilityResponse;
  let validateConstraint;
  let validateEvaluation;
  let validateListRequest;
  let validateReference;
  let validateUpdate;

  before(async () => {
    canonicalize = (await import('canonicalize')).default;
    [
      validateAcquire,
      validateBrandJson,
      validateBuildRequest,
      validateCapabilities,
      validateCapabilityResponse,
      validateConstraint,
      validateEvaluation,
      validateListRequest,
      validateReference,
      validateUpdate,
    ] = await Promise.all([
      compile('/schemas/brand/acquire-rights-response.json'),
      compile('/schemas/brand.json'),
      compile('/schemas/media-buy/build-creative-request.json'),
      compile('/schemas/core/attestation-capabilities.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
      compile('/schemas/core/rights-constraint.json'),
      compile('/schemas/core/rights-attestation-evaluation.json'),
      compile('/schemas/creative/list-creatives-request.json'),
      compile('/schemas/core/attestation-reference.json'),
      compile('/schemas/brand/update-rights-response.json'),
    ]);
  });

  it('publishes schema-valid capabilities, holder authority, and a digest-pinned base constraint', () => {
    assert.equal(validateCapabilities(fixture.capabilities), true, JSON.stringify(validateCapabilities.errors));
    assert.equal(validateBrandJson(fixture.holder_authorization.brand_json), true, JSON.stringify(validateBrandJson.errors));
    assert.equal(validateConstraint(fixture.base_constraint), true, JSON.stringify(validateConstraint.errors));
    assert.equal(constraintDigest(fixture.base_constraint), fixture.base_constraint.content_digest);
  });

  it('requires the shared attestation capability and rights claim when rights evaluation is advertised', () => {
    const capabilityResponse = {
      status: 'completed',
      adcp: { major_versions: [3], idempotency: { supported: false }, attestations: fixture.capabilities },
      supported_protocols: ['media_buy'],
      media_buy: { rights_attestations: { requirement: 'required' } },
    };
    assert.equal(validateCapabilityResponse(capabilityResponse), true, JSON.stringify(validateCapabilityResponse.errors));
    const missingAttestations = clone(capabilityResponse);
    delete missingAttestations.adcp.attestations;
    assert.equal(validateCapabilityResponse(missingAttestations), false);
    const missingRightsClaim = clone(capabilityResponse);
    missingRightsClaim.adcp.attestations.accepted_claim_types = ['https://claims.example/other'];
    assert.equal(validateCapabilityResponse(missingRightsClaim), false);
  });

  it('requires attested constraints on successful 3.2 rights issuance and update responses', () => {
    const terms = { pricing_option_id: 'monthly', amount: 100, currency: 'USD', uses: ['voice'] };
    const acquire = {
      status: 'completed',
      rights_id: fixture.base_constraint.rights_id,
      rights_status: 'acquired',
      brand_id: 'nova_talent',
      terms,
      generation_credentials: [],
      rights_constraint: fixture.base_constraint,
    };
    assert.equal(validateAcquire(acquire), true, JSON.stringify(validateAcquire.errors));
    const unattestedAcquire = clone(acquire);
    delete unattestedAcquire.rights_constraint.attestation_refs;
    assert.equal(validateAcquire(unattestedAcquire), false);

    const update = {
      status: 'completed',
      rights_id: fixture.base_constraint.rights_id,
      terms,
      generation_credentials: [],
      rights_constraint: fixture.base_constraint,
    };
    assert.equal(validateUpdate(update), true, JSON.stringify(validateUpdate.errors));
    const unpinnedUpdate = clone(update);
    delete unpinnedUpdate.rights_constraint.content_digest;
    assert.equal(validateUpdate(unpinnedUpdate), false);
  });

  it('makes rights evaluations requestable with automatic companion readback fields', () => {
    assert.equal(validateListRequest({ fields: ['rights_attestation_evaluations'] }), true, JSON.stringify(validateListRequest.errors));
    const creativeSchema = readSchema('/schemas/creative/list-creatives-response.json').properties.creatives.items;
    const rule = creativeSchema['x-adcp-validation'].rights_readback;
    assert.deepEqual(rule.automatic_companion_fields.rights_attestation_evaluations, ['creative_id', 'rights']);
    assert.equal(creativeSchema.properties.rights.maxItems, undefined);
    assert.equal(creativeSchema.properties.rights_attestation_evaluations.maxItems, undefined);
  });

  it('carries rights through the typed creative manifest handoff, not open secret fields', () => {
    const request = {
      idempotency_key: '7f4024d8-b429-4ad8-92dd-128cd89f15fc',
      brand: { domain: 'bistro-oranje.example' },
      target_capability_id: 'vertical_video_builder',
      message: '15-second vertical video featuring licensed talent',
      creative_manifest: {
        format_kind: 'video_hosted',
        assets: {
          creative_brief: {
            asset_type: 'brief',
            name: 'Licensed talent endorsement',
            objective: 'awareness',
          },
        },
        rights: [fixture.base_constraint],
      },
    };
    assert.equal(validateBuildRequest(request), true, JSON.stringify(validateBuildRequest.errors));
    assert.equal(Object.hasOwn(request, 'generation_credentials'), false);
    assert.equal(Object.hasOwn(request, 'rights'), false);
  });

  for (const vector of fixture.cases) {
    it(`${vector.name}: produces the safe outcome`, () => {
      const input = applyMutation(vector.mutation);
      const expectedSchemaValid = vector.expected.schema_valid ?? true;
      assert.equal(validateConstraint(input.constraint), expectedSchemaValid, JSON.stringify(validateConstraint.errors));
      if (input.constraint.attestation_refs) {
        assert.equal(validateReference(input.constraint.attestation_refs[0]), true, JSON.stringify(validateReference.errors));
      }

      const actual = evaluateRights(input);
      assert.equal(actual.outcome, vector.expected.outcome);
      assert.equal(actual.networkRequests, vector.expected.network_requests);

      if (actual.credentialDigest) {
        const reference = input.constraint.attestation_refs[0];
        const readback = {
          rights_id: input.constraint.rights_id,
          content_digest: input.constraint.content_digest,
          reference,
          evaluation: {
            reference_digest: sha256(canonicalize(reference)),
            credential_digest: actual.credentialDigest,
            proof_format: actual.proofFormat,
            outcome: actual.outcome,
            evaluated_at: fixture.evaluation_time,
            evaluated_by: 'https://seller.example/adcp',
            ...(actual.revocationCheckedAt ? { revocation_checked_at: actual.revocationCheckedAt } : {}),
            ...(actual.evaluationValidUntil ? { valid_until: actual.evaluationValidUntil } : {}),
            action_binding: {
              action_type: fixture.action_type,
              action_id: input.constraint.rights_id,
              action_digest: input.constraint.content_digest,
            },
          },
        };
        assert.equal(validateEvaluation(readback), true, JSON.stringify(validateEvaluation.errors));
        if (actual.outcome === 'verified') {
          const store = localEvaluationStore(readback);
          assert.equal(readbackMatchesGrant(
            readback,
            [input.constraint],
            fixture.evaluation_time,
            'https://seller.example/adcp',
            store,
          ), true);
          const detached = clone(readback);
          detached.reference.locator.credential_id = 'cred_detached';
          assert.equal(readbackMatchesGrant(
            detached,
            [input.constraint],
            fixture.evaluation_time,
            'https://seller.example/adcp',
            store,
          ), false);
        }
      }
    });
  }

  it('rejects generic claims, stale evaluations, and non-local evaluator readback', () => {
    const input = applyMutation('none');
    const actual = evaluateRights(input);
    const reference = input.constraint.attestation_refs[0];
    const readback = {
      rights_id: input.constraint.rights_id,
      content_digest: input.constraint.content_digest,
      reference,
      evaluation: {
        reference_digest: sha256(canonicalize(reference)),
        credential_digest: actual.credentialDigest,
        proof_format: actual.proofFormat,
        outcome: actual.outcome,
        evaluated_at: fixture.evaluation_time,
        evaluated_by: 'https://seller.example/adcp',
        revocation_checked_at: actual.revocationCheckedAt,
        valid_until: actual.evaluationValidUntil,
        action_binding: {
          action_type: fixture.action_type,
          action_id: 'rgt_other',
          action_digest: input.constraint.content_digest,
        },
      },
    };
    assert.equal(validateEvaluation(readback), true, JSON.stringify(validateEvaluation.errors));
    let store = localEvaluationStore(readback);
    assert.equal(readbackMatchesGrant(
      readback,
      [input.constraint],
      fixture.evaluation_time,
      'https://seller.example/adcp',
      store,
    ), false);

    readback.evaluation.action_binding.action_id = readback.rights_id;
    readback.evaluation.valid_until = '2026-08-06T11:59:59Z';
    store = localEvaluationStore(readback);
    assert.equal(readbackMatchesGrant(
      readback,
      [input.constraint],
      fixture.evaluation_time,
      'https://seller.example/adcp',
      store,
    ), false);

    readback.evaluation.valid_until = actual.evaluationValidUntil;
    assert.equal(readbackMatchesGrant(
      readback,
      [input.constraint],
      fixture.evaluation_time,
      'https://seller.example/adcp',
      new Map(),
    ), false, 'a buyer-authored readback is absent from the seller local store');

    const foreignReadback = clone(readback);
    foreignReadback.evaluation.evaluated_by = 'https://other-seller.example/adcp';
    const foreignStore = localEvaluationStore(foreignReadback);
    assert.equal(readbackMatchesGrant(
      foreignReadback,
      [input.constraint],
      fixture.evaluation_time,
      'https://seller.example/adcp',
      foreignStore,
    ), false, 'another seller local result is not this seller provenance');

    const nonVerified = clone(readback);
    nonVerified.evaluation.outcome = 'invalid';
    store = localEvaluationStore(nonVerified);
    assert.equal(readbackMatchesGrant(
      nonVerified,
      [input.constraint],
      fixture.evaluation_time,
      'https://seller.example/adcp',
      store,
    ), false, 'only verified local results are reusable');

    const wrongClaim = clone(readback);
    wrongClaim.reference.claim_type = 'https://claims.example/audience';
    assert.equal(validateEvaluation(wrongClaim), false);
  });
});
