const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.resolve(__dirname, '..');
const schemaRoot = path.join(root, 'static/schemas/source');
const productRoot = path.join(root, 'static/examples/products/canonical');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const vectors = read(path.join(root, 'static/test-vectors/canonical-manifest-constructibility.json'));
const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true });
addFormats(ajv);
ajv.addFormat('uri-template', true);
function load(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) load(file);
    else if (entry.name.endsWith('.json')) {
      const schema = read(file);
      if (schema.$id) ajv.addSchema(schema);
    }
  }
}
load(schemaRoot);
const validateManifest = ajv.getSchema('/schemas/core/creative-manifest.json');

function assertSlots(option, assets) {
  const canonical = read(path.join(schemaRoot, 'formats/canonical', `${option.format_kind}.json`));
  const slots = option.params.slots ?? canonical.properties.slots?.default ?? [];
  const params = option.params;
  if (option.params.backup_image_required) {
    assert.equal(assets.backup_image?.asset_type, 'image', 'required backup must be supplied');
  }
  for (const slot of slots) {
    const supplied = assets[slot.asset_group_id];
    if (supplied === undefined) {
      assert.ok(!slot.required && !(params[`${slot.asset_group_id}_min`] > 0), `missing required slot ${slot.asset_group_id}`);
      continue;
    }
    const items = Array.isArray(supplied) ? supplied : [supplied];
    if (slot.max > 1 || slot.min > 1) assert.ok(Array.isArray(supplied), `${slot.asset_group_id} requires an array`);
    assert.ok(items.length >= Math.max(slot.min ?? 1, params[`${slot.asset_group_id}_min`] ?? 0), `${slot.asset_group_id}: too few values`);
    assert.ok(items.length <= Math.min(slot.max ?? Infinity, params[`${slot.asset_group_id}_max`] ?? Infinity), `${slot.asset_group_id}: too many values`);
    for (const asset of items) {
      assert.equal(asset.asset_type, slot.asset_type, slot.asset_group_id);
      if (asset.asset_type === 'image') {
        const sizes = params[`${slot.asset_group_id}_sizes`];
        if (sizes) assert.ok(sizes.some(size => size.width === asset.width && size.height === asset.height), `${slot.asset_group_id}: unsupported image size`);
        const ratios = slot.asset_group_id === 'logo'
          ? params.logo_aspect_ratios
          : params[`${slot.asset_group_id}_aspect_ratio`] ? [params[`${slot.asset_group_id}_aspect_ratio`]] : undefined;
        if (ratios) assert.ok(ratios.some(ratio => {
          const [width, height] = ratio.split(':').map(Number);
          return Math.abs(asset.width / asset.height - width / height) < 0.001;
        }), `${slot.asset_group_id}: unsupported image aspect ratio`);
      }
      if (asset.asset_type === 'daast' && params.daast_version) assert.equal(asset.daast_version, params.daast_version);
      if (asset.asset_type === 'vast' && params.vast_version) assert.equal(asset.vast_version, params.vast_version);
      if (slot.max_chars !== undefined && asset.content !== undefined) {
        assert.ok([...asset.content].length <= slot.max_chars, `${slot.asset_group_id}: text too long`);
      }
      if (asset.asset_type === 'video_brief' && option.params.duration_ms_exact !== undefined) {
        assert.equal(asset.segments.reduce((sum, segment) => sum + segment.duration_ms, 0), option.params.duration_ms_exact);
      }
    }
  }
  if (option.format_kind === 'seller_rendered_stateful_display' && option.params.supply_mode === 'rendered_canvases') {
    for (const state of option.params.states) {
      for (const breakpoint of state.breakpoints) {
        const canvases = assets.state_canvases.filter(asset =>
          asset.state_id === state.state_id && asset.breakpoint_id === breakpoint.breakpoint_id);
        assert.equal(canvases.length, 1, `${state.state_id}/${breakpoint.breakpoint_id}: canvas coverage`);
        assert.equal(canvases[0].width, breakpoint.width);
        assert.equal(canvases[0].height, breakpoint.height);
      }
    }
  }
}

test('every reference product option has a saved manifest or an explicit unresolved custom contract', () => {
  const expected = [];
  for (const name of fs.readdirSync(productRoot).filter(name => name.endsWith('.json'))) {
    read(path.join(productRoot, name)).format_options.forEach((_, index) => expected.push(`${name}:${index}`));
  }
  const actual = vectors.cases.map(row => `${row.product_fixture}:${row.option_index}`);
  assert.equal(new Set(actual).size, actual.length, 'duplicate constructibility examples');
  assert.deepEqual(actual.sort(), expected.sort(), 'new products/options need manifest examples');
});

for (const row of vectors.cases) {
  test(`reference manifest: ${row.product_fixture}:${row.option_index}`, () => {
    const product = read(path.join(productRoot, row.product_fixture));
    const option = product.format_options[row.option_index];
    if (row.unresolved_custom_schema) {
      assert.equal(option.format_kind, 'custom');
      assert.equal(row.product_fixture, 'nytimes_homepage_takeover_custom.json', 'new unresolved custom fixtures need explicit review');
      assert.ok(row.unresolved_custom_schema.length > 40);
      assert.equal(row.manifest, undefined, 'unresolved contracts must not pretend to have an accepted manifest');
      return;
    }
    const manifest = row.manifest;
    assert.equal(manifest.format_kind, option.format_kind);
    assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
    assertSlots(option, manifest.assets);
    for (const component of option.params.components ?? []) {
      if (option.format_kind !== 'coordinated_placements' || !component.required) continue;
      const child = component.format_option_ref
        ? product.format_options.find(candidate => candidate.format_option_id === component.format_option_ref.format_option_id)
        : component;
      assert.ok(child, component.component_id);
      assertSlots(child, manifest.component_assets[component.component_id]);
    }
  });
}

test('all supported slot names validate asset shapes, including arrays and noncanonical names', () => {
  const validators = [
    ajv.getSchema('/schemas/core/creative-assets.json'),
    assets => validateManifest({ format_kind: 'html5', assets }),
    assets => ajv.getSchema('/schemas/core/creative-asset.json')({ creative_id: 'acme-banner', name: 'Acme', format_kind: 'html5', assets }),
    assets => ajv.getSchema('/schemas/creative/list-creatives-response.json')({
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{ creative_id: 'acme-banner', name: 'Acme', format_kind: 'html5', status: 'approved',
        created_date: '2026-10-18T00:00:00Z', updated_date: '2026-10-18T00:00:00Z', assets }]
    })
  ];
  for (const name of ['html5_bundle', 'Hero-Asset', 'hero.asset', 'Hero Asset', '画像', '', '\n']) {
    for (const validate of validators) {
      const valid = { asset_type: 'zip', url: 'https://cdn.acme.example/banner.zip', width: 300, height: 250 };
      assert.equal(validate({ [name]: valid }), true, name);
      assert.equal(validate({ [name]: [valid] }), true, name);
      for (const invalid of [null, 5, {}, [], { asset_type: 'zip' }, { ...valid, height: undefined }]) {
        assert.equal(validate({ [name]: invalid }), false, `${JSON.stringify(name)}: ${JSON.stringify(invalid)}`);
        assert.equal(validate({ [name]: [invalid] }), false, `${JSON.stringify(name)}: invalid array member`);
      }
    }
  }
});

test('video briefs retain structured validation inside manifests and repeatable slots', () => {
  const valid = { asset_type: 'video_brief', segments: [{ order: 1, duration_ms: 15000, prompt: 'Acme on a forest trail.' }] };
  for (const asset of [valid, [valid]]) {
    assert.equal(validateManifest({ format_kind: 'video_hosted', assets: { video_brief: asset } }), true, JSON.stringify(validateManifest.errors));
  }
  for (const invalid of [{ asset_type: 'video_brief' }, { asset_type: 'video_brief', segments: [] }, { ...valid, segments: [{ order: 1, duration_ms: 0 }] }]) {
    assert.equal(validateManifest({ format_kind: 'video_hosted', assets: { video_brief: invalid } }), false);
  }
});
