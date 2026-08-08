const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const root = path.resolve(__dirname, '..');
const schemasDir = path.join(root, 'static/schemas/source');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function loadSchemas(ajv, directory = schemasDir) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      loadSchemas(ajv, full);
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!schema.$id) continue;
    try {
      ajv.addSchema(schema, schema.$id);
    } catch (error) {
      if (!/already exists/.test(error.message)) throw error;
    }
  }
}

const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
addFormats(ajv);
ajv.addFormat('uri-template', true);
loadSchemas(ajv);

const validateProduct = ajv.getSchema('/schemas/core/product.json');
const validateDeclaration = ajv.getSchema('/schemas/core/product-format-declaration.json');
const validatePageTakeover = ajv.getSchema('/schemas/formats/canonical/page_takeover.json');
const validateManifest = ajv.getSchema('/schemas/core/creative-manifest.json');

const leaderboardProduct = readJson('static/examples/products/canonical/streamhaus_expandable_sticky_leaderboard.json');
const takeoverProduct = readJson('static/examples/products/canonical/streamhaus_page_takeover.json');
const leaderboardParams = leaderboardProduct.format_options[0].params;

function canvasAssetsFor(params) {
  return params.states.flatMap(state => state.breakpoints.map(breakpoint => ({
    asset_type: 'image',
    url: `https://cdn.streamhaus.example/${state.state_id}-${breakpoint.breakpoint_id}.png`,
    state_id: state.state_id,
    breakpoint_id: breakpoint.breakpoint_id,
    width: breakpoint.width,
    height: breakpoint.height ?? breakpoint.height_range[0],
  })));
}

function validateStateCanvases(params, assets) {
  const violations = [];
  const requiredPairs = new Map();
  const stateIds = new Set();
  for (const state of params.states ?? []) {
    if (stateIds.has(state.state_id)) violations.push(`duplicate_state:${state.state_id}`);
    stateIds.add(state.state_id);
    const breakpointIds = new Set();
    for (const breakpoint of state.breakpoints ?? []) {
      if (breakpointIds.has(breakpoint.breakpoint_id)) {
        violations.push(`duplicate_breakpoint:${state.state_id}:${breakpoint.breakpoint_id}`);
      }
      breakpointIds.add(breakpoint.breakpoint_id);
      if (breakpoint.height_range && breakpoint.height_range[0] > breakpoint.height_range[1]) {
        violations.push(`invalid_height_range:${state.state_id}:${breakpoint.breakpoint_id}`);
      }
      requiredPairs.set(`${state.state_id}:${breakpoint.breakpoint_id}`, breakpoint);
    }
  }

  const seenPairs = new Set();
  for (const asset of assets ?? []) {
    const key = `${asset.state_id}:${asset.breakpoint_id}`;
    const breakpoint = requiredPairs.get(key);
    if (!breakpoint) {
      violations.push(`extra_canvas:${key}`);
      continue;
    }
    if (seenPairs.has(key)) violations.push(`duplicate_canvas:${key}`);
    seenPairs.add(key);
    if (asset.width !== breakpoint.width) violations.push(`canvas_width:${key}`);
    if (breakpoint.height !== undefined && asset.height !== breakpoint.height) {
      violations.push(`canvas_height:${key}`);
    }
    if (breakpoint.height_range && (
      asset.height < breakpoint.height_range[0] || asset.height > breakpoint.height_range[1]
    )) {
      violations.push(`canvas_height_range:${key}`);
    }
  }
  for (const key of requiredPairs.keys()) {
    if (!seenPairs.has(key)) violations.push(`missing_canvas:${key}`);
  }
  return violations;
}

function resolveComponentRef(product, ref) {
  return product.format_options.find(option => {
    if (option.format_option_id !== ref.format_option_id) return false;
    if (ref.scope === 'publisher') return option.publisher_domain === ref.publisher_domain;
    return ref.scope === 'product' && option.publisher_domain === undefined;
  });
}

function validatePageTakeoverSemantics(product, declaration) {
  const violations = [];
  const components = declaration.params.components ?? [];
  const componentIds = new Set();
  for (const component of components) {
    if (componentIds.has(component.component_id)) violations.push(`duplicate_component:${component.component_id}`);
    componentIds.add(component.component_id);
    if (component.format_option_ref) {
      const resolved = resolveComponentRef(product, component.format_option_ref);
      if (!resolved) {
        violations.push(`unresolved_format_option_ref:${component.component_id}`);
      } else if (resolved.format_kind === 'custom' || resolved.format_kind === 'page_takeover') {
        violations.push(`forbidden_component_kind:${component.component_id}:${resolved.format_kind}`);
      }
    }
  }
  for (const slot of declaration.params.shared_slots ?? []) {
    for (const componentId of slot.consumed_by ?? []) {
      if (!componentIds.has(componentId)) {
        violations.push(`unknown_consumed_by:${slot.asset_group_id}:${componentId}`);
      }
    }
  }
  return violations;
}

function promotedShapeWarning(declaration, vocabulary) {
  if (declaration.format_kind !== 'custom') return undefined;
  const entry = vocabulary[declaration.format_shape];
  if (!entry?.promoted_to) return undefined;
  return {
    code: 'FORMAT_SHAPE_PROMOTED',
    format_shape: declaration.format_shape,
    promoted_to: entry.promoted_to,
    promotion_release: entry.promotion_release,
    transition_end: entry.transition_end,
  };
}

test('worked premium-display products validate against the product schema', () => {
  assert.equal(validateProduct(leaderboardProduct), true, JSON.stringify(validateProduct.errors));
  assert.equal(validateProduct(takeoverProduct), true, JSON.stringify(validateProduct.errors));
});

test('multi_state_display requires exactly one correctly-sized canvas per state and breakpoint', () => {
  const valid = canvasAssetsFor(leaderboardParams);
  assert.deepEqual(validateStateCanvases(leaderboardParams, valid), []);

  assert.ok(validateStateCanvases(leaderboardParams, valid.slice(1)).some(v => v.startsWith('missing_canvas:')));
  assert.ok(validateStateCanvases(leaderboardParams, [...valid, valid[0]]).some(v => v.startsWith('duplicate_canvas:')));
  assert.ok(validateStateCanvases(leaderboardParams, [
    ...valid,
    { ...valid[0], state_id: 'undeclared' },
  ]).some(v => v.startsWith('extra_canvas:')));
  assert.ok(validateStateCanvases(leaderboardParams, [
    { ...valid[0], width: valid[0].width + 1 },
    ...valid.slice(1),
  ]).some(v => v.startsWith('canvas_width:')));
});

test('page_takeover resolves sibling options and validates shared-slot consumers', () => {
  const declaration = takeoverProduct.format_options.find(option => option.format_kind === 'page_takeover');
  assert.deepEqual(validatePageTakeoverSemantics(takeoverProduct, declaration), []);

  const missingRef = structuredClone(declaration);
  missingRef.params.components[0].format_option_ref.format_option_id = 'missing';
  assert.ok(validatePageTakeoverSemantics(takeoverProduct, missingRef).includes('unresolved_format_option_ref:leaderboard'));

  const badConsumer = structuredClone(declaration);
  badConsumer.params.shared_slots[0].consumed_by.push('missing_component');
  assert.ok(validatePageTakeoverSemantics(takeoverProduct, badConsumer).includes('unknown_consumed_by:video_main:missing_component'));
});

test('page_takeover schema forbids nesting, custom inline components, and mixed inline/reference declarations', () => {
  const base = {
    components: [{
      component_id: 'nested',
      placement_role: 'skin',
      required: true,
      format_kind: 'page_takeover',
      params: {},
    }],
    exclusivity: 'named_slots',
  };
  assert.equal(validatePageTakeover(base), false);
  assert.equal(validatePageTakeover({
    ...base,
    components: [{ ...base.components[0], format_kind: 'custom' }],
  }), false);
  assert.equal(validatePageTakeover({
    ...base,
    components: [{
      ...base.components[0],
      format_kind: 'image',
      params: { width: 300 },
    }],
  }), false, 'inline component params must validate against the selected canonical');
  assert.equal(validatePageTakeover({
    ...base,
    components: [{
      ...base.components[0],
      format_kind: 'image',
      params: { width: 300, height: 250 },
      format_option_ref: { scope: 'product', format_option_id: 'sibling' },
    }],
  }), false);
});

test('product declaration union exposes both 3.2 canonical kinds', () => {
  const multiState = { format_kind: 'multi_state_display', params: leaderboardParams };
  const pageTakeover = takeoverProduct.format_options.find(option => option.format_kind === 'page_takeover');
  assert.equal(validateDeclaration(multiState), true, JSON.stringify(validateDeclaration.errors));
  assert.equal(validateDeclaration(pageTakeover), true, JSON.stringify(validateDeclaration.errors));
  assert.equal(validateDeclaration({ format_kind: 'multi_state_display', params: {} }), false);
  assert.equal(validateDeclaration({ format_kind: 'page_takeover', params: {} }), false);
});

test('page takeover manifests namespace component assets', () => {
  assert.equal(validateManifest({
    format_kind: 'page_takeover',
    assets: {},
    component_assets: {
      masthead: {
        image_main: {
          asset_type: 'image',
          url: 'https://cdn.streamhaus.example/masthead.png',
          width: 970,
          height: 250,
        },
      },
      skin: {
        image_main: {
          asset_type: 'image',
          url: 'https://cdn.streamhaus.example/skin.png',
          width: 2560,
          height: 1440,
        },
      },
    },
  }), true, JSON.stringify(validateManifest.errors));
});

test('promoted custom shapes produce structured migration warnings for at least 90 days', () => {
  const vocabulary = readJson('static/schemas/source/core/format-shape-vocabulary.json').vocabulary;
  for (const [shape, promotedTo] of [
    ['multi_state_display', 'multi_state_display'],
    ['multi_placement_takeover', 'page_takeover'],
    ['roadblock', 'page_takeover'],
  ]) {
    const entry = vocabulary[shape];
    const transitionDays = (Date.parse(entry.transition_end) - Date.parse(entry.promotion_start)) / 86_400_000;
    assert.ok(transitionDays >= 90, `${shape} transition is only ${transitionDays} days`);
    assert.deepEqual(promotedShapeWarning({ format_kind: 'custom', format_shape: shape }, vocabulary), {
      code: 'FORMAT_SHAPE_PROMOTED',
      format_shape: shape,
      promoted_to: promotedTo,
      promotion_release: '3.2',
      transition_end: '2027-01-31',
    });
  }
});
