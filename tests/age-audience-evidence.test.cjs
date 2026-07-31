const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const age = { min: 25, max: 34, include_unknown: false };

describe('compact age audience evidence', () => {
  let validateEvidence;
  let validateRequirement;
  let validateRequest;
  let validateResponse;
  let validatePackage;
  let validatePackageRequest;

  before(async () => {
    [validateEvidence, validateRequirement, validateRequest, validateResponse, validatePackage, validatePackageRequest] = await Promise.all([
      compile('/schemas/core/audience-evidence.json'),
      compile('/schemas/core/audience-evidence-requirement.json'),
      compile('/schemas/media-buy/get-products-request.json'),
      compile('/schemas/media-buy/get-products-response.json'),
      compile('/schemas/core/package.json'),
      compile('/schemas/media-buy/package-request.json'),
    ]);
  });

  it('represents a population estimate without implying individual resolution', () => {
    assert.equal(validateEvidence({
      dimension: 'age',
      age,
      estimated_share: 0.8,
      basis: 'population_estimate',
    }), true, JSON.stringify(validateEvidence.errors));
  });

  it('requires a method for verified evidence and forbids it on other bases', () => {
    assert.equal(validateEvidence({
      dimension: 'age',
      age: { min: 16, include_unknown: false },
      estimated_share: 0.95,
      basis: 'verified',
      verification_methods: ['world_id', 'id_document'],
    }), true, JSON.stringify(validateEvidence.errors));

    assert.equal(validateEvidence({
      dimension: 'age',
      age,
      estimated_share: 0.8,
      basis: 'verified',
    }), false);

    assert.equal(validateEvidence({
      dimension: 'age',
      age,
      estimated_share: 0.8,
      basis: 'population_estimate',
      verification_methods: ['world_id'],
    }), false);
  });

  it('supports fail-closed required rules and non-excluding preferences', () => {
    const required = {
      dimension: 'age',
      age,
      minimum_share: 0.75,
      accepted_bases: ['verified', 'declared'],
      accepted_verification_methods: ['world_id'],
      requirement_mode: 'required',
    };
    assert.equal(validateRequirement(required), true, JSON.stringify(validateRequirement.errors));
    assert.equal(validateRequirement({ ...required, requirement_mode: 'preferred' }), true);
    assert.equal(validateRequest({ buying_mode: 'wholesale', audience_evidence_requirements: [required] }), true, JSON.stringify(validateRequest.errors));
  });

  it('rejects verification methods when verified evidence is not acceptable', () => {
    assert.equal(validateRequirement({
      dimension: 'age',
      age,
      accepted_bases: ['declared', 'population_estimate'],
      accepted_verification_methods: ['world_id'],
      requirement_mode: 'required',
    }), false);
  });

  it('uses a positive acknowledgement instead of a false or ambiguous evaluation flag', () => {
    assert.equal(validateResponse({ status: 'completed', cache_scope: 'public', products: [], audience_evidence_requirements_applied: true }), true, JSON.stringify(validateResponse.errors));
    assert.equal(validateResponse({ status: 'completed', cache_scope: 'public', products: [], audience_evidence_requirements_applied: false }), false);
  });

  it('locks product publication and discovery schema paths', () => {
    const product = readSchema('/schemas/core/product.json');
    const request = readSchema('/schemas/media-buy/get-products-request.json');
    const response = readSchema('/schemas/media-buy/get-products-response.json');
    const packageSchema = readSchema('/schemas/core/package.json');
    const getMediaBuys = readSchema('/schemas/media-buy/get-media-buys-response.json');

    assert.equal(product.properties.audience_evidence.items.$ref, '/schemas/core/audience-evidence.json');
    assert.equal(request.properties.audience_evidence_requirements.items.$ref, '/schemas/core/audience-evidence-requirement.json');
    assert.equal(response.properties.audience_evidence_requirements_applied.const, true);
    assert.equal(packageSchema.properties.audience_evidence_used.items.$ref, '/schemas/core/audience-evidence.json');
    assert.equal(getMediaBuys.properties.media_buys.items.properties.packages.items.properties.audience_evidence_used.items.$ref, '/schemas/core/audience-evidence.json');
  });

  it('snapshots the compact evidence row on package readback', () => {
    const selectedEvidence = {
      dimension: 'age',
      age,
      estimated_share: 0.8,
      basis: 'population_estimate',
    };
    assert.equal(validatePackageRequest({
      product_id: 'product-1',
      pricing_option_id: 'cpm-usd',
      budget: 10000,
      audience_evidence_selected: [selectedEvidence],
    }), true, JSON.stringify(validatePackageRequest.errors));
    assert.equal(validatePackage({
      package_id: 'pkg-1',
      audience_evidence_used: [selectedEvidence],
    }), true, JSON.stringify(validatePackage.errors));
  });

  it('keeps unknown-age users outside the evidence numerator', () => {
    assert.equal(validateEvidence({
      dimension: 'age',
      age: { min: 25, max: 34, include_unknown: true },
      estimated_share: 0.8,
      basis: 'population_estimate',
    }), false);
    assert.equal(validateRequirement({
      dimension: 'age',
      age: { min: 25, max: 34, include_unknown: true },
      accepted_bases: ['population_estimate'],
      requirement_mode: 'required',
    }), false);
  });
});
