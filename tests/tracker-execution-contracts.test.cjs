const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const VECTORS = path.join(
  ROOT,
  'static/compliance/source/test-vectors/tracker-execution-contracts.json'
);
const VECTOR_SCHEMA = path.join(
  ROOT,
  'static/compliance/source/test-vectors/tracker-execution-contracts.schema.json'
);

function loadAllSchemas(ajv) {
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema, schema.$id);
      }
    }
  }
  walk(SCHEMAS);
}

function makeAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  addFormats(ajv);
  ajv.addFormat('uri-template', true);
  loadAllSchemas(ajv);
  return ajv;
}

const ajv = makeAjv();

const pixelSelector = (overrides = {}) => ({
  selector_id: 'pixel-impression',
  asset_type: 'pixel_tracker',
  event: 'impression',
  method: 'img',
  execution_actor: 'seller',
  firing_paths: ['client'],
  ...overrides
});

const vastSelector = (overrides = {}) => ({
  selector_id: 'vast-start',
  asset_type: 'vast_tracker',
  vast_versions: ['4.2'],
  vast_event: 'start',
  target: 'linear',
  execution_actor: 'request_executor',
  firing_paths: ['client'],
  ...overrides
});

const daastSelector = (overrides = {}) => ({
  selector_id: 'daast-start',
  asset_type: 'daast_tracker',
  daast_versions: ['1.1'],
  daast_event: 'start',
  target: 'linear',
  execution_actor: 'request_executor',
  firing_paths: ['client'],
  ...overrides
});

function selectorMatches(selector, tracker, executionVersion) {
  if (selector.asset_type !== tracker.asset_type) return false;
  if (selector.asset_type === 'pixel_tracker') {
    return selector.event === tracker.event &&
      selector.method === (tracker.method ?? 'img') &&
      selector.custom_event_name === tracker.custom_event_name;
  }
  if (selector.asset_type === 'vast_tracker') {
    const trackerOffset = tracker.vast_event === 'progress' ? tracker.offset : undefined;
    return selector.vast_event === tracker.vast_event &&
      selector.target === (tracker.target ?? 'linear') &&
      selector.offset === trackerOffset &&
      selector.vast_versions.includes(executionVersion);
  }
  const trackerOffset = tracker.daast_event === 'progress' ? tracker.offset : undefined;
  return selector.daast_event === tracker.daast_event &&
    selector.target === (tracker.target ?? 'linear') &&
    selector.offset === trackerOffset &&
    selector.daast_versions.includes(executionVersion);
}

function evaluateTracker(contract, tracker, executionVersion) {
  const selector = contract.honored.find(candidate =>
    selectorMatches(candidate, tracker, executionVersion)
  );
  if (selector) return { status: 'matched', selector_id: selector.selector_id };
  if (contract.complete) {
    return { status: 'rejected', rejection_code: 'tracker_contract_mismatch' };
  }
  return { status: 'undeclared' };
}

function structuralIdentity(selector) {
  const value = structuredClone(selector);
  delete value.selector_id;
  delete value.execution_actor;
  delete value.firing_paths;
  if (value.vast_versions) value.vast_versions.sort();
  if (value.daast_versions) value.daast_versions.sort();
  return JSON.stringify(value, Object.keys(value).sort());
}

function validateOperationalContract(contract) {
  const ids = new Set();
  const identities = new Set();
  for (const selector of contract.honored) {
    if (ids.has(selector.selector_id)) return 'duplicate_selector_id';
    ids.add(selector.selector_id);
    const identity = structuralIdentity(selector);
    if (identities.has(identity)) return 'duplicate_structural_identity';
    identities.add(identity);
  }

  for (let leftIndex = 0; leftIndex < contract.honored.length; leftIndex++) {
    const left = contract.honored[leftIndex];
    const leftVersions = left.vast_versions ?? left.daast_versions;
    if (!leftVersions) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < contract.honored.length; rightIndex++) {
      const right = contract.honored[rightIndex];
      const rightVersions = right.vast_versions ?? right.daast_versions;
      if (!rightVersions) continue;
      const leftWithoutVersions = structuredClone(left);
      const rightWithoutVersions = structuredClone(right);
      for (const value of [leftWithoutVersions, rightWithoutVersions]) {
        delete value.selector_id;
        delete value.execution_actor;
        delete value.firing_paths;
        delete value.vast_versions;
        delete value.daast_versions;
      }
      if (JSON.stringify(leftWithoutVersions) !== JSON.stringify(rightWithoutVersions)) continue;
      const overlap = leftVersions.some(version => rightVersions.includes(version));
      const equal = leftVersions.length === rightVersions.length &&
        leftVersions.every(version => rightVersions.includes(version));
      if (overlap && !equal) return 'overlapping_version_sets';
    }
  }
  return null;
}

test('tracker execution selector schema accepts only the three first-class 3.2 branches', () => {
  const validate = ajv.getSchema('/schemas/core/tracker-execution-selector.json');
  assert.ok(validate);
  assert.equal(validate(pixelSelector()), true, JSON.stringify(validate.errors));
  assert.equal(validate(vastSelector()), true, JSON.stringify(validate.errors));
  assert.equal(validate(daastSelector()), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    selector_id: 'generic-url',
    asset_type: 'url',
    event: 'impression',
    execution_actor: 'seller',
    firing_paths: ['client']
  }), false, 'URL-slot selectors are deferred from the 3.2 union');
});

test('pixel selector rejects invalid method, custom shape, actor, and path', () => {
  const validate = ajv.getSchema('/schemas/core/tracker-execution-selector.json');
  assert.equal(validate(pixelSelector({ method: 'js' })), false);
  assert.equal(validate(pixelSelector({ event: 'custom' })), false,
    'custom events require a qualified custom name');
  assert.equal(validate(pixelSelector({ custom_event_name: 'unexpected' })), false,
    'non-custom events forbid a custom name');
  assert.equal(validate(pixelSelector({ execution_actor: 'creative_agent' })), false);
  assert.equal(validate(pixelSelector({ firing_paths: [] })), false);
  assert.equal(validate(pixelSelector({ firing_paths: ['mixed'] })), false);

  const pixelAsset = JSON.parse(fs.readFileSync(
    path.join(SCHEMAS, 'core/assets/pixel-tracker-asset.json'),
    'utf8'
  ));
  const customSemantics = pixelAsset.properties.custom_event_name.description;
  assert.match(customSemantics, /complete:true/,
    'complete contracts must override the legacy unknown-custom no-op behavior');
  assert.match(customSemantics, /tracker_contract_mismatch/);
});

test('VAST selector enforces event, target, progress, and per-version constraints', () => {
  const validate = ajv.getSchema('/schemas/core/tracker-execution-selector.json');
  assert.equal(validate(vastSelector({ vast_event: 'creativeView' })), true,
    'creativeView is valid for linear VAST execution');
  assert.equal(validate(vastSelector({ vast_event: 'progress', offset: '25%' })), true,
    JSON.stringify(validate.errors));
  assert.equal(validate(vastSelector({ vast_event: 'progress' })), false);
  assert.equal(validate(vastSelector({ offset: '25%' })), false,
    'non-progress selectors forbid offset');
  assert.equal(validate(vastSelector({ vast_event: 'acceptInvitation', target: 'linear' })), false);
  assert.equal(validate(vastSelector({
    vast_event: 'acceptInvitation',
    target: 'companion'
  })), false, 'companion trackers accept only creativeView in the closed matrix');
  assert.equal(validate(vastSelector({
    vast_event: 'acceptInvitation',
    target: 'non_linear',
    vast_versions: ['4.2']
  })), true, JSON.stringify(validate.errors));
  assert.equal(validate(vastSelector({ vast_event: 'loaded', vast_versions: ['4.0'] })), false,
    'loaded is accepted only in its ratified exact versions');
  assert.equal(validate(vastSelector({ vast_event: 'impression' })), false,
    'VAST Impression is not a TrackingEvents selector');

  const validateAsset = ajv.getSchema('/schemas/core/assets/vast-tracker-asset.json');
  assert.equal(validateAsset({
    asset_type: 'vast_tracker',
    vast_event: 'creativeView',
    url: 'https://measurement.example/tracker'
  }), true, 'default linear VAST assets accept creativeView');
  for (const legacyAsset of [
    { vast_event: 'start', offset: '00:00:05.000' },
    { vast_event: 'close' },
    { vast_event: 'start', target: 'companion' }
  ]) {
    assert.equal(validateAsset({
      asset_type: 'vast_tracker',
      url: 'https://measurement.example/legacy',
      ...legacyAsset
    }), true, `existing 3.x VAST asset became invalid: ${JSON.stringify(legacyAsset)}`);
  }
  assert.deepEqual(evaluateTracker({
    complete: true,
    honored: [vastSelector()]
  }, {
    asset_type: 'vast_tracker',
    vast_event: 'start',
    offset: '00:00:05.000'
  }, '4.2'), {
    status: 'matched',
    selector_id: 'vast-start'
  }, 'ignored non-progress asset offsets are removed before contract matching');
});

test('DAAST selector enforces event, target, progress, and version shape', () => {
  const validate = ajv.getSchema('/schemas/core/tracker-execution-selector.json');
  assert.equal(validate(daastSelector({ daast_event: 'progress', offset: '00:00:05.000' })), true,
    JSON.stringify(validate.errors));
  assert.equal(validate(daastSelector({ daast_event: 'progress' })), false);
  assert.equal(validate(daastSelector({ offset: '10%' })), false);
  assert.equal(validate(daastSelector({ daast_event: 'start', target: 'companion' })), false);
  assert.equal(validate(daastSelector({
    daast_event: 'creativeView',
    target: 'companion'
  })), true, JSON.stringify(validate.errors));
  assert.equal(validate(daastSelector({ daast_versions: [] })), false);
  assert.equal(validate(daastSelector({ daast_versions: ['1.1', '1.1'] })), false);

  const validateFormat = ajv.getSchema('/schemas/formats/canonical/audio_daast.json');
  assert.equal(validateFormat({ daast_versions: ['1.0', '1.1'] }), true,
    JSON.stringify(validateFormat.errors));
  assert.equal(validateFormat({ daast_version: '1.1' }), true,
    'the deprecated singular alias remains valid for legacy declarations');
  assert.equal(validateFormat({ daast_versions: ['9.9'] }), false);
  assert.equal(validateFormat({ daast_version: '1.1', daast_versions: ['1.1'] }), false,
    'producers must not send the singular alias and plural acceptance set together');

  const validateAsset = ajv.getSchema('/schemas/core/assets/daast-tracker-asset.json');
  for (const legacyAsset of [
    { daast_event: 'start', offset: '10%' },
    { daast_event: 'start', target: 'companion' }
  ]) {
    assert.equal(validateAsset({
      asset_type: 'daast_tracker',
      url: 'https://measurement.example/legacy',
      ...legacyAsset
    }), true, `existing 3.x DAAST asset became invalid: ${JSON.stringify(legacyAsset)}`);
  }
});

test('complete and empty contract semantics validate and operational uniqueness stays closed', () => {
  const validate = ajv.getSchema('/schemas/core/tracker-execution-contract.json');
  assert.equal(validate({ complete: true, honored: [] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ complete: false, honored: [pixelSelector()] }), true,
    JSON.stringify(validate.errors));
  assert.equal(validate({ honored: [] }), false);
  assert.equal(validate({ complete: true }), false);

  assert.equal(validateOperationalContract({
    complete: true,
    honored: [pixelSelector(), pixelSelector({ event: 'click' })]
  }), 'duplicate_selector_id');
  assert.equal(validateOperationalContract({
    complete: true,
    honored: [pixelSelector(), pixelSelector({ selector_id: 'same-shape' })]
  }), 'duplicate_structural_identity');
  assert.equal(validateOperationalContract({
    complete: true,
    honored: [
      vastSelector({ selector_id: 'v42', vast_versions: ['4.2'] }),
      vastSelector({ selector_id: 'v42-v43', vast_versions: ['4.2', '4.3'] })
    ]
  }), 'overlapping_version_sets');
  assert.match(validate.schema['x-adcp-validation'].asset_normalization,
    /non-progress asset is ignored and removed/);
});

test('golden vectors normalize defaults, bind exact versions, and keep incomplete omissions undeclared', () => {
  const fixture = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  const validateFixture = ajv.compile(JSON.parse(fs.readFileSync(VECTOR_SCHEMA, 'utf8')));
  assert.equal(validateFixture(fixture), true, JSON.stringify(validateFixture.errors));

  for (const vector of fixture.vectors) {
    assert.deepEqual(
      evaluateTracker(vector.contract, vector.tracker, vector.execution_version),
      vector.expected,
      vector.name
    );
  }
});

test('contract-bearing products require stable option identity and authority projections strip contracts', () => {
  const contract = { complete: true, honored: [pixelSelector()] };
  const declaration = {
    format_option_id: 'acme-image',
    format_kind: 'image',
    params: { width: 300, height: 250 },
    tracker_execution_contract: contract
  };
  const validateDeclaration = ajv.getSchema('/schemas/core/product-format-declaration.json');
  assert.equal(validateDeclaration(declaration), true, JSON.stringify(validateDeclaration.errors));
  const { format_option_id: ignored, ...idless } = declaration;
  assert.equal(validateDeclaration(idless), false, 'seller execution authority must be addressable');

  const capabilities = ajv.getSchema('/schemas/protocol/get-adcp-capabilities-response.json').schema;
  const supportedFormatSchema = capabilities.properties.creative.properties.supported_formats.items;
  const validateSupportedFormat = ajv.compile(supportedFormatSchema);
  assert.equal(validateSupportedFormat({
    capability_id: 'image-build',
    operations: ['build'],
    format: { format_kind: 'image', params: { width: 300, height: 250 } }
  }), true, JSON.stringify(validateSupportedFormat.errors));
  assert.equal(validateSupportedFormat({
    capability_id: 'image-build',
    operations: ['build'],
    format: declaration
  }), false, 'creative capability self-description cannot acquire seller authority');

  const validateTransformer = ajv.getSchema('/schemas/core/transformer.json');
  const transformer = {
    transformer_id: 'image-transform',
    name: 'Image transform',
    input_formats: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
    output_capability_ids: ['image-build']
  };
  assert.equal(validateTransformer(transformer), true, JSON.stringify(validateTransformer.errors));
  assert.equal(validateTransformer({ ...transformer, input_formats: [declaration] }), false,
    'transformer inputs cannot acquire seller authority');
});

test('package snapshot digests bind the contract, product, format, placement, and exact execution version', async () => {
  const canonicalize = (await import('canonicalize')).default;
  const fixture = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  const snapshot = fixture.package_snapshot;
  const sha256 = value => `sha256:${crypto.createHash('sha256').update(canonicalize(value)).digest('hex')}`;
  const packageOnly = new Set([
    'product_id',
    'placement_refs',
    'execution_vast_version',
    'execution_daast_version',
    'tracker_execution_contract_digest',
    'product_snapshot_digest'
  ]);
  const format = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !packageOnly.has(key))
  );
  const preimage = {
    product_id: snapshot.product_id,
    format,
    placement_refs: snapshot.placement_refs,
    execution_vast_version: snapshot.execution_vast_version,
    tracker_execution_contract_digest: snapshot.tracker_execution_contract_digest
  };

  assert.equal(sha256(snapshot.tracker_execution_contract), snapshot.tracker_execution_contract_digest);
  assert.equal(sha256(preimage), snapshot.product_snapshot_digest);

  const validateSnapshot = ajv.getSchema('/schemas/core/package-format-snapshot.json');
  assert.equal(validateSnapshot(snapshot), true, JSON.stringify(validateSnapshot.errors));
  assert.equal(validateSnapshot({ ...snapshot, product_id: undefined }), false);
  assert.equal(validateSnapshot({ ...snapshot, format_option_id: undefined }), false);
  assert.equal(validateSnapshot({ ...snapshot, tracker_execution_contract_digest: undefined }), false);
  assert.equal(validateSnapshot({ ...snapshot, product_snapshot_digest: undefined }), false);
  assert.equal(validateSnapshot({
    format_kind: 'image',
    params: { width: 300, height: 250 },
    tracker_execution_contract_digest: snapshot.tracker_execution_contract_digest
  }), false, 'a contract digest cannot appear without its contract');

  const packageSchema = ajv.getSchema('/schemas/core/package.json').schema;
  assert.equal(
    packageSchema.properties.formats_to_provide.items.$ref,
    '/schemas/core/package-format-snapshot.json'
  );
  assert.equal(
    packageSchema.properties.formats_pending.items.$ref,
    '/schemas/core/package-format-snapshot.json'
  );
  assert.match(
    packageSchema.properties.formats_to_provide['x-adcp-validation']
      .verifier_constraints.snapshot_identity,
    /product_snapshot_digest is unique/
  );
});

test('representation resolution carries exact tracker execution versions and distinct mismatch reasons', () => {
  const destination = ajv.getSchema('/schemas/core/representation-destination.json');
  const baseDestination = {
    product_id: 'prod-video',
    format_option: {
      format_option_id: 'acme-vast',
      format_kind: 'video_vast',
      params: { vast_versions: ['4.2', '4.3'] },
      tracker_execution_contract: { complete: true, honored: [vastSelector()] }
    },
    execution_vast_version: '4.2'
  };
  assert.equal(destination(baseDestination), true, JSON.stringify(destination.errors));
  assert.equal(destination({ ...baseDestination, execution_vast_version: '4.4' }), false);

  const selection = ajv.getSchema('/schemas/core/representation-selection.json');
  const lineage = {
    creative_id: 'cr-video',
    revision_id: 'rev-1',
    revision_content_digest: `sha256:${'1'.repeat(64)}`,
    selected_representation_id: 'source-vast',
    strategy: 'representation_order',
    selected_output_digest: `sha256:${'2'.repeat(64)}`,
    execution_vast_version: '4.2',
    resolved_by: 'seller'
  };
  assert.equal(selection(lineage), true, JSON.stringify(selection.errors));
  assert.match(
    selection.schema['x-adcp-validation'].verifier_constraints.derived_output.review_identity,
    /execution_vast_version-or-null/
  );
  assert.match(
    selection.schema['x-adcp-validation'].verifier_constraints.derived_output.execution_version,
    /re-resolution and ordinary re-review/
  );

  const rejection = ajv.getSchema('/schemas/core/representation-rejection.json');
  assert.equal(rejection({
    representation_id: 'source-vast',
    code: 'tracker_contract_mismatch',
    message: 'The normalized tracker selector is not honored'
  }), true, JSON.stringify(rejection.errors));
  assert.equal(rejection({
    representation_id: 'source-vast',
    code: 'macro_unsupported',
    message: 'The tracker macro cannot be processed'
  }), true, JSON.stringify(rejection.errors));
});

test('tracker contract and supporting vocabularies are discoverable in the schema registry', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'index.json'), 'utf8'));
  const refs = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (typeof value.$ref === 'string') refs.push(value.$ref);
      Object.values(value).forEach(visit);
    }
  };
  visit(registry);
  for (const ref of [
    '/schemas/core/tracker-execution-contract.json',
    '/schemas/core/tracker-execution-selector.json',
    '/schemas/core/package-format-snapshot.json',
    '/schemas/enums/pixel-tracking-event.json',
    '/schemas/enums/tracker-execution-actor.json',
    '/schemas/enums/tracker-firing-path.json'
  ]) {
    assert.ok(refs.includes(ref), `${ref} must be discoverable in static/schemas/source/index.json`);
  }
});

test('package task references retain contract snapshots after creative coverage', () => {
  const createDocs = fs.readFileSync(
    path.join(ROOT, 'docs/media-buy/task-reference/create_media_buy.mdx'),
    'utf8'
  );
  const readDocs = fs.readFileSync(
    path.join(ROOT, 'docs/media-buy/task-reference/get_media_buys.mdx'),
    'utf8'
  );
  for (const docs of [createDocs, readDocs]) {
    assert.match(docs, /PackageFormatSnapshot/);
    assert.match(docs, /formats_to_provide/);
    assert.match(docs, /formats_pending/);
  }
  assert.match(createDocs, /remains present after upload or assignment/);
  assert.match(readDocs, /remains present after creative coverage is complete/);
});
