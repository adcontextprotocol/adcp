const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');
const FIELD = 'start_requires_all_creatives_approved';

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, name), 'utf8'));
}

const surfaces = [
  ['media-buy/package-request.json', schema => schema, {
    product_id: 'streamhaus_video', pricing_option_id: 'cpm_usd',
    creative_assignments: [{ creative_id: 'launch_video' }],
  }],
  ['media-buy/package-update.json', schema => schema, { package_id: 'pkg_launch' }],
  ['media-buy/package-control.json', schema => schema, { package_id: 'pkg_launch', paused: false }],
  ['core/package.json', schema => schema, { package_id: 'pkg_launch' }],
  ['media-buy/get-media-buys-response.json',
    schema => schema.properties.media_buys.items.properties.packages.items,
    { package_id: 'pkg_launch' }],
];

for (const [name, select, legacy] of surfaces) {
  test(`${name}: creative start gate accepts both booleans and preserves legacy payloads`, async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async uri => {
      assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
      return readSchema(uri.slice('/schemas/'.length));
    } });
    addFormats(ajv);
    const validate = await ajv.compileAsync(select(readSchema(name)));
    for (const payload of [legacy, { ...legacy, [FIELD]: false }, { ...legacy, [FIELD]: true }]) {
      assert.equal(validate(payload), true, JSON.stringify(validate.errors));
    }
    for (const value of [null, 'true', 'false', 0, 1, [], {}]) {
      assert.equal(validate({ ...legacy, [FIELD]: value }), false, `accepted ${JSON.stringify(value)}`);
    }
  });
}

test('create, update, and both read surfaces carry the same initial-start contract', () => {
  for (const [name, select] of surfaces) {
    const schema = select(readSchema(name));
    const field = schema.properties[FIELD];
    assert.equal(field['x-added-in'], '3.3.0', name);
    assert.ok(!schema.required?.includes(FIELD), name);
    // Defaults apply to creation/readback. Applying one to a sparse update
    // would release a stored gate when a buyer changes an unrelated field.
    const sparseControl = name.endsWith('package-update.json') || name.endsWith('package-control.json');
    assert.equal(field.default, sparseControl ? undefined : false, name);
    const annotation = field['x-adcp-validation'];
    assert.equal(annotation.spec,
      'docs/media-buy/specification.mdx#starting-with-assigned-creatives-under-review', name);
    const policy = annotation.verifier_constraints.creative_start_policy;
    assert.equal(policy.default, 'serve_approved_subset', name);
    assert.equal(policy.true_gate, 'all_current_assignments_approved_in_all_applicable_scopes', name);
    assert.equal(policy.empty_assignments, 'gate_unsatisfied', name);
    assert.equal(policy.evaluation_window, 'before_first_package_enablement', name);
    assert.equal(policy.review_rejection, 'retain_assignment', name);
    assert.equal(policy.readback, 'echo_effective_policy', name);
    assert.equal(policy.unsupported_true, 'UNSUPPORTED_FEATURE', name);
  }
});

test('compound create and update use the package schemas that define the gate', () => {
  const create = readSchema('media-buy/create-media-buy-request.json');
  const update = readSchema('media-buy/update-media-buy-request.json');
  assert.equal(create.properties.packages.items.$ref, '/schemas/media-buy/package-request.json');
  assert.equal(update.properties.new_packages.items.$ref, '/schemas/media-buy/package-request.json');
  assert.equal(update.properties.packages.items.$ref, '/schemas/media-buy/package-update.json');
  const success = readSchema('media-buy/create-media-buy-response.json').oneOf[0];
  assert.equal(success.properties.packages.items.$ref, '/schemas/core/package.json');
  const updated = readSchema('media-buy/update-media-buy-response.json').oneOf[0];
  assert.equal(updated.properties.affected_packages.items.$ref, '/schemas/core/package.json');
  const control = readSchema('media-buy/control-media-buy-request.json');
  assert.equal(control.properties.packages.items.$ref, '/schemas/media-buy/package-control.json');
});

test('the compact gate is a standalone control and is exclusive with cancellation', async () => {
  const ajv = new Ajv({ strict: false, loadSchema: async uri => readSchema(uri.slice('/schemas/'.length)) });
  addFormats(ajv);
  const validate = await ajv.compileAsync(readSchema('media-buy/package-control.json'));
  for (const value of [true, false]) {
    assert.equal(validate({ package_id: 'pkg_launch', [FIELD]: value }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ package_id: 'pkg_launch', canceled: true, [FIELD]: value }), false);
  }
  assert.equal(validate({ package_id: 'pkg_launch' }), false, 'a package ID alone is not a control');
});

test('initial creative gating is discoverable through the shared media-buy features contract', async () => {
  const features = readSchema('core/media-buy-features.json');
  const ajv = new Ajv({ strict: false, loadSchema: async uri => readSchema(uri.slice('/schemas/'.length)) });
  addFormats(ajv);
  const validate = await ajv.compileAsync(features);
  assert.equal(validate({ creative_start_policy: true }), true);
  assert.equal(validate({ creative_start_policy: false }), true);
  assert.equal(validate({ creative_start_policy: 'true' }), false);
  assert.equal(features.properties.creative_start_policy['x-added-in'], '3.3.0');
  assert.equal(features.properties.creative_start_policy.default, false);
  const capabilities = readSchema('protocol/get-adcp-capabilities-response.json');
  assert.equal(capabilities.properties.media_buy.properties.features.allOf[0].$ref,
    '/schemas/core/media-buy-features.json');
});

test('startup policy has its own structured action without overloading creative assignment routing', async () => {
  const schema = readSchema('core/media-buy-available-action-id.json');
  const ajv = new Ajv({ strict: false, loadSchema: async uri => readSchema(uri.slice('/schemas/'.length)) });
  const validate = await ajv.compileAsync(schema);
  assert.equal(validate('update_creative_start_policy'), true);
  assert.deepEqual(schema.enumMetadata.update_creative_start_policy.update_fields,
    [`packages[].${FIELD}`]);
  assert.equal(readSchema('enums/media-buy-valid-action.json').enum.includes('update_creative_start_policy'), false,
    'new actions belong to the structured surface, not the deprecated flat enum');
});

test('startup policy routes through canonical control and cannot become a commercial change right', async () => {
  const ajv = new Ajv({ strict: false, loadSchema: async uri => readSchema(uri.slice('/schemas/'.length)) });
  addFormats(ajv);
  const validateAction = await ajv.compileAsync(readSchema('core/canonical-media-buy-action.json'));
  const action = {
    action: 'update_creative_start_policy', task: 'control_media_buy', mode: 'self_serve',
    applicable_package_ids: ['pkg_launch'],
  };
  assert.equal(validateAction(action), true, JSON.stringify(validateAction.errors));
  const unscoped = { ...action };
  delete unscoped.applicable_package_ids;
  assert.equal(validateAction(unscoped), false);
  assert.equal(validateAction({ ...action, change_term_id: 'commercial_right' }), false);
  assert.equal(validateAction({ ...action, terms_ref: 'commercial_right' }), false);
  assert.equal(validateAction({ ...action, task: 'sync_creatives' }), false);
  assert.equal(validateAction({ ...action, task: 'refine_proposals' }), false);
  const validateCompatibilityAction = await ajv.compileAsync(readSchema('core/media-buy-available-action.json'));
  assert.equal(validateCompatibilityAction(action), true, JSON.stringify(validateCompatibilityAction.errors));
  assert.equal(validateCompatibilityAction(unscoped), false);
  assert.equal(validateCompatibilityAction({ ...action, task: 'sync_creatives' }), false);
  assert.equal(validateCompatibilityAction({ ...action, change_term_id: 'commercial_right' }), false);
  const validateTerm = await ajv.compileAsync(readSchema('media-buy/change-term.json'));
  assert.equal(validateTerm({ term_id: 'startup_policy', action: action.action, service_mode: 'self_serve' }), false,
    'an operational startup control is outside the commercial proposal digest');
});
