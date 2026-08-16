const fs = require('node:fs');
const path = require('node:path');
const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function applySyntheticDepictionGate(policy, provenance) {
  if (policy.provenance_required !== true) return null;
  if (provenance == null) {
    return {
      code: 'PROVENANCE_REQUIRED',
      field: 'creative_manifest',
    };
  }
  if (policy.provenance_requirements?.require_synthetic_depiction !== true) return null;
  if (typeof provenance?.synthetic_depiction === 'boolean') return null;
  return {
    code: 'PROVENANCE_SYNTHETIC_DEPICTION_MISSING',
    field: 'creative_manifest.provenance.synthetic_depiction',
  };
}

describe('synthetic-depiction provenance declaration', () => {
  let validateProvenance;
  let validatePolicy;

  before(async () => {
    [validateProvenance, validatePolicy] = await Promise.all([
      compile('/schemas/core/provenance.json'),
      compile('/schemas/core/creative-policy.json'),
    ]);
  });

  it('treats true and false as assessed declarations and absence as unassessed', () => {
    assert.equal(validateProvenance({ synthetic_depiction: true }), true);
    assert.equal(validateProvenance({ synthetic_depiction: false }), true);
    assert.equal(validateProvenance({}), true, 'absence remains schema-valid and means unassessed');
    assert.equal(validateProvenance({ synthetic_depiction: null }), false);
    assert.equal(validateProvenance({ synthetic_depiction: 'false' }), false);
  });

  it('publishes a boolean creative-policy requirement', () => {
    const base = { co_branding: 'optional', landing_page: 'any', templates_available: false };
    assert.equal(validatePolicy({
      ...base,
      provenance_required: true,
      provenance_requirements: { require_synthetic_depiction: true },
    }), true, JSON.stringify(validatePolicy.errors));
    assert.equal(validatePolicy({
      ...base,
      provenance_required: true,
      provenance_requirements: { require_synthetic_depiction: 'true' },
    }), false);
  });

  it('gates only an advertised requirement and returns the canonical missing-field error', () => {
    const required = {
      provenance_required: true,
      provenance_requirements: { require_synthetic_depiction: true },
    };

    assert.equal(applySyntheticDepictionGate(required, { synthetic_depiction: true }), null);
    assert.equal(applySyntheticDepictionGate(required, { synthetic_depiction: false }), null);
    assert.deepEqual(applySyntheticDepictionGate(required, {}), {
      code: 'PROVENANCE_SYNTHETIC_DEPICTION_MISSING',
      field: 'creative_manifest.provenance.synthetic_depiction',
    });
    assert.deepEqual(applySyntheticDepictionGate(required), {
      code: 'PROVENANCE_REQUIRED',
      field: 'creative_manifest',
    }, 'a missing provenance object keeps the broader error precedence');
    assert.equal(applySyntheticDepictionGate({ provenance_required: false, provenance_requirements: { require_synthetic_depiction: true } }, {}), null);
    assert.equal(applySyntheticDepictionGate({ provenance_required: true }, {}), null);
  });

  it('keeps the declaration separate from production method, consent, legality, and verification', () => {
    const field = readSchema('/schemas/core/provenance.json').properties.synthetic_depiction;
    assert.match(field.description, /MUST NOT derive it solely from `digital_source_type`/);
    assert.match(field.description, /does not claim consent, legality, or independent verification/);

    assert.equal(validateProvenance({
      digital_source_type: 'digital_capture',
      synthetic_depiction: true,
    }), true, 'a materially manipulated captured performer can be declared true');
    assert.equal(validateProvenance({
      digital_source_type: 'trained_algorithmic_media',
      synthetic_depiction: false,
    }), true, 'non-human synthetic content can be assessed false');
  });

  it('registers the missing-declaration code with correctable recovery', () => {
    const errors = readSchema('/schemas/enums/error-code.json');
    assert.equal(errors.enum.includes('PROVENANCE_SYNTHETIC_DEPICTION_MISSING'), true);
    assert.match(errors.enumDescriptions.PROVENANCE_SYNTHETIC_DEPICTION_MISSING, /Both `true` and `false` satisfy/);
    assert.equal(errors.enumMetadata.PROVENANCE_SYNTHETIC_DEPICTION_MISSING.recovery, 'correctable');
  });
});
