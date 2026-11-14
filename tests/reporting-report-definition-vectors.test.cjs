'use strict';

/**
 * Replays static/compliance/source/test-vectors/reporting-report-definition/
 * against core/reporting-report-definition.json: the contract_version 1.2
 * package_id dimension rule, its account-level exemption, and the advisory
 * finding for 1.0 and 1.1 media-buy definitions without package_id (#8971).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();
const ROOT = path.resolve(__dirname, '..');
const VECTOR_ROOT = path.join(ROOT, 'static/compliance/source/test-vectors/reporting-report-definition');
const RECONCILIATION_DEFINITION = path.join(
  ROOT,
  'static/compliance/source/test-vectors/reporting-reconciliation/report-definition.json',
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function compileDefinitionSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readBuiltSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readBuiltSchema('/schemas/core/reporting-report-definition.json'));
}

// The rule stated in vectors.json, graded independently of the JSON Schema.
function grade(definition) {
  const dimensions = definition.dimensions ?? [];
  const mediaBuyWithoutPackage = dimensions.includes('media_buy_id') && !dimensions.includes('package_id');
  const violations = [];
  const advisories = [];
  if (definition.contract_version === '1.2' && mediaBuyWithoutPackage) violations.push('package_id_dimension_missing');
  if (['1.1', '1.2'].includes(definition.contract_version) && !definition.restatement_policy?.official_correction_mode) {
    violations.push('official_correction_mode_missing');
  }
  if (['1.0', '1.1'].includes(definition.contract_version) && mediaBuyWithoutPackage) {
    advisories.push('package_id_dimension_missing');
  }
  return { violations, advisories };
}

const vectors = readJson(path.join(VECTOR_ROOT, 'vectors.json'));
const base = readJson(path.join(VECTOR_ROOT, vectors.base));

test('vector catalog names only declared codes and unique case ids', () => {
  const ids = vectors.cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of vectors.cases) {
    for (const code of c.expected.violations) assert.ok(vectors.violation_codes[code], `${c.id}: ${code}`);
    for (const code of c.expected.advisories) assert.ok(vectors.advisory_codes[code], `${c.id}: ${code}`);
    assert.equal(c.expected.schema_valid, c.expected.violations.length === 0, c.id);
  }
});

test('the 1.2 base definition carries date, media_buy_id, and package_id', () => {
  assert.equal(base.contract_version, '1.2');
  assert.deepEqual(base.dimensions, ['date', 'media_buy_id', 'package_id']);
});

test('every case matches the schema verdict and the graded rule', async () => {
  const validate = await compileDefinitionSchema();
  for (const c of vectors.cases) {
    const definition = { ...structuredClone(base), ...structuredClone(c.overrides) };
    const valid = validate(definition);
    assert.equal(valid, c.expected.schema_valid, `${c.id}: ${JSON.stringify(validate.errors)}`);
    const graded = grade(definition);
    assert.deepEqual(graded.violations, c.expected.violations, `${c.id} violations`);
    assert.deepEqual(graded.advisories, c.expected.advisories, `${c.id} advisories`);
  }
});

test('the reconciliation reference definition stays at 1.1 and draws only the advisory', async () => {
  const validate = await compileDefinitionSchema();
  const reference = readJson(RECONCILIATION_DEFINITION);
  assert.equal(reference.contract_version, '1.1');
  assert.deepEqual(reference.dimensions, ['date', 'media_buy_id']);
  assert.equal(validate(reference), true, JSON.stringify(validate.errors));
  assert.deepEqual(grade(reference), { violations: [], advisories: ['package_id_dimension_missing'] });
});
