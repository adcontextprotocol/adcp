'use strict';

// Proves the retained get_products facade storyboards (#7403) mechanically:
// each runs through the published storyboard runner against a stub seller.
// A conformant seller passes on either branch the spec allows (honor the
// field, or reject it at its original path). A seller with exactly one defect
// fails, and only the graded step and the closing assertion go red.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const YAML = require('yaml');
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');

const root = path.join(__dirname, '..');
const scenarios = path.join(root, 'static/compliance/source/protocols/media-buy/scenarios');
const TOOLS = ['get_products', 'comply_test_controller'];
const SEED_SCENARIOS = ['seed_account', 'seed_product', 'seed_pricing_option'];

function file(name) {
  return path.join(scenarios, `legacy_get_products_${name}.yaml`);
}

function scenario(name) {
  const storyboard = loadStoryboardFile(file(name));
  // These checks isolate the facade obligation. Every stub page still carries
  // the product schema's required fields, and the training-agent matrix and
  // the sample-request lint cover schema conformance.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = step.validations.filter(validation => validation.check !== 'response_schema');
    }
  }
  return storyboard;
}

function canonicalAgent(url) {
  return new URL(url).origin.toLowerCase();
}

const FORMAT_PARAMETERS = ['width', 'height', 'duration_ms', 'pixel_ratio'];
const matchers = {
  exact: (actual, wanted) => actual.id === wanted.id
    && canonicalAgent(actual.agent_url) === canonicalAgent(wanted.agent_url)
    && FORMAT_PARAMETERS.every(key => wanted[key] === undefined || actual[key] === undefined || actual[key] === wanted[key]),
  slug_only: (actual, wanted) => actual.id === wanted.id,
  ignores_parameters: (actual, wanted) => actual.id === wanted.id
    && canonicalAgent(actual.agent_url) === canonicalAgent(wanted.agent_url),
  ignores_agent: (actual, wanted) => actual.id === wanted.id
    && FORMAT_PARAMETERS.every(key => wanted[key] === undefined || actual[key] === wanted[key]),
};

// Compact product-fields, read from the schema so the intersection defect
// tracks the real enum.
const compactFields = new Set(JSON.parse(fs.readFileSync(
  path.join(root, 'static/schemas/source/media-buy/product-fields.json'), 'utf8')).items.enum);
// Required by the served product schema, including its format_ids/format_options anyOf.
const MANDATORY = ['product_id', 'name', 'description', 'publisher_properties', 'delivery_type', 'pricing_options', 'reporting_capabilities', 'format_ids', 'format_options'];

function seller({ defect, reject, order = 'fixture', pageSize } = {}) {
  const calls = [];
  const products = new Map();
  const reads = [];
  function catalog() {
    const list = structuredClone([...products.values()]);
    if (order === 'id') list.sort((a, b) => a.product_id.localeCompare(b.product_id));
    if (order === 'reverse') list.reverse();
    return list;
  }
  function page(list, request) {
    const size = request.pagination?.max_results ?? pageSize ?? list.length;
    const offset = Number(request.pagination?.cursor ?? 0);
    const slice = list.slice(offset, offset + size);
    const hasMore = offset + size < list.length;
    return { slice, pagination: { has_more: hasMore, ...(hasMore ? { cursor: String(offset + size) } : {}) } };
  }
  function getProducts(request) {
    reads.push(structuredClone(request));
    if (reject) return { success: false, error: `UNSUPPORTED_FEATURE: ${reject}`, data: {
      status: 'failed',
      adcp_error: { code: 'UNSUPPORTED_FEATURE', message: `Cannot honor ${reject}.`, recovery: 'correctable', field: reject },
    } };
    let list = catalog();
    let paginateFirst = false;
    const wanted = request.filters?.format_ids;
    if (wanted) {
      const matcher = matchers[defect] ?? matchers.exact;
      if (defect === 'drops_format_filter') { /* returns the unfiltered feed */ } else if (defect === 'filters_after_pagination') paginateFirst = true;
      else list = list.filter(product => product.format_ids?.some(actual => wanted.some(w => matcher(actual, w))));
      if (paginateFirst) {
        const first = page(list.sort((a, b) => a.product_id.localeCompare(b.product_id)), request);
        const filtered = first.slice.filter(product => product.format_ids?.some(actual => wanted.some(w => matchers.exact(actual, w))));
        return { success: true, data: { status: 'completed', products: filtered, pagination: first.pagination, cache_scope: 'account' } };
      }
    }
    if (request.preferred_delivery_types && defect === 'preference_as_exclusion') {
      list = list.filter(product => request.preferred_delivery_types.includes(product.delivery_type));
    }
    if (request.buying_mode === 'refine') {
      let entries = request.refine;
      if (defect === 'truncates_at_compact_limit') entries = entries.slice(0, 25);
      if (defect === 'keeps_last_compact_batch') entries = entries.slice(-25);
      if (defect === 'answers_second_split_commit') entries = entries.slice(25);
      const included = new Set(entries.filter(entry => entry.scope === 'product' && (entry.action ?? 'include') === 'include').map(entry => entry.product_id));
      list = list.filter(product => included.has(product.product_id));
    }
    if (request.fields) {
      const requested = defect === 'compact_intersection'
        ? request.fields.filter(field => compactFields.has(field))
        : request.fields;
      const keep = new Set([...MANDATORY, ...requested]);
      list = list.map(product => Object.fromEntries(Object.entries(product).filter(([key]) => keep.has(key))));
    }
    const { slice, pagination } = page(list, request);
    return { success: true, data: { status: 'completed', products: slice, pagination, cache_scope: 'account' } };
  }
  const client = {
    resetContext() {},
    async executeTask(task, request) {
      calls.push({ task, request: structuredClone(request) });
      if (task === 'get_products') return getProducts(request);
      assert.equal(task, 'comply_test_controller');
      if (request.scenario === 'seed_product') {
        products.set(request.params.product_id, {
          product_id: request.params.product_id,
          name: `Facade fixture ${request.params.product_id}`,
          description: 'Controller-seeded inventory for the retained get_products facade.',
          publisher_properties: [{ publisher_domain: 'acmeoutdoor.example', selection_type: 'all' }],
          reporting_capabilities: {
            available_reporting_frequencies: ['daily'], expected_delay_minutes: 60,
            timezone: 'UTC', supports_webhooks: false, available_metrics: ['impressions', 'spend'],
            date_range_support: 'date_range',
          },
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: 'display_image', width: 300, height: 250 }],
          ...structuredClone(request.params.fixture),
          pricing_options: [],
        });
      }
      if (request.scenario === 'seed_pricing_option') {
        products.get(request.params.product_id).pricing_options.push({
          pricing_option_id: request.params.pricing_option_id, ...request.params.fixture,
        });
      }
      return { success: true, data: {
        success: true, scenario: request.scenario,
        ...(request.scenario === 'list_scenarios' ? { scenarios: SEED_SCENARIOS } : {}),
        context: request.context,
      } };
    },
    async getProducts(request) {
      return this.executeTask('get_products', request);
    },
  };
  return { client, calls, reads };
}

async function run(name, options = {}, buyingModes = ['brief', 'wholesale', 'refine']) {
  const { client, calls, reads } = seller(options);
  const result = await runStoryboard('https://seller.example/mcp', scenario(name), {
    protocol: 'mcp',
    agentTools: TOOLS,
    _profile: { tools: TOOLS, raw_capabilities: { media_buy: { buying_modes: buyingModes } } },
    _controllerCapabilities: { detected: true, scenarios: SEED_SCENARIOS },
    _client: client,
  });
  return { result, calls, reads };
}

function steps(result) {
  return result.phases.flatMap(phase => phase.steps);
}

function failedSteps(result) {
  return steps(result).filter(step => !step.passed && !step.skipped).map(step => step.step_id);
}

function failedChecks(result, stepId) {
  return steps(result).find(step => step.step_id === stepId).validations.filter(validation => !validation.passed);
}

const SCENARIOS = {
  format_ids: {
    honored: 'legacy_format_ids_evaluated', rejected: 'legacy_format_ids_rejected',
    assert: 'assert_legacy_format_ids_handled', field: 'filters.format_ids',
    defects: ['slug_only', 'ignores_parameters', 'ignores_agent', 'drops_format_filter', 'filters_after_pagination'],
  },
  preferred_delivery_types: {
    honored: 'legacy_preference_preserved', rejected: 'legacy_preference_rejected',
    assert: 'assert_legacy_preferred_delivery_types_handled', field: 'preferred_delivery_types',
    defects: ['preference_as_exclusion'],
  },
  fields: {
    honored: 'legacy_fields_projected', rejected: 'legacy_fields_rejected',
    assert: 'assert_legacy_fields_handled', field: 'fields',
    defects: ['compact_intersection'],
  },
  refine_batch: {
    honored: 'legacy_refine_batch_applied', rejected: 'legacy_refine_batch_rejected',
    assert: 'assert_legacy_refine_batch_handled', field: 'refine',
    defects: ['truncates_at_compact_limit', 'keeps_last_compact_batch', 'answers_second_split_commit'],
  },
};

for (const [name, spec] of Object.entries(SCENARIOS)) {
  for (const order of ['fixture', 'id', 'reverse']) {
    test(`${name}: a seller that honors the field passes (${order} order)`, async () => {
      const { result, reads } = await run(name, { order, pageSize: 2 });
      assert.equal(result.overall_passed, true, JSON.stringify(failedSteps(result)));
      assert.equal(steps(result).find(step => step.step_id === spec.rejected).skip?.reason, 'peer_branch_taken');
      assert.ok(reads.length >= 2, 'both branches send the authored request');
    });
  }

  test(`${name}: a seller that rejects at ${spec.field} passes`, async () => {
    const { result } = await run(name, { reject: spec.field });
    assert.equal(result.overall_passed, true, JSON.stringify(failedSteps(result)));
    assert.equal(steps(result).find(step => step.step_id === spec.honored).skip?.reason, 'peer_branch_taken');
  });

  test(`${name}: a rejection at another path does not count`, async () => {
    const { result } = await run(name, { reject: 'brand' });
    assert.equal(result.overall_passed, false);
    assert.deepEqual(failedChecks(result, spec.rejected).map(check => check.check), ['field_pattern']);
  });

  for (const defect of spec.defects) {
    for (const order of ['fixture', 'id', 'reverse']) {
      test(`${name}: ${defect} fails only the graded step (${order} order)`, async () => {
        const { result } = await run(name, { defect, order, pageSize: 2 });
        assert.equal(result.overall_passed, false, `${defect} must not pass`);
        assert.deepEqual(failedSteps(result), [spec.honored, spec.rejected, spec.assert]);
        const honored = failedChecks(result, spec.honored);
        assert.ok(honored.length >= 1);
        assert.ok(honored.every(check => ['field_value', 'field_absent', 'field_contains'].includes(check.check)),
          JSON.stringify(honored));
        // The rejection branch fails because the seller answered, not for an
        // unrelated reason.
        assert.equal(failedChecks(result, spec.rejected)[0].check, 'field_absent');
      });
    }
  }
}

test('format_ids: one negative control per identity component catches its own defect', async () => {
  for (const [defect, leaked] of [['ignores_parameters', 'format_ids_b_parameters'], ['ignores_agent', 'format_ids_a_agent']]) {
    const { result } = await run('format_ids', { defect });
    const step = steps(result).find(candidate => candidate.step_id === 'legacy_format_ids_evaluated');
    assert.ok(step.response.products.some(product => product.product_id === leaked), `${defect} leaks ${leaked}`);
    assert.deepEqual(failedChecks(result, 'legacy_format_ids_evaluated').map(check => check.path), ['products[1]']);
  }
});

test('preferred_delivery_types: the seeded product is found on a later wholesale page', async () => {
  const { result } = await run('preferred_delivery_types', { pageSize: 1, defect: undefined });
  assert.equal(result.overall_passed, true, JSON.stringify(failedSteps(result)));
});

test('fields: a seller that ignores the projection is still conformant', async () => {
  const { client } = seller();
  const original = client.executeTask.bind(client);
  client.executeTask = async (task, request) => original(task, task === 'get_products' ? { ...request, fields: undefined } : request);
  const result = await runStoryboard('https://seller.example/mcp', scenario('fields'), {
    protocol: 'mcp', agentTools: TOOLS,
    _profile: { tools: TOOLS, raw_capabilities: { media_buy: { buying_modes: ['wholesale'] } } },
    _controllerCapabilities: { detected: true, scenarios: SEED_SCENARIOS },
    _client: client,
  });
  assert.equal(result.overall_passed, true, JSON.stringify(failedSteps(result)));
});

for (const [name, mode] of [['format_ids', 'wholesale'], ['preferred_delivery_types', 'wholesale'], ['fields', 'wholesale'], ['refine_batch', 'refine']]) {
  test(`${name}: a seller without ${mode} is not graded and is not seeded`, async () => {
    const { result, calls } = await run(name, {}, ['brief']);
    assert.equal(result.failed_count, 0);
    assert.deepEqual(calls, []);
  });
}

// Schema facts each scenario depends on.

async function compile(name, base) {
  const loadSchema = async uri => {
    assert.ok(uri.startsWith('/schemas/'), uri);
    let relative = uri.slice('/schemas/'.length);
    const releasePrefix = `${path.basename(base)}/`;
    if (relative.startsWith(releasePrefix)) relative = relative.slice(releasePrefix.length);
    const location = path.resolve(base, relative);
    assert.ok(location.startsWith(`${base}${path.sep}`), uri);
    return JSON.parse(fs.readFileSync(location, 'utf8'));
  };
  const ajv = new Ajv({ strict: false, allErrors: true, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(`/schemas/${name}.json`));
}

const sourceSchemas = path.join(root, 'static/schemas/source');
const released31 = path.join(root, 'dist/schemas/3.1.19');

function gradedRequests() {
  return Object.keys(SCENARIOS).map(name => {
    const doc = YAML.parse(fs.readFileSync(file(name), 'utf8'));
    const graded = doc.phases.flatMap(phase => phase.steps).find(step => step.id === SCENARIOS[name].honored);
    return { name, doc, request: graded.sample_request };
  });
}

test('every graded request is a valid released 3.1 request and a valid current request', async () => {
  const legacy = await compile('media-buy/get-products-request', released31);
  const current = await compile('media-buy/get-products-request', sourceSchemas);
  for (const { name, request } of gradedRequests()) {
    // operator_unit postdates 3.1; the rest of the request is what an
    // unchanged 3.1 buyer sends.
    const { operator_unit: _unit, ...account31 } = request.account;
    assert.equal(legacy({ ...request, account: account31 }), true, `${name}: ${JSON.stringify(legacy.errors)}`);
    assert.equal(current(request), true, `${name}: ${JSON.stringify(current.errors)}`);
  }
});

test('the rejection branch sends exactly the graded request', () => {
  for (const { name, doc } of gradedRequests()) {
    const all = doc.phases.flatMap(phase => phase.steps);
    const honored = all.find(step => step.id === SCENARIOS[name].honored);
    const rejected = all.find(step => step.id === SCENARIOS[name].rejected);
    assert.deepEqual(rejected.sample_request, honored.sample_request, name);
  }
});

test('each scenario targets an input the compact tools cannot carry as-is', () => {
  const read = relative => JSON.parse(fs.readFileSync(path.join(sourceSchemas, relative), 'utf8'));
  const legacyFields = JSON.parse(fs.readFileSync(path.join(released31, 'media-buy/get-products-request.json'), 'utf8'))
    .properties.fields.items.enum;
  assert.ok(legacyFields.includes('delivery_measurement'));
  assert.equal(compactFields.has('delivery_measurement'), false);

  const refinements = read('media-buy/refine-proposals-request.json').properties.refinements;
  const { request } = gradedRequests().find(entry => entry.name === 'refine_batch');
  assert.ok(request.refine.length > refinements.maxItems, `${request.refine.length} > ${refinements.maxItems}`);
  assert.equal(new Set(request.refine.map(entry => entry.product_id)).size, request.refine.length, 'no repeated entries');
  assert.ok(request.refine.every(entry => entry.scope === 'product' && entry.action === 'include'));

  const offerFilters = read('core/product-offer-filters.json').properties;
  assert.equal(offerFilters.format_ids, undefined, 'compact offer filters have no legacy format_ids');
  assert.ok(offerFilters.delivery_type, 'the compact exclusion filter a facade must not substitute exists');
});

test('fixtures isolate one defect per negative control', () => {
  const { doc: formats, request } = gradedRequests().find(entry => entry.name === 'format_ids');
  const [wanted] = request.filters.format_ids;
  const byId = Object.fromEntries(formats.fixtures.products.map(product => [product.product_id, product.format_ids[0]]));
  const differences = formatId => Object.keys({ ...formatId, ...wanted }).filter(key => formatId[key] !== wanted[key]);
  assert.deepEqual(differences(byId.format_ids_z_matching), []);
  assert.deepEqual(differences(byId.format_ids_a_agent), ['agent_url']);
  assert.deepEqual(differences(byId.format_ids_b_parameters).sort(), ['height', 'width']);
  assert.ok(['format_ids_a_agent', 'format_ids_b_parameters'].every(id => id < 'format_ids_z_matching'),
    'both negatives sort before the matching product');
  assert.equal(request.pagination.max_results, 2, 'one row per negative control');

  const { doc: refine } = gradedRequests().find(entry => entry.name === 'refine_batch');
  const seeded = new Set(refine.fixtures.products.map(product => product.product_id));
  const { request: batch } = gradedRequests().find(entry => entry.name === 'refine_batch');
  assert.ok(batch.refine.every(entry => seeded.has(entry.product_id)));

  const { doc: preferred, request: preference } = gradedRequests().find(entry => entry.name === 'preferred_delivery_types');
  assert.ok(preferred.fixtures.products.every(product => !preference.preferred_delivery_types.includes(product.delivery_type)));
  assert.equal(preference.filters, undefined, 'no filter can remove the product from the wholesale feed');

  const { doc: fields } = gradedRequests().find(entry => entry.name === 'fields');
  assert.ok(fields.fixtures.products[0].delivery_measurement.vendors.length > 0);
});
