const fs = require('node:fs');
const path = require('node:path');
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

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(typeof schema === 'string' ? readSchema(schema) : schema);
}

function clone(value) {
  return structuredClone(value);
}

// The semantics block below runs a small reference model of the normative text in
// docs/media-buy/task-reference/get_products.mdx. It pins the documented rules and
// gives implementers worked cases; it does not exercise a seller.
//
// Canonical audience key for exact matching: dimension, value or range, taxonomy. label is never compared.
// Set values are order-insensitive; a range's absent bound is distinct from a present one.
function audienceKey(audience) {
  // Keys are inserted in a fixed order, so JSON.stringify is a stable comparison key.
  const key = { dimension: audience.dimension };
  if (audience.range) {
    key.range = {};
    for (const bound of ['min', 'max']) if (audience.range[bound] !== undefined) key.range[bound] = audience.range[bound];
  } else if (Array.isArray(audience.value)) {
    key.set = [...audience.value].sort();
  } else {
    key.value = audience.value;
  }
  if (audience.taxonomy) {
    key.taxonomy = {
      system: audience.taxonomy.system,
      version: audience.taxonomy.version ?? null,
      value_id: audience.taxonomy.value_id ?? null,
    };
  }
  return JSON.stringify(key);
}

function satisfies(target, evidenceItems) {
  return evidenceItems.some(item => audienceKey(item.audience) === audienceKey(target.audience)
    && item.relationship === target.relationship
    && item.value >= target.minimum_value);
}

// `admissibleItems` is the evidence that already passed every other constraint in the requirements object.
function evaluate(requirements, admissibleItems, publishedAny = admissibleItems.length > 0) {
  const targets = requirements.target_audiences || [];
  const satisfied = targets.filter(target => satisfies(target, admissibleItems)).length;
  const allSatisfied = satisfied === targets.length;
  if (requirements.requirement_mode === 'preferred') {
    return { eligible: true, satisfied, allSatisfied };
  }
  if (!publishedAny) {
    return { eligible: requirements.evidence_presence === 'when_available', satisfied, allSatisfied };
  }
  return { eligible: allSatisfied, satisfied, allSatisfied };
}

const AGE_25_54 = { dimension: 'age', range: { min: 25, max: 54 } };
const base = { requirement_mode: 'preferred', evidence_presence: 'when_available' };
const target = { audience: AGE_25_54, relationship: 'composition', minimum_value: 0.4 };

function evidenceFor(audience, relationship, value) {
  return { audience, relationship, value };
}

describe('audience evidence target audiences (#8125)', () => {
  let validateRequirements;
  let validateCompact;
  let validateFilters;
  let validateOfferFilters;
  let validateTarget;
  let validatePackageRequest;
  let validatePurchaseInputRequirements;
  let validatePurchaseRequirements;

  before(async () => {
    [
      validateRequirements,
      validateCompact,
      validateFilters,
      validateOfferFilters,
      validateTarget,
      validatePackageRequest,
      validatePurchaseInputRequirements,
      validatePurchaseRequirements,
    ] = await Promise.all([
      compile('/schemas/core/audience-evidence-requirements.json'),
      compile('/schemas/core/product-audience-evidence-requirements.json'),
      compile('/schemas/core/product-filters.json'),
      compile('/schemas/core/product-offer-filters.json'),
      compile('/schemas/core/audience-evidence-target.json'),
      compile('/schemas/media-buy/package-request.json'),
      compile({ $ref: '/schemas/media-buy/product-purchase-input.json#/properties/audience_evidence_requirements' }),
      compile({ $ref: '/schemas/media-buy/product-purchase.json#/properties/audience_evidence_requirements' }),
    ]);
  });

  describe('schema', () => {
    it('accepts target_audiences on the full and compact requirements and on discovery filters', () => {
      const requirements = { ...base, target_audiences: [target], accepted_evidence_types: ['measured'], minimum_confidence: 0.8 };
      assert.equal(validateRequirements(requirements), true, JSON.stringify(validateRequirements.errors));
      assert.equal(validateCompact(requirements), true, JSON.stringify(validateCompact.errors));
      assert.equal(validateFilters({ audience_evidence_requirements: requirements }), true, JSON.stringify(validateFilters.errors));
      assert.equal(validateOfferFilters({ audience_evidence_requirements: requirements }), true, JSON.stringify(validateOfferFilters.errors));
    });

    it('keeps target_audiences optional so 3.2 policies are unchanged', () => {
      assert.equal(validateRequirements(base), true);
      assert.equal(validateCompact(base), true);
    });

    it('requires audience, relationship, and minimum_value and closes the item', () => {
      for (const field of ['audience', 'relationship', 'minimum_value']) {
        const invalid = clone(target);
        delete invalid[field];
        assert.equal(validateTarget(invalid), false, field);
      }
      assert.equal(validateTarget({ ...target, strength: 'required' }), false);
      assert.equal(validateTarget({ ...target, relationship: 'affinity' }), false);
      assert.equal(validateTarget({ ...target, minimum_value: -0.1 }), false);
      assert.equal(validateTarget({ ...target, audience: { dimension: 'age' } }), false);
    });

    it('bounds minimum_value by the unit the relationship implies', () => {
      assert.equal(validateTarget({ ...target, relationship: 'composition', minimum_value: 1.2 }), false);
      assert.equal(validateTarget({ ...target, relationship: 'composition', minimum_value: 1 }), true);
      assert.equal(validateTarget({ ...target, relationship: 'index', minimum_value: 1.2 }), true);
      assert.equal(validateTarget({ ...target, relationship: 'reach_estimate', minimum_value: 1000.5 }), false);
      assert.equal(validateTarget({ ...target, relationship: 'reach_estimate', minimum_value: 1000 }), true);
    });

    it('bounds the list and reuses the audience characteristic constraints', () => {
      assert.equal(validateRequirements({ ...base, target_audiences: [] }), false);
      assert.equal(validateRequirements({ ...base, target_audiences: [target, target] }), false);
      assert.equal(validateRequirements({ ...base, target_audiences: Array.from({ length: 11 }, (_, index) => ({ ...target, minimum_value: index / 10 })) }), false);
      assert.equal(validateRequirements({ ...base, target_audiences: Array.from({ length: 10 }, (_, index) => ({ ...target, minimum_value: index / 10 })) }), true);
      assert.equal(validateRequirements({
        ...base,
        target_audiences: [{ ...target, audience: { dimension: 'age', range: { min: -1, max: 54 } } }],
      }), false);
    });

    it('rejects target_audiences on create_media_buy packages and buy_products purchases', () => {
      const withTargets = { ...fixture.package_request.audience_evidence_requirements, target_audiences: [target] };
      assert.equal(validatePackageRequest(fixture.package_request), true, JSON.stringify(validatePackageRequest.errors));
      const packageRequest = clone(fixture.package_request);
      packageRequest.audience_evidence_requirements = withTargets;
      assert.equal(validatePackageRequest(packageRequest), false);

      assert.equal(validatePurchaseInputRequirements(base), true, JSON.stringify(validatePurchaseInputRequirements.errors));
      assert.equal(validatePurchaseInputRequirements({ ...base, target_audiences: [target] }), false);
      assert.equal(validatePurchaseRequirements(base), true, JSON.stringify(validatePurchaseRequirements.errors));
      assert.equal(validatePurchaseRequirements({ ...base, target_audiences: [target] }), false);
    });
  });

  describe('conventions', () => {
    it('marks every new surface experimental and added in 3.3.0', () => {
      const targetSchema = readSchema('/schemas/core/audience-evidence-target.json');
      assert.equal(targetSchema['x-status'], 'experimental');
      assert.equal(targetSchema['x-added-in'], '3.3.0');
      for (const uri of ['/schemas/core/audience-evidence-requirements.json', '/schemas/core/product-audience-evidence-requirements.json']) {
        const property = readSchema(uri).properties.target_audiences;
        assert.equal(property['x-status'], 'experimental', uri);
        assert.equal(property['x-added-in'], '3.3.0', uri);
        assert.equal(property.items.$ref, '/schemas/core/audience-evidence-target.json', uri);
      }
    });

    it('shares one relationship enum with published evidence instead of inlining it', () => {
      const relationship = readSchema('/schemas/enums/audience-evidence-relationship.json');
      assert.equal(relationship['x-added-in'], '3.3.0');
      assert.deepEqual(relationship.enum, ['composition', 'index', 'reach_estimate']);
      assert.deepEqual(Object.keys(relationship.enumDescriptions).sort(), [...relationship.enum].sort());
      for (const [uri, property] of [
        ['/schemas/core/audience-evidence.json', readSchema('/schemas/core/audience-evidence.json').properties.relationship],
        ['/schemas/core/canonical-audience-evidence.json', readSchema('/schemas/core/canonical-audience-evidence.json').properties.relationship],
        ['/schemas/core/audience-evidence-target.json', readSchema('/schemas/core/audience-evidence-target.json').properties.relationship],
      ]) {
        assert.equal(property.$ref, '/schemas/enums/audience-evidence-relationship.json', uri);
        assert.equal(property.enum, undefined, uri);
      }
    });

    it('lists the feature id in the canonical experimental table', () => {
      const doc = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
      assert.match(doc, /^\| `media_buy\.audience_evidence_targets` \|/m);
    });

    it('documents the surface under the heading the other pages link to', () => {
      const doc = fs.readFileSync(path.join(ROOT, 'docs/media-buy/task-reference/get_products.mdx'), 'utf8');
      assert.match(doc, /^#### Target audiences \(experimental\)$/m);
      for (const page of ['docs/media-buy/product-discovery/media-products.mdx', 'docs/media-buy/task-reference/create_media_buy.mdx']) {
        assert.match(fs.readFileSync(path.join(ROOT, page), 'utf8'), /get_products#target-audiences-experimental/, page);
      }
    });
  });

  describe('semantics', () => {
    const exact = evidenceFor(clone(AGE_25_54), 'composition', 0.45);
    const lowShare = evidenceFor(clone(AGE_25_54), 'composition', 0.3);

    it('is satisfied by exact-range evidence at or above the minimum', () => {
      assert.equal(satisfies(target, [exact]), true);
      assert.equal(satisfies(target, [evidenceFor(clone(AGE_25_54), 'composition', 0.4)]), true);
      assert.equal(satisfies(target, [lowShare]), false);
    });

    it('does not match a superset, subset, or shifted range', () => {
      for (const range of [{ min: 18, max: 54 }, { min: 25, max: 34 }, { min: 26, max: 54 }, { min: 25 }, { max: 54 }]) {
        assert.equal(satisfies(target, [evidenceFor({ dimension: 'age', range }, 'composition', 0.9)]), false, JSON.stringify(range));
      }
    });

    it('ignores label, compares sets unordered, and treats taxonomy as part of the key', () => {
      assert.equal(satisfies(target, [evidenceFor({ ...AGE_25_54, label: 'Adults 25 to 54' }, 'composition', 0.5)]), true);

      const setTarget = { audience: { dimension: 'https://taxonomy.example/segments', value: ['a', 'b'] }, relationship: 'index', minimum_value: 1.2 };
      assert.equal(satisfies(setTarget, [evidenceFor({ dimension: 'https://taxonomy.example/segments', value: ['b', 'a'] }, 'index', 1.5)]), true);
      assert.equal(satisfies(setTarget, [evidenceFor({ dimension: 'https://taxonomy.example/segments', value: 'a' }, 'index', 1.5)]), false);
      assert.equal(satisfies({ ...target, audience: { dimension: 'age', value: 30 } }, [evidenceFor({ dimension: 'age', range: { min: 30, max: 30 } }, 'composition', 0.9)]), false);
      assert.equal(satisfies({ ...target, audience: { dimension: 'age', value: [30] } }, [evidenceFor({ dimension: 'age', value: 30 }, 'composition', 0.9)]), false);

      const taxonomy = { system: 'https://taxonomy.example', version: '1', value_id: '25-54' };
      const taxonomyTarget = { ...target, audience: { ...AGE_25_54, taxonomy } };
      assert.equal(satisfies(taxonomyTarget, [evidenceFor({ ...AGE_25_54, taxonomy: { ...taxonomy } }, 'composition', 0.5)]), true);
      assert.equal(satisfies(taxonomyTarget, [evidenceFor(clone(AGE_25_54), 'composition', 0.5)]), false);
      assert.equal(satisfies(target, [evidenceFor({ ...AGE_25_54, taxonomy }, 'composition', 0.5)]), false);
    });

    it('compares only the same relationship', () => {
      assert.equal(satisfies(target, [evidenceFor(clone(AGE_25_54), 'index', 1.8)]), false);
      assert.equal(satisfies({ ...target, relationship: 'index', minimum_value: 1.5 }, [evidenceFor(clone(AGE_25_54), 'index', 1.8)]), true);
    });

    it('combines several targets with AND and lets different items satisfy different targets', () => {
      const female = { audience: { dimension: 'https://taxonomy.example/gender', value: 'female' }, relationship: 'composition', minimum_value: 0.5 };
      const requirements = { requirement_mode: 'required', evidence_presence: 'required', target_audiences: [target, female] };
      const femaleEvidence = evidenceFor(clone(female.audience), 'composition', 0.55);
      assert.deepEqual(evaluate(requirements, [exact, femaleEvidence]), { eligible: true, satisfied: 2, allSatisfied: true });
      assert.deepEqual(evaluate(requirements, [exact]), { eligible: false, satisfied: 1, allSatisfied: false });
    });

    it('excludes under required and only ranks under preferred', () => {
      const required = { requirement_mode: 'required', evidence_presence: 'required', target_audiences: [target] };
      assert.equal(evaluate(required, [lowShare]).eligible, false);
      assert.equal(evaluate(required, []).eligible, false);

      const preferred = { ...required, requirement_mode: 'preferred' };
      assert.deepEqual(evaluate(preferred, [lowShare]), { eligible: true, satisfied: 0, allSatisfied: false });
      assert.deepEqual(evaluate(preferred, [exact]), { eligible: true, satisfied: 1, allSatisfied: true });
    });

    it('counts satisfied targets so a higher count never ranks below a lower one', () => {
      const female = { audience: { dimension: 'https://taxonomy.example/gender', value: 'female' }, relationship: 'composition', minimum_value: 0.5 };
      const preferred = { requirement_mode: 'preferred', evidence_presence: 'when_available', target_audiences: [target, female] };
      const femaleEvidence = evidenceFor(clone(female.audience), 'composition', 0.55);
      const counts = [[], [lowShare], [exact], [exact, femaleEvidence]].map(items => evaluate(preferred, items).satisfied);
      assert.deepEqual(counts, [0, 0, 1, 2]);
      assert.deepEqual([...counts].sort((a, b) => a - b), counts);
    });

    it('keeps a product with no published evidence eligible under when_available', () => {
      const requirements = { requirement_mode: 'required', evidence_presence: 'when_available', target_audiences: [target] };
      assert.equal(evaluate(requirements, [], false).eligible, true);
      // Published evidence for another audience does not satisfy the targets, so the product drops out.
      assert.equal(evaluate(requirements, [evidenceFor({ dimension: 'age', range: { min: 18, max: 24 } }, 'composition', 0.9)]).eligible, false);
    });
  });
});
