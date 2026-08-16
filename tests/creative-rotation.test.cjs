const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), 'utf8'));
}

async function compileCreativeAssignment() {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async uri => {
    if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load schema ${uri}`);
    return readSchema(uri.replace('/schemas/', ''));
  }});
  addFormats(ajv);
  return ajv.compileAsync(readSchema('core/creative-assignment.json'));
}

function packageRotationErrors(assignments) {
  const errors = [];
  const modes = new Set(assignments.map(item => item.rotation_mode ?? 'weighted'));
  if (modes.size > 1) errors.push('conflicting effective rotation modes');

  if (modes.size === 1 && modes.has('sequential')) {
    const positionsByGroup = new Map();
    for (const item of assignments) {
      const group = item.group_id ?? '__package_default__';
      const positions = positionsByGroup.get(group) ?? new Set();
      if (positions.has(item.sequence_position)) errors.push(`duplicate position in ${group}`);
      positions.add(item.sequence_position);
      positionsByGroup.set(group, positions);
    }
  }
  return errors;
}

test('legacy weighted assignments remain valid without rotation_mode', async () => {
  const validate = await compileCreativeAssignment();
  assert.equal(validate({ creative_id: 'host_read', weight: 70 }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ creative_id: 'produced_spot' }), true, JSON.stringify(validate.errors));
});

test('all package rotation modes validate with their allowed fields', async () => {
  const validate = await compileCreativeAssignment();
  const examples = [
    { creative_id: 'weighted', rotation_mode: 'weighted', weight: 2 },
    { creative_id: 'even', rotation_mode: 'even' },
    { creative_id: 'random', rotation_mode: 'random', group_id: 'pool-a' },
    { creative_id: 'sequential', rotation_mode: 'sequential', group_id: 'story', sequence_position: 1 }
  ];
  for (const example of examples) {
    assert.equal(validate(example), true, `${example.rotation_mode}: ${JSON.stringify(validate.errors)}`);
  }
});

test('sequential fields and weights are rejected in incompatible modes', async () => {
  const validate = await compileCreativeAssignment();
  const invalid = [
    { creative_id: 'missing-position', rotation_mode: 'sequential' },
    { creative_id: 'position-in-even', rotation_mode: 'even', sequence_position: 1 },
    { creative_id: 'position-without-mode', sequence_position: 1 },
    { creative_id: 'weighted-even', rotation_mode: 'even', weight: 50 },
    { creative_id: 'weighted-random', rotation_mode: 'random', weight: 50 },
    { creative_id: 'weighted-sequence', rotation_mode: 'sequential', sequence_position: 1, weight: 50 }
  ];
  for (const example of invalid) {
    assert.equal(validate(example), false, `unexpectedly accepted ${JSON.stringify(example)}`);
  }
});

test('package conformance rejects mode conflicts and duplicate positions per group', () => {
  assert.deepEqual(packageRotationErrors([
    { creative_id: 'a', weight: 60 },
    { creative_id: 'b', rotation_mode: 'weighted', weight: 40 }
  ]), []);

  assert.deepEqual(packageRotationErrors([
    { creative_id: 'a', rotation_mode: 'even' },
    { creative_id: 'b' }
  ]), ['conflicting effective rotation modes']);

  assert.deepEqual(packageRotationErrors([
    { creative_id: 'a', rotation_mode: 'sequential', group_id: 'story', sequence_position: 1 },
    { creative_id: 'b', rotation_mode: 'sequential', group_id: 'story', sequence_position: 1 }
  ]), ['duplicate position in story']);

  assert.deepEqual(packageRotationErrors([
    { creative_id: 'a', rotation_mode: 'sequential', group_id: 'story-a', sequence_position: 1 },
    { creative_id: 'b', rotation_mode: 'sequential', group_id: 'story-b', sequence_position: 1 }
  ]), []);
});

test('create, update, and read schemas publish the same package rotation rule', () => {
  const locations = [
    ['media-buy/package-request.json', schema => schema.properties.creative_assignments],
    ['media-buy/package-update.json', schema => schema.properties.creative_assignments],
    ['core/package.json', schema => schema.properties.creative_assignments]
  ];

  for (const [relativePath, select] of locations) {
    const assignments = select(readSchema(relativePath));
    const annotation = assignments['x-adcp-validation'];
    const policy = annotation?.verifier_constraints?.package_rotation_policy;
    assert.equal(policy?.effective_mode, 'assignment.rotation_mode_or_weighted_default', relativePath);
    assert.equal(policy?.mode_consistency, 'all_assignments_equal', relativePath);
    assert.equal(policy?.sequence_positions, 'required_and_unique_per_effective_group_when_sequential', relativePath);
    assert.equal(policy?.group_namespace, 'package_id', relativePath);
    assert.equal(annotation?.spec, 'docs/reference/migration/creatives.mdx#rotation-modes-and-groups', relativePath);
  }
});
