const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const ROOT = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'static/test-vectors/canonical-display-acceptance.json'), 'utf8',
));
const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
addFormats(ajv);
ajv.addFormat('uri-template', true);
function addSchemas(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) addSchemas(file);
    else if (entry.name.endsWith('.json')) {
      const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema, schema.$id);
    }
  }
}
addSchemas(path.join(ROOT, 'static/schemas/source'));

const sameSize = (a, b) => a.width === b.width && a.height === b.height;
function assetSizes(asset) {
  return asset.sizes ?? (asset.width !== undefined && asset.height !== undefined
    ? [{ width: asset.width, height: asset.height }] : []);
}
function pairMatches(params, pair) {
  if (params.width !== undefined && !sameSize(params, pair)) return false;
  if (params.sizes && !params.sizes.some(size => sameSize(size, pair))) return false;
  return ['width', 'height'].every(axis =>
    (params[`min_${axis}`] === undefined || pair[axis] >= params[`min_${axis}`]) &&
    (params[`max_${axis}`] === undefined || pair[axis] <= params[`max_${axis}`]));
}
function backupCovers(backup, pair, layers) {
  // These fixtures use explicit density or ordinary 1x. The separate image-density
  // suite covers inference, ambiguity, required rendition sets, and actual ratios.
  const ratio = backup.pixel_ratio ?? 1;
  const accepted = layers.every(layer => {
    const slot = layer.params.slots?.find(candidate => candidate.asset_group_id === 'backup_image');
    return (slot?.pixel_ratios ?? [1]).includes(ratio);
  });
  return accepted && backup.width / ratio === pair.width && backup.height / ratio === pair.height;
}

// An executable reference for the modeled semantic contract, not a serving engine.
// Evidence flags are independently established integration facts. In particular,
// accepting a flag here does not prove a tag resizes or an extension was fetched.
function assessAcceptance(vector) {
  const { layers, asset, evidence = {} } = vector;
  for (const { params } of layers) {
    for (const axis of ['width', 'height']) {
      if (params[`min_${axis}`] !== undefined && params[`max_${axis}`] !== undefined &&
          params[`min_${axis}`] > params[`max_${axis}`]) {
        return { status: 'invalid', reason: 'responsive_bound_order' };
      }
    }
  }
  const supplied = assetSizes(asset);
  if (supplied.length === 0) return { status: 'undeclared', reason: 'rendered_size_unproven' };
  let sizes = supplied.filter(pair => layers.every(layer => pairMatches(layer.params, pair)));
  if (sizes.length === 0) return { status: 'incompatible', reason: 'no_compatible_size' };
  const hasArtifactRefs = layers.some(layer => layer.params.platform_extensions?.length > 0);
  if (evidence.referenced_artifacts_resolved === false ||
      (hasArtifactRefs && evidence.referenced_artifacts_resolved !== true)) {
    return { status: 'undeclared', reason: 'referenced_artifact_unresolved' };
  }
  if (layers.some(layer => layer.technical_requirements_complete !== true)) {
    return { status: 'undeclared', reason: 'technical_contract_incomplete' };
  }
  if (asset.sizes && evidence.size_selection_enforceable !== true) {
    return { status: 'undeclared', reason: 'size_selection_unproven' };
  }
  if (layers.some(layer => layer.params.backup_image_required === true)) {
    sizes = sizes.filter(pair => (vector.backups ?? []).some(backup => backupCovers(backup, pair, layers)));
    if (sizes.length === 0) return { status: 'incompatible', reason: 'required_backup_size_missing' };
  }
  return { status: 'compatible', eligible_sizes: sizes };
}

function projectLegacy(vector) {
  const supplied = assetSizes(vector.asset);
  if (vector.asset.sizes && !vector.selected_size) return { status: 'ambiguous' };
  const selected = vector.selected_size ?? supplied[0];
  if (!selected || !supplied.some(pair => sameSize(pair, selected))) return { status: 'unavailable' };
  const candidates = vector.candidates.filter(candidate => sameSize(candidate, selected));
  if (candidates.length === 0) return { status: 'unavailable' };
  return candidates.length === 1
    ? { status: 'selected', id: candidates[0].id }
    : { status: 'ambiguous' };
}

for (const vector of fixture.acceptance_vectors) {
  test(`display acceptance: ${vector.id}`, () => {
    // A reversed interval is structurally legal in draft-07; semantic validation
    // must reject it. Keep fixtures valid at the individual-schema layer.
    for (const kind of ['html5', 'display_tag']) {
      const validate = ajv.getSchema(`/schemas/formats/canonical/${kind}.json`);
      for (const layer of vector.layers) {
        assert.equal(validate(layer.params), true, `${kind}: ${JSON.stringify(validate.errors)}`);
      }
    }
    const validateAsset = ajv.getSchema('/schemas/core/assets/asset-union.json');
    assert.equal(validateAsset(vector.asset), true, JSON.stringify(validateAsset.errors));
    for (const backup of vector.backups ?? []) {
      assert.equal(validateAsset(backup), true, JSON.stringify(validateAsset.errors));
    }
    assert.deepEqual(assessAcceptance(vector), vector.expected);
    // Intersection is commutative; layer order never establishes precedence.
    assert.deepEqual(assessAcceptance({ ...vector, layers: [...vector.layers].reverse() }), vector.expected);
  });
}

for (const vector of fixture.legacy_projection_vectors) {
  test(`display legacy projection: ${vector.id}`, () => {
    assert.deepEqual(projectLegacy(vector), vector.expected);
    assert.deepEqual(projectLegacy({ ...vector, candidates: [...vector.candidates].reverse() }), vector.expected);
  });
}

test('HTML5 and tag schemas expose semantic ordering and intersection authority', () => {
  for (const kind of ['html5', 'display_tag']) {
    const schema = JSON.parse(fs.readFileSync(
      path.join(ROOT, `static/schemas/source/formats/canonical/${kind}.json`), 'utf8',
    ));
    const validation = schema['x-adcp-validation'];
    assert.equal(validation.spec, 'docs/creative/canonical-formats.mdx#responsive-bounds-and-effective-acceptance');
    for (const key of ['responsive_bound_order', 'effective_acceptance_intersection', 'omitted_size_constraints']) {
      assert.equal(typeof validation.verifier_constraints[key], 'string', `${kind}: ${key}`);
    }
  }
});
