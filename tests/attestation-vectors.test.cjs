const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
let canonicalize;

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/test-vectors/attestations/vectors.json'),
  'utf8',
));

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function issuerKey(issuer) {
  return canonicalize(issuer);
}

function evaluate(vector) {
  const { presentation, resolver_result: result } = vector;
  const capabilities = fixture.capabilities;
  let networkRequests = 0;

  const acceptedIssuer = capabilities.accepted_issuers.find(candidate => (
    issuerKey(candidate.issuer) === issuerKey(presentation.issuer)
  ));
  if (!acceptedIssuer) {
    return { outcome: 'untrusted_issuer', networkRequests };
  }

  if (!capabilities.accepted_claim_types.includes(presentation.claim_type)) {
    return { outcome: 'unsupported', networkRequests };
  }

  if (presentation.locator?.type === 'credential_uri') {
    if (!capabilities.supported_delivery_methods.includes('credential_uri')) {
      return { outcome: 'unsupported', networkRequests };
    }
    const origin = new URL(presentation.locator.credential_uri).origin;
    if (!acceptedIssuer.credential_origins?.includes(origin)) {
      return { outcome: 'untrusted_resolver', networkRequests };
    }
    networkRequests += 1;
  } else if (presentation.locator?.type === 'issuer_credential_id') {
    if (!capabilities.supported_delivery_methods.includes('issuer_credential_id')) {
      return { outcome: 'unsupported', networkRequests };
    }
    const resolver = acceptedIssuer.resolvers?.find(candidate => (
      candidate.resolver_id === presentation.locator.resolver_id
    ));
    if (!resolver) {
      return { outcome: 'untrusted_resolver', networkRequests };
    }
    networkRequests += 1;
  }

  if (presentation.embedded_credential) {
    if (!capabilities.supported_delivery_methods.includes('embedded')) {
      return { outcome: 'unsupported', networkRequests };
    }
  }

  if (!result || result.status === 'failed') {
    return { outcome: 'resolution_failed', networkRequests };
  }
  if (result.status === 'not_found') {
    return { outcome: 'not_found', networkRequests };
  }

  if (!capabilities.accepted_proof_formats.includes(result.proof_format)) {
    return { outcome: 'unsupported', networkRequests };
  }

  const credentialDigest = sha256(result.credential_bytes);
  const proofFormat = result.proof_format;

  if (presentation.locator && presentation.embedded_credential) {
    const embeddedResult = result.embedded_result;
    if (!embeddedResult) {
      return { outcome: 'invalid', networkRequests, credentialDigest, proofFormat };
    }
    if (
      !capabilities.accepted_proof_formats.includes(embeddedResult.proof_format)
      || embeddedResult.proof_format !== presentation.embedded_credential.format
    ) {
      return { outcome: 'unsupported', networkRequests };
    }
    const embeddedDigest = sha256(embeddedResult.credential_bytes);
    if (
      presentation.content_digest !== credentialDigest
      || presentation.content_digest !== embeddedDigest
    ) {
      return { outcome: 'digest_mismatch', networkRequests, credentialDigest, proofFormat };
    }
    if (
      !embeddedResult.signature_valid
      || !embeddedResult.signing_key_authorized_for_issuer
      || embeddedResult.credential.issuer !== presentation.issuer.origin
      || embeddedResult.credential.claim_type !== presentation.claim_type
      || !sameJson(embeddedResult.credential.subject, presentation.subject)
    ) {
      return { outcome: 'invalid', networkRequests, credentialDigest, proofFormat };
    }
  }

  if (presentation.content_digest && presentation.content_digest !== credentialDigest) {
    return { outcome: 'digest_mismatch', networkRequests, credentialDigest, proofFormat };
  }

  if (
    !result.signature_valid
    || result.signing_key_authorized_for_issuer === false
    || result.credential.issuer !== presentation.issuer.origin
  ) {
    return { outcome: 'invalid', networkRequests, credentialDigest, proofFormat };
  }

  if (result.credential.claim_type !== presentation.claim_type) {
    return { outcome: 'invalid', networkRequests, credentialDigest, proofFormat };
  }

  if (!sameJson(presentation.subject, result.credential.subject)) {
    return { outcome: 'subject_mismatch', networkRequests, credentialDigest, proofFormat };
  }

  if (result.credential.revoked) {
    return { outcome: 'revoked', networkRequests, credentialDigest, proofFormat };
  }

  const evaluationTime = Date.parse(fixture.evaluation_time);
  if (Date.parse(result.credential.expires_at) <= evaluationTime) {
    return { outcome: 'expired', networkRequests, credentialDigest, proofFormat };
  }
  if (Date.parse(result.credential.valid_from) > evaluationTime) {
    return { outcome: 'invalid', networkRequests, credentialDigest, proofFormat };
  }

  return { outcome: 'verified', networkRequests, credentialDigest, proofFormat };
}

describe('portable attestation conformance vectors', () => {
  let validateReference;
  let validateCapabilities;
  let validateEvaluation;

  before(async () => {
    canonicalize = (await import('canonicalize')).default;
    [validateReference, validateCapabilities, validateEvaluation] = await Promise.all([
      compile('/schemas/core/attestation-reference.json'),
      compile('/schemas/core/attestation-capabilities.json'),
      compile('/schemas/core/attestation-evaluation.json'),
    ]);
  });

  it('publishes a schema-valid evaluator allowlist', () => {
    assert.equal(validateCapabilities(fixture.capabilities), true, JSON.stringify(validateCapabilities.errors));
  });

  for (const vector of fixture.vectors) {
    it(`${vector.name}: validates and produces the expected safe outcome`, () => {
      assert.equal(validateReference(vector.presentation), true, JSON.stringify(validateReference.errors));

      const actual = evaluate(vector);
      assert.equal(actual.outcome, vector.expected.outcome);
      assert.equal(actual.networkRequests, vector.expected.network_requests);

      const evaluation = {
        reference_digest: sha256(canonicalize(vector.presentation)),
        outcome: actual.outcome,
        evaluated_at: fixture.evaluation_time,
        evaluated_by: 'https://governance.example/adcp',
        ...(actual.credentialDigest ? { credential_digest: actual.credentialDigest } : {}),
        ...(actual.proofFormat ? { proof_format: actual.proofFormat } : {}),
        action_binding: {
          action_type: 'https://adcontextprotocol.org/actions/governance-check',
          action_id: `check_${vector.name}`,
        },
      };
      assert.equal(validateEvaluation(evaluation), true, JSON.stringify(validateEvaluation.errors));
    });
  }

  it('embedded fixture bytes are the canonical bytes of the embedded credential', () => {
    const vector = fixture.vectors.find(candidate => candidate.name === 'embedded-credential-verified');
    assert.ok(vector);
    assert.equal(
      vector.resolver_result.credential_bytes,
      canonicalize(vector.presentation.embedded_credential.value),
    );
    assert.equal(
      sha256(vector.resolver_result.credential_bytes),
      vector.presentation.content_digest,
    );
  });

  it('requires an embedded byte limit when embedded delivery is advertised', () => {
    const withoutLimit = { ...fixture.capabilities };
    delete withoutLimit.max_embedded_credential_bytes;
    assert.equal(validateCapabilities(withoutLimit), false);

    const withoutEmbedded = {
      ...withoutLimit,
      supported_delivery_methods: ['credential_uri', 'issuer_credential_id'],
    };
    assert.equal(validateCapabilities(withoutEmbedded), true, JSON.stringify(validateCapabilities.errors));
  });

  it('requires a digest for dual delivery and verifies both representations', () => {
    const matching = fixture.vectors.find(candidate => candidate.name === 'dual-delivery-matching-verified');
    const mismatch = fixture.vectors.find(candidate => candidate.name === 'dual-delivery-resolved-embedded-mismatch');
    assert.ok(matching);
    assert.ok(mismatch);

    const withoutDigest = { ...matching.presentation };
    delete withoutDigest.content_digest;
    assert.equal(validateReference(withoutDigest), false);

    assert.equal(sha256(matching.resolver_result.credential_bytes), matching.presentation.content_digest);
    assert.equal(
      sha256(matching.resolver_result.embedded_result.credential_bytes),
      matching.presentation.content_digest,
    );
    assert.notEqual(
      sha256(mismatch.resolver_result.credential_bytes),
      sha256(mismatch.resolver_result.embedded_result.credential_bytes),
    );
  });

  it('requires proof_format whenever an evaluation carries credential_digest', () => {
    const evaluation = {
      reference_digest: `sha256:${'1'.repeat(64)}`,
      credential_digest: `sha256:${'2'.repeat(64)}`,
      outcome: 'verified',
      evaluated_at: fixture.evaluation_time,
      evaluated_by: 'https://governance.example/adcp',
    };
    assert.equal(validateEvaluation(evaluation), false);
    evaluation.proof_format = 'https://formats.example/jcs-signed-json';
    assert.equal(validateEvaluation(evaluation), true, JSON.stringify(validateEvaluation.errors));
  });

  it('issuer and subject comparison is structural rather than id-only', () => {
    const trusted = fixture.capabilities.accepted_issuers[0].issuer;
    assert.equal(sameJson(trusted, { type: 'origin', origin: 'https://credentials.example' }), true);
    assert.equal(sameJson(trusted, { type: 'agent', agent_url: 'https://credentials.example' }), false);

    const subject = fixture.vectors[0].presentation.subject;
    assert.equal(sameJson(subject, {
      type: 'resource',
      resource_type: 'https://adcontextprotocol.org/claims/subjects/signal',
      namespace: 'https://signals.meridian.example/adcp',
      id: 'signal_urban_commuters',
    }), true);
    assert.equal(sameJson(subject, { ...subject, namespace: 'https://other-signals.example/adcp' }), false);
    assert.equal(sameJson(subject, {
      ...subject,
      resource_type: 'https://adcontextprotocol.org/claims/subjects/audience-evidence',
    }), false);
    assert.equal(sameJson(subject, {
      ...subject,
      content_digest: `sha256:${'3'.repeat(64)}`,
    }), false);
  });
});
