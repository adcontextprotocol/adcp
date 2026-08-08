const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/audience-evidence/vectors.json'),
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

function canonicalKey(value) {
  return canonicalize(value);
}

function evidenceCoreDigest(evidence) {
  const preimage = clone(evidence);
  delete preimage.content_digest;
  delete preimage.attestation_refs;
  return sha256(canonicalize(preimage));
}

function brandKey(brand) {
  return `${brand.domain}#${brand.brand_id || ''}`;
}

function durationMs(duration) {
  const multipliers = {
    seconds: 1000,
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
  };
  return multipliers[duration.unit] && multipliers[duration.unit] * duration.interval;
}

function validAttestationPairs(evidence, requirements, pairs) {
  const publishedReferences = new Set((evidence.attestation_refs || []).map(canonicalKey));
  const acceptedIssuers = new Set((requirements.accepted_attestation_issuers || []).map(canonicalKey));
  return (pairs || []).filter(({ reference, evaluation }) => {
    if (!publishedReferences.has(canonicalKey(reference))) return false;
    if (evaluation.reference_digest !== sha256(canonicalize(reference))) return false;
    if (evaluation.outcome !== 'verified') return false;
    if (reference.subject.id !== evidence.snapshot_id) return false;
    if (reference.subject.content_digest !== evidence.content_digest) return false;
    if (evaluation.action_binding?.action_id !== evidence.snapshot_id) return false;
    if (evaluation.action_binding?.action_digest !== evidence.content_digest) return false;
    if (requirements.accepted_attestation_claim_types && !requirements.accepted_attestation_claim_types.includes(reference.claim_type)) return false;
    if (acceptedIssuers.size && !acceptedIssuers.has(canonicalKey(reference.issuer))) return false;
    return true;
  });
}

function admissible(evidence, requirements, attestationPairs = []) {
  if (requirements.accepted_methodologies && !requirements.accepted_methodologies.includes(evidence.methodology)) return false;
  if (requirements.excluded_methodologies?.includes(evidence.methodology)) return false;
  if (requirements.accepted_evidence_types && !requirements.accepted_evidence_types.includes(evidence.evidence_type)) return false;
  if (requirements.accepted_providers && !requirements.accepted_providers.some(provider => brandKey(provider) === brandKey(evidence.provider))) return false;
  if (requirements.excluded_providers?.some(provider => brandKey(provider) === brandKey(evidence.provider))) return false;
  if (requirements.accepted_subject_types && !requirements.accepted_subject_types.includes(evidence.subject_type)) return false;
  if (requirements.accepted_resolution_methods && !requirements.accepted_resolution_methods.includes(evidence.resolution_method)) return false;
  if (requirements.minimum_confidence !== undefined && (evidence.confidence ?? -1) < requirements.minimum_confidence) return false;
  if (requirements.maximum_age) {
    const allowedAge = durationMs(requirements.maximum_age);
    if (!allowedAge || Date.parse(fixture.evaluation_time) - Date.parse(evidence.last_updated) > allowedAge) return false;
  }
  if (requirements.methodology_documentation_required && !evidence.methodology_url) return false;
  if (requirements.independent_attestation_required) {
    if (validAttestationPairs(evidence, requirements, attestationPairs).length === 0) return false;
  }
  if (requirements.accepted_attestation_claim_types && !requirements.independent_attestation_required) {
    if (!evidence.attestation_refs?.some(reference => requirements.accepted_attestation_claim_types.includes(reference.claim_type))) return false;
  }
  return true;
}

function validAgeRange(characteristic) {
  if (characteristic.dimension !== 'age' || !characteristic.range) return true;
  const { min, max } = characteristic.range;
  return min === undefined || max === undefined || min <= max;
}

function pinMatchesEvidence(pin, evidence) {
  return ['evidence_id', 'snapshot_id', 'version', 'content_digest'].every(field => pin[field] === evidence[field]);
}

function selectionMatchesPin(selection, pin) {
  return selection.decision_use === 'package_construction'
    && ['evidence_id', 'snapshot_id', 'version', 'content_digest'].every(field => selection[field] === pin[field]);
}

function evaluateCase(vector) {
  const evidence = vector.evidence_state === 'fixture' ? [fixture.evidence] : [];
  const attestationPairs = clone(fixture.package.audience_evidence_selections[0].attestation_evaluations);
  if (vector.attestation_outcome) attestationPairs[0].evaluation.outcome = vector.attestation_outcome;
  const matches = evidence.filter(item => admissible(item, vector.requirements, attestationPairs));
  if (vector.requirements.requirement_mode === 'preferred') {
    return { eligible: true, selected: matches.length > 0 };
  }
  if (evidence.length === 0) {
    return {
      eligible: vector.requirements.evidence_presence === 'when_available',
      selected: false,
    };
  }
  return { eligible: matches.length > 0, selected: matches.length > 0 };
}

describe('audience evidence vectors', () => {
  let validateEvidence;
  let validateRequirements;
  let validateFilters;
  let validateProduct;
  let validatePackage;
  let validatePackageRequest;
  let validatePin;
  let validateCapabilities;

  before(async () => {
    canonicalize = (await import('canonicalize')).default;
    [validateEvidence, validateRequirements, validateFilters, validateProduct, validatePackage, validatePackageRequest, validatePin, validateCapabilities] = await Promise.all([
      compile('/schemas/core/audience-evidence.json'),
      compile('/schemas/core/audience-evidence-requirements.json'),
      compile('/schemas/core/product-filters.json'),
      compile('/schemas/core/product.json'),
      compile('/schemas/core/package.json'),
      compile('/schemas/media-buy/package-request.json'),
      compile('/schemas/core/audience-evidence-pin.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
    ]);
  });

  it('publishes schema-valid evidence and recomputes the immutable content digest', () => {
    assert.equal(validateEvidence(fixture.evidence), true, JSON.stringify(validateEvidence.errors));
    assert.equal(evidenceCoreDigest(fixture.evidence), fixture.evidence.content_digest);

    const withDifferentReferences = clone(fixture.evidence);
    withDifferentReferences.attestation_refs = [withDifferentReferences.attestation_refs[1]];
    assert.equal(evidenceCoreDigest(withDifferentReferences), fixture.evidence.content_digest);
  });

  it('publishes the evidence on a schema-valid product without creating targeting semantics', () => {
    const product = clone(fixture.product);
    product.audience_evidence = [clone(fixture.evidence)];
    product.audience_evidence_selections = [clone(fixture.package.audience_evidence_selections[0])];
    assert.equal(validateProduct(product), true, JSON.stringify(validateProduct.errors));
    assert.equal(product.audience_evidence_selections[0].snapshot_id, product.audience_evidence[0].snapshot_id);
    assert.equal(product.demographic_targeting, undefined);
    assert.equal(product.signal_targeting_allowed, undefined);
    assert.equal(product.age_restriction, undefined);
  });

  it('enforces relationship units and keeps projected population-only', () => {
    const invalid = clone(fixture.evidence);
    invalid.unit = 'fraction';
    assert.equal(validateEvidence(invalid), false);

    const signalSchema = readSchema('/schemas/core/signal-definition.json');
    assert.equal(signalSchema.properties.methodology.enum.includes('projected'), false);
    assert.equal(readSchema('/schemas/enums/audience-evidence-methodology.json').enum.includes('projected'), true);
  });

  it('constrains age values and bounds and enforces ordered ranges', () => {
    for (const audience of [
      { dimension: 'age', value: -1 },
      { dimension: 'age', value: 25.5 },
      { dimension: 'age', value: [25, -1] },
      { dimension: 'age', range: { min: -1, max: 34 } },
      { dimension: 'age', range: { min: 25.5, max: 34 } },
    ]) {
      const invalid = clone(fixture.evidence);
      invalid.audience = audience;
      assert.equal(validateEvidence(invalid), false, JSON.stringify(audience));
    }

    const reversed = clone(fixture.evidence);
    reversed.audience.range = { min: 35, max: 18 };
    assert.equal(validateEvidence(reversed), true, JSON.stringify(validateEvidence.errors));
    assert.equal(validAgeRange(reversed.audience), false);
    assert.equal(validAgeRange(fixture.evidence.audience), true);
  });

  it('declares exact seller support for requirement and presence modes', () => {
    assert.equal(validateCapabilities(fixture.capability_response), true, JSON.stringify(validateCapabilities.errors));
    assert.deepEqual(
      fixture.capability_response.media_buy.audience_evidence.supported_presence_modes,
      ['required', 'when_available'],
    );
  });

  it('requires shared attestation capabilities when audience evaluation is advertised', () => {
    const invalid = clone(fixture.capability_response);
    delete invalid.adcp.attestations;
    assert.equal(validateCapabilities(invalid), false);
  });

  it('accepts a presence-only policy and rejects campaign-relative freshness', () => {
    assert.equal(validateRequirements({
      requirement_mode: 'required',
      evidence_presence: 'required',
    }), true, JSON.stringify(validateRequirements.errors));
    assert.equal(validateRequirements({
      requirement_mode: 'required',
      evidence_presence: 'required',
      maximum_age: { interval: 1, unit: 'campaign' },
    }), false);

    assert.equal(validateRequirements({
      requirement_mode: 'required',
      evidence_presence: 'required',
      independent_attestation_required: true,
    }), false);
  });

  it('gives excluded methodology and provider lists precedence over accepted lists', () => {
    assert.equal(admissible(fixture.evidence, {
      requirement_mode: 'required',
      evidence_presence: 'required',
      accepted_methodologies: ['projected'],
      excluded_methodologies: ['projected'],
    }), false);
    assert.equal(admissible(fixture.evidence, {
      requirement_mode: 'required',
      evidence_presence: 'required',
      accepted_providers: [fixture.evidence.provider],
      excluded_providers: [fixture.evidence.provider],
    }), false);
  });

  for (const vector of fixture.policy_cases) {
    it(`${vector.name}: applies filtering and ranking semantics`, () => {
      assert.equal(validateRequirements(vector.requirements), true, JSON.stringify(validateRequirements.errors));
      assert.equal(
        validateFilters({ audience_evidence_requirements: vector.requirements }),
        true,
        JSON.stringify(validateFilters.errors),
      );
      const actual = evaluateCase(vector);
      assert.equal(actual.eligible, vector.expected_eligible);
      assert.equal(actual.selected, vector.expected_selected);
    });
  }

  it('pins exact evidence and attestation evaluation in package readback', () => {
    assert.equal(validatePackage(fixture.package), true, JSON.stringify(validatePackage.errors));
    const selection = fixture.package.audience_evidence_selections[0];
    const pair = selection.attestation_evaluations[0];
    assert.equal(selection.snapshot_id, fixture.evidence.snapshot_id);
    assert.equal(selection.content_digest, fixture.evidence.content_digest);
    assert.equal(pair.reference.subject.id, selection.snapshot_id);
    assert.equal(pair.reference.subject.content_digest, selection.content_digest);
    assert.equal(pair.evaluation.reference_digest, sha256(canonicalize(pair.reference)));
    assert.equal(pair.evaluation.action_binding.action_id, selection.snapshot_id);
    assert.equal(pair.evaluation.action_binding.action_digest, selection.content_digest);
  });

  it('accepts package requirements and exact pins and requires matching package readback', () => {
    assert.equal(validatePackageRequest(fixture.package_request), true, JSON.stringify(validatePackageRequest.errors));
    const pin = fixture.package_request.audience_evidence_pins[0];
    assert.equal(validatePin(pin), true, JSON.stringify(validatePin.errors));
    assert.equal(pinMatchesEvidence(pin, fixture.evidence), true);
    assert.equal(
      fixture.package.audience_evidence_selections.some(selection => selectionMatchesPin(selection, pin)),
      true,
    );

    const withoutReadback = clone(fixture.package);
    delete withoutReadback.audience_evidence_selections;
    assert.equal(validatePackage(withoutReadback), true, JSON.stringify(validatePackage.errors));
    assert.equal(
      (withoutReadback.audience_evidence_selections || []).some(selection => selectionMatchesPin(selection, pin)),
      false,
    );
  });

  it('rejects catalog mutation or substitution against any exact package pin field', () => {
    const pin = fixture.package_request.audience_evidence_pins[0];
    for (const [field, replacement] of [
      ['evidence_id', 'other_evidence'],
      ['snapshot_id', 'other_snapshot'],
      ['version', '2026-q3'],
      ['content_digest', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ]) {
      const mutated = clone(fixture.evidence);
      mutated[field] = replacement;
      assert.equal(validateEvidence(mutated), true, `${field}: ${JSON.stringify(validateEvidence.errors)}`);
      assert.equal(pinMatchesEvidence(pin, mutated), false, field);
    }
  });

  it('detects mutable-catalog drift even when a snapshot id is improperly reused', () => {
    const mutated = clone(fixture.evidence);
    mutated.value = 2.1;
    assert.notEqual(evidenceCoreDigest(mutated), mutated.content_digest);
  });

  it('requires one verified reference/evaluation pair with matching claim, issuer, subject, and action digests', () => {
    const requirements = clone(fixture.policy_cases.find(item => item.name === 'required-independent-attestation').requirements);
    const pairs = clone(fixture.package.audience_evidence_selections[0].attestation_evaluations);
    assert.equal(admissible(fixture.evidence, requirements, pairs), true);

    for (const outcome of ['expired', 'revoked']) {
      const failed = clone(pairs);
      failed[0].evaluation.outcome = outcome;
      assert.equal(admissible(fixture.evidence, requirements, failed), false, outcome);
    }

    const mismatchedReference = clone(pairs);
    mismatchedReference[0].reference = clone(fixture.evidence.attestation_refs[1]);
    assert.equal(admissible(fixture.evidence, requirements, mismatchedReference), false);

    const mismatchedSubject = clone(pairs);
    mismatchedSubject[0].reference.subject.content_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    mismatchedSubject[0].evaluation.reference_digest = sha256(canonicalize(mismatchedSubject[0].reference));
    assert.equal(admissible(fixture.evidence, requirements, mismatchedSubject), false);

    const mismatchedAction = clone(pairs);
    mismatchedAction[0].evaluation.action_binding.action_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.equal(admissible(fixture.evidence, requirements, mismatchedAction), false);
  });
});
