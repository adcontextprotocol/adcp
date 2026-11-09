'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
// Storyboard runner only. The three canonical paths gate on `skip_if`
// expressions that read captured context, which the root project's production
// @adcp/sdk 9.6.2 does not evaluate. tests/sdk-runner is a private, test-only
// workspace pinning a published 15.9.2 for exactly this; server runtime code
// keeps importing @adcp/sdk. See tests/sdk-runner/testing.cjs.
const { loadStoryboardFile, runStoryboard } = require('@adcp-protocol/fixture-test-sdk/testing');

const SCENARIOS = path.join(__dirname, '../static/compliance/source/protocols/media-buy/scenarios');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
(function register(dir) {
  for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, file.name);
    if (file.isDirectory()) register(full);
    else if (file.name.endsWith('.json')) {
      const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!schema.$id) continue;
      try {
        ajv.addSchema(schema);
      } catch {
        // A duplicate $id elsewhere in the tree must not take this whole file down.
      }
    }
  }
})(path.join(__dirname, '../static/schemas/source'));

const validateProduct = ajv.getSchema('/schemas/core/product.json');
const validateFormat = ajv.getSchema('/schemas/core/format.json');

/** Compare two `{ agent_url, id }` references without depending on key order. */
const sameFormatId = (a, b) => !!a && !!b && a.agent_url === b.agent_url && a.id === b.id;

for (const name of ['provenance_enforcement', 'provenance_audit_observation', 'provenance_truth_of_claim']) {
  test(`${name} seeds schema-valid products and resolves every legacy creative format`, () => {
    const storyboard = YAML.parse(fs.readFileSync(path.join(SCENARIOS, `${name}.yaml`), 'utf8'));
    for (const product of storyboard.fixtures.products) {
      assert.equal(validateProduct(product), true, ajv.errorsText(validateProduct.errors));
      const missingFormats = { ...product };
      delete missingFormats.format_ids;
      delete missingFormats.format_options;
      assert.equal(validateProduct(missingFormats), false, 'the schema must catch the original regression');
    }
    const formats = (storyboard.fixtures.creative_formats ?? []).map(row => row.fixture);
    for (const format of formats) {
      assert.equal(validateFormat(format), true, ajv.errorsText(validateFormat.errors));
    }
    for (const format of formats) {
      const host = new URL(format.format_id.agent_url).hostname;
      assert.ok(
        host === 'example' || host.endsWith('.example'),
        `${name} seeds a creative format whose agent_url host ${host} is not a reserved .example name; ` +
          'fixture-supplied agent_urls are registered inside every seller sandbox that runs conformance'
      );
    }
    let checked = 0;
    for (const step of storyboard.phases.flatMap(phase => phase.steps)) {
      for (const creative of step.sample_request?.creatives ?? []) {
        checked++;
        if (creative.format_id) {
          const format = formats.find(candidate => sameFormatId(candidate.format_id, creative.format_id));
          assert.ok(format, `${step.id} references an unseeded format`);
          for (const asset of format.assets) {
            if (asset.required)
              assert.ok(creative.assets?.[asset.asset_id], `${step.id} omits required ${asset.asset_id}`);
          }
          for (const [id, asset] of Object.entries(creative.assets ?? {})) {
            const declaration = format.assets.find(item => item.asset_id === id);
            assert.ok(declaration, `${step.id} submits undeclared asset ${id}`);
            assert.equal(asset.asset_type, declaration.asset_type, `${step.id}/${id} asset type differs`);
          }
          assert.ok(
            storyboard.fixtures.products.some(product =>
              (product.format_ids ?? []).some(id => sameFormatId(id, creative.format_id))
            ),
            `${step.id} is outside product formats`
          );
        } else {
          // On 3.1 every provenance probe targets the seeded legacy format, and
          // the products advertise format_ids[] only. A probe reaching here
          // would be selecting a canonical representation the seeded product
          // does not declare.
          assert.fail(`${step.id} submits a creative with no format_id; the seeded products declare format_ids[] only`);
        }
      }
    }
    assert.ok(checked > 0, `${name} declares no creative probes — the format checks above graded nothing`);
  });
}
const ACCOUNT_SCENARIOS = ['provenance_enforcement', 'provenance_truth_of_claim', 'provenance_audit_observation', 'creative_reception'];
const loadAccountScenario = name => YAML.parse(fs.readFileSync(path.join(SCENARIOS, `${name}.yaml`), 'utf8'));

test('3.1 account-scoped creative scenarios declare the sandbox identity they use', () => {
  const validateAccountRef = ajv.getSchema('/schemas/core/account-ref.json');
  const fixtures = [];
  for (const name of ACCOUNT_SCENARIOS) {
    const storyboard = loadAccountScenario(name);
    assert.equal(storyboard.prerequisites.controller_seeding, true, name);
    assert.equal(storyboard.fixtures.accounts.length, 1, name);
    const row = storyboard.fixtures.accounts[0];
    fixtures.push(row);
    assert.equal(row.fixture.sandbox, true, name);
    assert.equal('operator_unit' in row.fixture, false, '3.1 does not support operator_unit');
    const refs = storyboard.phases.flatMap(phase => phase.steps)
      .map(step => step.sample_request?.account).filter(account => account?.operator);
    assert.ok(refs.length > 0, name);
    for (const ref of refs) {
      assert.equal(validateAccountRef(ref), true, ajv.errorsText(validateAccountRef.errors));
      assert.deepEqual(ref, { brand: row.fixture.brand, operator: row.fixture.operator, sandbox: true }, name);
    }
  }
  for (const row of fixtures) assert.deepEqual(row, fixtures[0], 'a warm 3.1 natural key must reseed idempotently');
});

test('canonical product probes bind their fixtures to the product-target sandbox account', () => {
  const storyboard = YAML.parse(fs.readFileSync(path.join(
    __dirname, '../static/compliance/source/universal/canonical-format-validate-input.yaml'
  ), 'utf8'));
  const validateAccountRef = ajv.getSchema('/schemas/core/account-ref.json');
  assert.equal(validateAccountRef(storyboard.context.account), true, ajv.errorsText(validateAccountRef.errors));
  const productIds = new Set(storyboard.fixtures.products.map(product => product.product_id));
  const probes = storyboard.phases.flatMap(phase => phase.steps)
    .filter(step => step.sample_request?.targets?.some(target => target.kind === 'product' && productIds.has(target.id)));
  assert.equal(probes.length, 2, 'both missing-slot and nondeterministic probes must read the seeded product');
  for (const step of probes) assert.deepEqual(step.sample_request.account, storyboard.context.account, step.id);
});

test('vendor-metric catalog setup and both compatibility branches share the fixture sandbox account', () => {
  const storyboard = loadAccountScenario('vendor_metric_catalog_precondition');
  const account = storyboard.context.account;
  const validateAccountRef = ajv.getSchema('/schemas/core/account-ref.json');
  assert.equal(validateAccountRef(account), true, ajv.errorsText(validateAccountRef.errors));
  assert.equal(account.sandbox, true);
  const steps = storyboard.phases.flatMap(phase => phase.steps);
  const provision = steps.find(step => step.task === 'sync_accounts').sample_request.accounts[0];
  assert.deepEqual({ brand: provision.brand, operator: provision.operator, sandbox: provision.sandbox }, account);
  const uses = steps.filter(step => ['comply_test_controller', 'create_media_buy'].includes(step.task));
  assert.equal(uses.length, 3, 'catalog seed and both accept/reject branches must share scope');
  for (const step of uses) assert.deepEqual(step.sample_request.account, account, step.id);
});

// Exercise only the prerequisite contract through the public runner. Full
// authored storyboards are verified separately against the local MCP agent.
async function probeAccountPrerequisite(name, accounts, { omitFixture = false, rejectSeed = false } = {}) {
  const source = loadAccountScenario(name);
  const request = source.phases.flatMap(phase => phase.steps)
    .find(step => step.task === 'sync_creatives').sample_request;
  const storyboard = {
    ...source,
    fixtures: { accounts: omitFixture ? [] : source.fixtures.accounts },
    phases: [{ id: 'account_prerequisite_probe', title: 'Account prerequisite', steps: [{
      id: 'use_declared_account', title: 'Use declared account', task: 'sync_creatives',
      sample_request: request,
      validations: [{ check: 'field_value', path: 'account_ready', value: true }],
    }] }],
  };
  // This clone isolates account provisioning, including failed prerequisites.
  // Real 3.1 provenance coverage remains gated before mutation; the separate
  // optional-discovery-maintenance tests exercise that production behavior.
  if (storyboard.requires_capability?.path === 'creative.supports_provenance') {
    delete storyboard.requires_capability;
  }
  const calls = [];
  const tools = ['get_adcp_capabilities', 'comply_test_controller', 'sync_creatives'];
  const key = ref => JSON.stringify([ref.brand.domain, ref.operator, ref.sandbox === true]);
  const client = { executeTask: async (task, input) => {
    calls.push({ task, input: structuredClone(input) });
    if (task === 'comply_test_controller') {
      if (input.scenario === 'list_scenarios') return { success: true, data: { success: true, scenarios: ['seed_account'] } };
      assert.equal(input.scenario, 'seed_account');
      if (rejectSeed) return { success: true, data: { success: false, error: 'INVALID_STATE' } };
      const row = input.params;
      const previous = accounts.get(key(row.fixture));
      assert.ok(!previous || JSON.stringify(previous) === JSON.stringify(row), 'warm seed must not replace the natural key');
      accounts.set(key(row.fixture), structuredClone(row));
      return { success: true, data: { success: true, scenario: input.scenario } };
    }
    assert.equal(task, 'sync_creatives');
    const found = accounts.get(key(input.account));
    return found
      ? { success: true, status: 'completed', data: { account_ready: true, context: input.context } }
      : { success: false, error: 'ACCOUNT_NOT_FOUND' };
  } };
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    _client: client, agentTools: tools,
    _profile: { tools, raw_capabilities: { supported_protocols: ['media_buy'] } },
  });
  return { result, calls };
}

test('each 3.1 account prerequisite works cold and after every rotated scenario order', async t => {
  for (const name of ACCOUNT_SCENARIOS) await t.test(`cold ${name}`, async () => {
    const { result, calls } = await probeAccountPrerequisite(name, new Map());
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(result.skipped_count, 0);
    const seed = calls.findIndex(call => call.input.scenario === 'seed_account');
    const use = calls.findIndex(call => call.task === 'sync_creatives');
    assert.ok(seed >= 0 && use > seed, 'account must be seeded before use');
  });
  for (let offset = 0; offset < ACCOUNT_SCENARIOS.length; offset++) await t.test(`rotation ${offset}`, async () => {
    const accounts = new Map();
    for (const name of [...ACCOUNT_SCENARIOS.slice(offset), ...ACCOUNT_SCENARIOS.slice(0, offset)]) {
      const { result } = await probeAccountPrerequisite(name, accounts);
      assert.equal(result.overall_passed, true, JSON.stringify(result));
      assert.equal(result.skipped_count, 0);
    }
    assert.equal(accounts.size, 1, 'all four scenarios reuse one declared 3.1 sandbox identity');
  });
});

test('account prerequisite controls reject omitted fixtures and rejected seeding', async () => {
  for (const name of ACCOUNT_SCENARIOS) for (const options of [{ omitFixture: true }, { rejectSeed: true }]) {
    const { result } = await probeAccountPrerequisite(name, new Map(), options);
    assert.equal(result.overall_passed, false, `${name}: ${JSON.stringify(options)}`);
    assert.ok(result.failed_count > 0, 'an unavailable prerequisite must not fabricate a pass');
  }
});

// One canonical discovery now decides between all three canonical shapes, so the gate
// and the buy are always the same observation. Only the legacy path reads separately.
function discoveryKey(request) {
  return (request.context?.correlation_id ?? '').includes('canonical') ? 'canonicalPath' : 'legacyPath';
}

// Which execution lane a request belongs to, read off its correlation_id.
function laneOf(request) {
  const correlation = request.context?.correlation_id ?? '';
  if (correlation.includes('unnamed_option')) return 'unnamed-option';
  if (correlation.includes('product_scoped')) return 'product-scoped';
  if (correlation.includes('publisher_scoped')) return 'publisher-scoped';
  return 'legacy';
}

// The three canonical shapes a conformant product may publish. `product-format-
// declaration.json` requires only format_kind and params; format_option_id is optional,
// and publisher_domain appears only on publisher-catalog-backed options.
const DECLARATIONS = {
  unnamed: () => ({ format_kind: 'image', params: { width: 300, height: 250 } }),
  product: () => ({
    format_kind: 'image',
    params: { width: 300, height: 250 },
    format_option_id: 'display_image_300x250',
  }),
  publisher: () => ({
    format_kind: 'image',
    params: { width: 300, height: 250 },
    format_option_id: 'daily_pulse_homepage_image',
    publisher_domain: 'outdoormagazine.example',
  }),
};

function buildProduct({
  product_id = 'advertised-product',
  pricing_option_id = 'fixed-cpm',
  canonical,
  legacy,
  // 'unnamed' | 'product' | 'publisher'
  shape = 'product',
  // A second declaration narrowing the SAME format_kind. format_option_id stops being a
  // SHOULD here: format_kind alone no longer identifies one declaration, so a correct
  // seller requires format_option_refs[] and rejects a package without one.
  sameKindCatalog = false,
  // Kind of the FIRST canonical declaration. Anything other than 'image' is a
  // mismatch for the fixture's 300x250 image creative and must be detected, not bought.
  canonicalKind = 'image',
}) {
  const first = { ...DECLARATIONS[shape](), format_kind: canonicalKind };
  return {
    product_id,
    pricing_options: [{ pricing_option_id, pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
    ...(canonical && {
      format_options: sameKindCatalog
        ? [first, { ...DECLARATIONS[shape](), format_option_id: `${first.format_option_id ?? 'image'}_premium` }]
        : [first],
    }),
    ...(legacy && { format_ids: [{ agent_url: 'https://creative.example/', id: 'non-projectable-legacy' }] }),
  };
}

async function runInline({
  canonical,
  legacy,
  canonicalKind = 'image',
  // Observation hook: lets a test prove the stub's ambiguity branch actually fired,
  // rather than inferring it from a red run that other causes could also produce.
  onSelectorLessRejected = null,
  shape = 'product',
  failLane = null,
  readback = 'replacement',
  drift = {},
  failDiscovery = null,
  sameKindCatalog = false,
}) {
  const storyboard = loadStoryboardFile(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'));
  // Strip only response_schema: the stub returns deliberately minimal payloads that are
  // not full schema instances, and independent schema lints already cover that grading.
  // Everything else stays live - an allowlist here would silently stop grading any step
  // kind added to the storyboard later.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
    }
  }
  const calls = [];
  const buys = new Map();
  // Snapshotted so a test can prove the runner never writes back into the captured
  // declaration when it injects `scope` into the emitted ref.
  const servedDeclarations = [];
  const client = {
    executeTask: async (task, request) => {
      calls.push({ task, request: structuredClone(request) });
      const lane = laneOf(request);
      const echo = { context: request.context };
      let data = task === 'comply_test_controller' ? { success: true, scenario: request.scenario } : {};
      if (task === 'get_products' && failDiscovery === discoveryKey(request)) {
        return { success: false, error: 'discovery unavailable' };
      }
      if (task === 'get_adcp_capabilities') {
        data = {
          ...echo,
          supported_protocols: ['media_buy'],
          media_buy: { features: { inline_creative_management: true } },
        };
      } else if (task === 'get_products') {
        const product = buildProduct({
          canonical,
          legacy,
          shape,
          sameKindCatalog,
          canonicalKind,
          ...(drift[discoveryKey(request)] ?? {}),
        });
        // Frozen: the runner captures this object by reference, so if a future SDK
        // wrote the injected `scope` back onto the capture it must throw here rather
        // than leave the no-mutation assertion silently passing for the wrong reason.
        for (const declaration of product.format_options ?? [])
          servedDeclarations.push(Object.freeze(declaration));
        data = { ...echo, products: [product] };
      } else if (task === 'create_media_buy') {
        if (failLane === lane) return { success: false, error: 'inline creative rejected' };
        const requested = request.packages[0];
        // A seller that published a selectable id requires a ref naming it. A legacy
        // package is selector-bearing by other means - the creative carries format_id.
        const options = buildProduct({ canonical, legacy, shape, sameKindCatalog, canonicalKind }).format_options ?? [];
        const published = options[0];
        // A catalog with two entries sharing one format_kind is genuinely ambiguous:
        // `format_kind` alone cannot route, so a correct seller refuses a package that
        // carries no disambiguating ref. Gate on the ambiguity itself, not on
        // options[0] having an id, so the second entry is actually load-bearing.
        const ambiguous =
          options.filter(option => option.format_kind === published?.format_kind).length > 1;
        if (
          (published?.format_option_id || ambiguous) &&
          !requested.format_option_refs &&
          !requested.creatives?.[0]?.format_id
        ) {
          onSelectorLessRejected?.();
          return { success: false, error: 'format_option_refs[] is required to select a published format option' };
        }
        const pkg = {
          package_id: `${lane}-package`,
          product_id: requested.product_id,
          pricing_option_id: requested.pricing_option_id,
          budget: requested.budget,
          context: requested.context,
        };
        buys.set(lane, { media_buy_id: `${lane}-buy`, package: pkg });
        data = { ...echo, media_buy_id: `${lane}-buy`, packages: [pkg] };
      } else if (task === 'update_media_buy') {
        const updated = buys.get(lane);
        // Without this guard a cascade-behaviour change would crash the stub from
        // inside executeTask and the test would still pass on overall_passed alone.
        if (!updated) return { success: false, error: `no media buy recorded for lane ${lane}` };
        data = { ...echo, media_buy_id: request.media_buy_id, affected_packages: [updated.package] };
      } else if (task === 'get_media_buys') {
        const read = buys.get(lane);
        if (!read) return { success: false, error: `no media buy recorded for lane ${lane}` };
        const canonicalLane = lane !== 'legacy';
        const approvals =
          canonicalLane && readback === 'missing'
            ? []
            : [
                {
                  creative_id: `acme-inline-${lane}-display-${
                    canonicalLane && readback === 'original' ? 'v1' : 'v2'
                  }`,
                },
              ];
        data = {
          ...echo,
          media_buys: [
            {
              media_buy_id: request.media_buy_ids[0],
              packages: [{ package_id: read.package.package_id, creative_approvals: approvals }],
            },
          ],
        };
      }
      return { success: true, status: 'completed', data };
    },
  };
  // sync_creatives is advertised on purpose: the scenario's whole premise is that an
  // inline seller is never pushed onto the creative-library surface, so the assertion
  // that it is never called has to be made against a seller that offers it.
  const tools = [
    'comply_test_controller',
    'get_adcp_capabilities',
    'get_products',
    'create_media_buy',
    'update_media_buy',
    'get_media_buys',
    'sync_creatives',
  ];
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp',
    agentTools: tools,
    _client: client,
    _profile: {
      name: 'inline seller',
      tools,
      raw_capabilities: { media_buy: { features: { inline_creative_management: true } } },
    },
  });
  const ranPhases = result.phases
    .filter(phase => phase.phase_id.endsWith('_inline_path') && phase.steps.length > 0)
    .map(phase => phase.phase_id);
  const creates = calls.filter(call => call.task === 'create_media_buy');
  const refs = creates.flatMap(call => call.request.packages[0].format_option_refs ?? []);
  return { result, calls, creates, refs, ranPhases, servedDeclarations };
}

const validateRef = ajv.getSchema('/schemas/core/format-option-ref.json');

// Each canonical shape is graded on exactly one path, and the emitted selector is a
// valid FormatOptionRef - including the publisher-catalog shape, which is addressable
// only by the complete {publisher_domain, format_option_id} pair.
for (const [shape, phase, scope] of [
  ['unnamed', 'canonical_unnamed_option_inline_path', null],
  ['product', 'canonical_product_scoped_inline_path', 'product'],
  ['publisher', 'canonical_publisher_scoped_inline_path', 'publisher'],
]) {
  test(`inline creatives: a ${shape}-shaped canonical option is graded on exactly one path`, async () => {
    const { result, creates, refs, ranPhases, servedDeclarations } = await runInline({
      canonical: true,
      legacy: false,
      shape,
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.deepEqual(ranPhases, [phase], 'exactly one canonical execution path may run');
    assert.equal(creates.length, 1);
    if (scope === null) {
      assert.equal(refs.length, 0, 'an unnamed option has no id to select with');
      assert.equal(
        JSON.stringify(creates[0].request).includes('format_option_id'),
        false,
        'nothing may reference an id the seller never published'
      );
    } else {
      assert.equal(refs.length, 1);
      assert.equal(refs[0].scope, scope);
      assert.equal(validateRef(refs[0]), true, ajv.errorsText(validateRef.errors));
      if (scope === 'publisher') {
        assert.equal(refs[0].publisher_domain, 'outdoormagazine.example');
        assert.equal(refs[0].format_option_id, 'daily_pulse_homepage_image');
      }
    }
    // The ref is built by substituting the captured declaration and then injecting
    // `scope`. That injection must never write back into the captured object.
    assert.ok(servedDeclarations.length > 0, 'no declaration was served, so the loop below proves nothing');
    for (const declaration of servedDeclarations) {
      assert.equal('scope' in declaration, false, 'injecting scope must not mutate the captured declaration');
    }
  });
}

for (const [name, canonical, legacy] of [
  ['canonical only', true, false],
  ['legacy only', false, true],
  ['dual emission', true, true],
]) {
  test(`inline creatives: ${name} buys on exactly its advertised representations`, async () => {
    const { result, calls, creates } = await runInline({ canonical, legacy });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.equal(creates.length, Number(canonical) + Number(legacy));
    assert.equal(calls.filter(call => call.task === 'get_media_buys').length, creates.length);
    // Two discovery calls now, not one per canonical shape.
    assert.equal(calls.filter(call => call.task === 'get_products').length, 2);
    assert.equal(calls.some(call => call.task === 'sync_creatives'), false);
    if (legacy) {
      const legacyCreate = creates.find(call => call.request.context.correlation_id.includes('legacy'));
      assert.deepEqual(legacyCreate.request.packages[0].creatives[0].format_id, {
        agent_url: 'https://creative.example/',
        id: 'non-projectable-legacy',
      });
    }
  });
}

// A product whose same-kind declarations need disambiguation must never receive a
// selector-less purchase. The stub's rejection rule is a live guard rather than a
// branch this suite takes: every lane that reaches create carries either
// format_option_refs or a creative-level format_id, so the guard fires only if the
// storyboard regresses. The unnamed case below is the one that makes the SECOND
// declaration load-bearing.
test('inline creatives: a named same-kind catalog never receives a selector-less purchase', async () => {
  const { result, creates, refs, ranPhases } = await runInline({
    canonical: true,
    legacy: false,
    shape: 'product',
    sameKindCatalog: true,
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.deepEqual(ranPhases, ['canonical_product_scoped_inline_path']);
  assert.equal(creates.length, 1);
  assert.equal(
    creates.filter(call => !call.request.packages[0].format_option_refs).length,
    0,
    'no selector-less purchase may reach a named same-kind catalog'
  );
  assert.equal(refs[0].format_option_id, 'display_image_300x250');
});

test('inline creatives: an unnamed same-kind catalog is detected, not bought selector-less', async () => {
  // Two declarations sharing one format_kind, where the FIRST — the only one any
  // probe captures — carries no format_option_id. The unnamed lane is therefore the
  // one that opens, and it sends no selector at all, while format_kind alone cannot
  // route between two same-kind entries. That makes `ambiguous` the sole term that
  // can trigger the stub's rejection here: `options[0].format_option_id` is
  // undefined, so the other half of the condition cannot fire. (The second
  // declaration does carry an id of its own; it is simply not reachable by the
  // buyer, which is exactly why the catalog is ambiguous from where the buyer
  // stands.)
  let selectorLessRejections = 0;
  const { result, calls, creates } = await runInline({
    canonical: true,
    legacy: false,
    shape: 'unnamed',
    sameKindCatalog: true,
    onSelectorLessRejected: () => (selectorLessRejections += 1),
  });
  // The unnamed lane attempts its selector-less create and the seller refuses it.
  assert.equal(creates.length, 1, 'the unnamed lane attempts the only selector it has');
  assert.equal(
    selectorLessRejections,
    1,
    'the ambiguity rule — not format_option_id, which is absent here — must be what rejects'
  );
  // Nothing was established: no buy to update or read back.
  assert.equal(calls.filter(call => call.task === 'update_media_buy').length, 0);
  assert.equal(calls.filter(call => call.task === 'get_media_buys').length, 0);
  const coverage = result.phases
    .flatMap(phase => phase.steps)
    .find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'no path completed, so the coverage gate must fail');
  assert.equal(result.overall_passed, false);
});

// #3268's core requirement: brief-mode get_products carries no ordering or stability
// guarantee, so a seller returning different results per call must not be failed. The
// canonical paths all read one response, so only canonical-vs-legacy can diverge.
test('inline creatives: discovery results that change between calls cause no false failure', async () => {
  const { result, creates } = await runInline({
    canonical: true,
    legacy: true,
    drift: {
      canonicalPath: { product_id: 'ranked-first-at-call-one', pricing_option_id: 'cpm-a' },
      legacyPath: { product_id: 'ranked-first-at-call-two', pricing_option_id: 'cpm-b' },
    },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.equal(creates.length, 2);
  for (const [lane, productId, pricingId] of [
    ['product_scoped', 'ranked-first-at-call-one', 'cpm-a'],
    ['legacy', 'ranked-first-at-call-two', 'cpm-b'],
  ]) {
    const create = creates.find(call => call.request.context.correlation_id.includes(lane));
    assert.equal(create.request.packages[0].product_id, productId, `${lane} bought the wrong product`);
    assert.equal(create.request.packages[0].pricing_option_id, pricingId, `${lane} bought the wrong pricing option`);
  }
});

// The regression that split canonical discovery caused: a seller answering one brief
// with a different canonical SHAPE per call used to have no canonical gate open at all.
// With one canonical discovery the shape is observed once, so this cannot arise - the
// legacy call may still differ and is still handled.
for (const shape of ['unnamed', 'product', 'publisher']) {
  test(`inline creatives: a ${shape} canonical shape is unaffected by what the legacy call returns`, async () => {
    const { result, creates, ranPhases } = await runInline({
      canonical: true,
      legacy: true,
      shape,
      drift: { legacyPath: { canonical: false } },
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.equal(ranPhases.length, 2, 'one canonical path plus the legacy path');
    assert.equal(creates.length, 2);
  });
}

test('inline creatives: a representation absent from one discovery call is not a failure', async () => {
  const { result, creates } = await runInline({
    canonical: true,
    legacy: true,
    drift: { legacyPath: { legacy: false } },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  assert.equal(creates.length, 1);
  const legacyExec = result.phases.find(phase => phase.phase_id === 'legacy_format_inline_path');
  assert.equal(legacyExec.steps.length, 0, 'legacy execution must skip, not run');
  // The probe stays visible rather than being regraded away, but sits in an optional
  // phase so it cannot fail a seller for a representation it does not publish.
  const legacyDiscovery = result.phases.find(phase => phase.phase_id === 'legacy_format_discovery');
  assert.equal(legacyDiscovery.steps.length, 1);
  assert.equal(result.failed_count, 0, 'an optional discovery probe must not count as a failure');
});

// A discovery call that hard-errors is NOT the same as a seller that does not publish
// the representation. The probe stays visible instead of being regraded away.
test('inline creatives: a failed discovery call stays visible rather than being hidden', async () => {
  const { result } = await runInline({ canonical: true, legacy: true, failDiscovery: 'canonicalPath' });
  const discovery = result.phases.find(phase => phase.phase_id === 'canonical_format_discovery');
  assert.equal(discovery.steps.length, 1, 'the failed discovery probe must still be reported');
  assert.equal(discovery.steps[0].passed, false, 'it must not be regraded away as a moot peer branch');
  for (const phase of ['canonical_product_scoped_inline_path', 'canonical_unnamed_option_inline_path', 'canonical_publisher_scoped_inline_path']) {
    assert.equal(result.phases.find(p => p.phase_id === phase).steps.length, 0);
  }
  assert.equal(result.phases.find(phase => phase.phase_id === 'legacy_format_inline_path').passed, true);
});

test('inline creatives: no usable representation cannot pass by skipping every path', async () => {
  const { result } = await runInline({ canonical: false, legacy: false });
  assert.equal(result.overall_passed, false);
});

test('inline creatives: an advertised path failure is not hidden by the other path passing', async () => {
  const { result } = await runInline({ canonical: true, legacy: true, failLane: 'product-scoped' });
  assert.equal(result.overall_passed, false);
});

for (const readback of ['missing', 'original']) {
  test(`inline creatives: ${readback} replacement approval fails readback`, async () => {
    const { result } = await runInline({ canonical: true, legacy: false, readback });
    assert.equal(result.overall_passed, false);
    const read = result.phases.flatMap(phase => phase.steps).find(step => step.task === 'get_media_buys');
    assert.equal(read.passed, false);
    const coverage = result.phases.flatMap(phase => phase.steps).find(step => step.task === 'assert_contribution');
    assert.equal(coverage.passed, false, 'failed readback must not contribute coverage');
  });
}

for (const readback of ['missing', 'original']) {
  test(`inline creatives: ${readback} canonical approval fails even when legacy readback passes`, async () => {
    const { result } = await runInline({ canonical: true, legacy: true, readback });
    assert.equal(result.overall_passed, false);
    assert.equal(result.phases.find(phase => phase.phase_id === 'canonical_product_scoped_inline_path').passed, false);
    assert.equal(result.phases.find(phase => phase.phase_id === 'legacy_format_inline_path').passed, true);
  });
}


// Legacy discovery must NOT narrow with `filters.format_kinds`, and this pins why.
//
// core/product-format-declaration.json's "Format matching vs satisfaction (normative)"
// clause conditions normalization on the legacy id having been projected: "do not
// exact-match raw (agent_url, id) pairs ONCE a format_id has been projected through
// canonical, v1_format_ref, or the canonical mapping registry". A NON-projectable
// legacy format - the case adcp-client#3268 names, and what this storyboard's legacy
// fixture uses - has no canonical projection, so there is no format_kind to match.
// On the lines where it exists (3.2/main), core/product-filters.json defines
// format_kinds as "Filter to products accepting any of these canonical format kinds",
// which such a product does not. 3.1 defines no such filter at all - asserted below -
// so on this line the point is moot in the request and decisive in principle.
//
// So a seller correctly honouring the filter would exclude itself from legacy
// discovery, and the legacy path - the whole point of the fix - would stop being
// graded. Applicability is documented on the probe instead of filtered for.
test('inline creatives: neither discovery narrows by canonical format_kinds on 3.1', async () => {
  const { calls } = await runInline({ canonical: true, legacy: true });
  const legacyDiscovery = calls.find(
    call =>
      call.task === 'get_products' &&
      (call.request.context?.correlation_id ?? '').includes('legacy')
  );
  assert.ok(legacyDiscovery, 'the legacy discovery call must happen');
  assert.equal(
    legacyDiscovery.request.filters?.format_kinds,
    undefined,
    'narrowing legacy discovery by canonical kind would exclude non-projectable legacy-only sellers'
  );
  // On 3.1 the canonical probe does not narrow either, and cannot: this line's
  // product-filters.json defines no canonical-kind filter, so sending one would
  // ride in on additionalProperties, be ignored by a conformant 3.1 seller, and
  // assert a guarantee that does not exist. Asset applicability is stated in the
  // storyboard narrative instead, for both probes.
  const canonicalDiscovery = calls.find(
    call =>
      call.task === 'get_products' &&
      (call.request.context?.correlation_id ?? '').includes('canonical')
  );
  assert.equal(canonicalDiscovery.request.filters?.format_kinds, undefined);
  const filters = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../static/schemas/source/core/product-filters.json'), 'utf8')
  );
  assert.equal(
    'format_kinds' in filters.properties,
    false,
    'if 3.1 ever gains a canonical-kind filter, revisit narrowing the canonical probe'
  );
});

test('inline creatives: a video-first canonical declaration is detected, never bought under', async () => {
  // Mixed seller: canonical first declaration is video, legacy is available. The
  // detector must stop the canonical paths rather than sending the 300x250 image
  // creative under a video declaration; the legacy path still carries the run.
  const { result, creates, ranPhases } = await runInline({
    canonical: true,
    legacy: true,
    canonicalKind: 'video_hosted',
  });
  assert.deepEqual(ranPhases, ['legacy_format_inline_path'], 'no canonical lane may open on a kind mismatch');
  assert.equal(creates.length, 1);
  assert.ok(
    creates[0].request.context.correlation_id.includes('legacy'),
    'the only buy must be the legacy one'
  );
  for (const create of creates) {
    assert.notEqual(create.request.packages[0].creatives[0]?.format_kind, 'video_hosted');
    assert.equal(create.request.packages[0].format_option_refs, undefined);
  }
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
});

test('inline creatives: a canonical-only video-first seller still fails coverage with zero buys', async () => {
  // The detector is NOT a selector: with no legacy fallback there is no path left,
  // so the closing contribution assertion fails and nothing is bought.
  const { result, creates, ranPhases } = await runInline({
    canonical: true,
    legacy: false,
    canonicalKind: 'video_hosted',
  });
  assert.deepEqual(ranPhases, [], 'no execution phase may open');
  assert.equal(creates.length, 0, 'nothing may be bought');
  const coverage = result.phases
    .flatMap(phase => phase.steps)
    .find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'the coverage gate must fail rather than pass vacuously');
  assert.equal(result.overall_passed, false);
});

// The concrete loss if the filter were added: a legacy-only seller that honours
// format_kinds returns nothing, the legacy gate never opens, and a conformant seller
// fails the coverage gate having been asked for a canonical kind it never claimed.
test('inline creatives: a legacy-only seller honouring format_kinds would lose all coverage if filtered', async () => {
  const storyboard = loadStoryboardFile(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'));
  let narrowed = 0;
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
      // Simulate the proposed change: narrow the legacy probe too. #8603 removed
      // the step's only filter (is_fixed_price), so the authored request carries
      // no filters object; add one rather than assume it exists.
      if (step.id === 'get_products_legacy_format') {
        assert.equal(step.sample_request.filters?.format_kinds, undefined, 'the authored legacy probe must not already narrow');
        step.sample_request.filters = { ...step.sample_request.filters, format_kinds: ['image'] };
        narrowed += 1;
      }
    }
  }
  assert.equal(narrowed, 1, 'the legacy discovery step must exist for the simulated narrowing to mean anything');
  const product = buildProduct({ canonical: false, legacy: true });
  const client = {
    executeTask: async (task, request) => {
      const echo = { context: request.context };
      if (task === 'comply_test_controller') return { success: true, status: 'completed', data: { success: true } };
      if (task === 'get_adcp_capabilities') {
        return {
          success: true,
          status: 'completed',
          data: { ...echo, supported_protocols: ['media_buy'], media_buy: { features: { inline_creative_management: true } } },
        };
      }
      if (task === 'get_products') {
        // Honours the filter: this product accepts no canonical format kind.
        const asked = request.filters?.format_kinds;
        return { success: true, status: 'completed', data: { ...echo, products: asked ? [] : [product] } };
      }
      return { success: true, status: 'completed', data: echo };
    },
  };
  const tools = ['comply_test_controller', 'get_adcp_capabilities', 'get_products', 'create_media_buy', 'update_media_buy', 'get_media_buys'];
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp',
    agentTools: tools,
    _client: client,
    _profile: { name: 'legacy seller', tools, raw_capabilities: { media_buy: { features: { inline_creative_management: true } } } },
  });
  // Assert the MECHANISM, not just a red run: a stub that cannot complete a buy
  // would fail with or without the filter and prove nothing. The legacy execution
  // phase must never open, and the sole coverage gate must be what fails.
  const legacyPhase = result.phases.find(phase => phase.phase_id === 'legacy_format_inline_path');
  assert.equal(legacyPhase.steps.filter(step => !step.skipped).length, 0, 'the legacy path must never open');
  const coverage = result.phases
    .flatMap(phase => phase.steps)
    .find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'no path completed, so the coverage gate must fail');
  assert.equal(result.overall_passed, false, 'filtering legacy discovery costs a conformant legacy-only seller its only path');
  // Positive control: the same seller, unfiltered, is graded green by the
  // 'legacy only buys on exactly its advertised representations' test above.
});

// deterministic_testing seeds `test-product` / `test-pricing` and consumes them as
// Acme Outdoor buying through Pinnacle, but its deterministic_account phase also
// provisions an unrelated test.example account through sync_accounts. Without a
// top-level context.account nothing names which of the two owns the fixtures, so
// accountless controller calls fall back to the run-scoped default and a
// fail-closed seeder has no single owner to write to. The maintained test-only
// wrapper selects this line's actual 3.1 schemas and published runner; preserve
// that wrapper while pinning fixture and authored resource ownership below.
const DETERMINISTIC_TESTING = path.join(
  __dirname,
  '../static/compliance/source/universal/deterministic-testing.yaml'
);
const FIXTURE_CONSUMER = {
  brand: { domain: 'acmeoutdoor.example' },
  operator: 'pinnacle-agency.example',
};
const PROVISIONED = { brand: { domain: 'test.example' }, operator: 'test.example' };

// Drive the authored storyboard through the installed SDK runner against a stub
// seller that accepts every call except the authored negative paths, so every
// phase reaches its controller steps.
// Validations are stripped because the stub returns minimal payloads; only the
// wire requests the runner builds are under test here.
async function runDeterministicTesting({ omitPhases = [] } = {}) {
  const storyboard = loadStoryboardFile(DETERMINISTIC_TESTING);
  storyboard.phases = storyboard.phases.filter(phase => !omitPhases.includes(phase.id));
  const refusals = new Set();
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = [];
      if (step.expect_error) refusals.add(`deterministic_testing--${step.id}`);
    }
  }
  const calls = [];
  const client = {
    executeTask: async (task, request) => {
      calls.push({ task, request: structuredClone(request) });
      // Refuse exactly the negative-path steps, as a conformant controller would.
      if (refusals.has(request.context?.correlation_id)) {
        return { success: false, error: 'INVALID_TRANSITION', data: { context: request.context, success: false } };
      }
      const data = {
        context: request.context,
        success: true,
        supported_protocols: ['media_buy', 'creative'],
        scenarios: [
          'seed_product',
          'seed_pricing_option',
          'force_account_status',
          'force_media_buy_status',
          'force_creative_status',
          'simulate_delivery',
          'simulate_budget_spend',
        ],
        accounts: [{ account_id: 'acct_provisioned', ...PROVISIONED }],
        media_buy_id: 'mb_deterministic',
        creatives: [{ creative_id: 'cr_deterministic' }],
      };
      return { success: true, status: 'completed', data };
    },
  };
  const tools = [
    'comply_test_controller',
    'get_adcp_capabilities',
    'sync_accounts',
    'list_accounts',
    'create_media_buy',
    'get_media_buys',
    'get_media_buy_delivery',
    'sync_creatives',
  ];
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp',
    agentTools: tools,
    _client: client,
    _profile: { name: 'deterministic seller', tools },
  });
  // Every step that ran must pass, so no controller step is silently skipped. Only
  // the SI phase and the creative format query are skipped: the stub advertises no
  // si_* tools and no list_creative_formats, and neither carries an account. Without
  // that query the creative state machine still runs (adcp#8770).
  const steps = result.phases.flatMap(phase => phase.steps);
  assert.deepEqual(steps.filter(step => !step.passed && !step.skipped).map(step => step.step_id), []);
  assert.deepEqual(
    [...new Set(steps.filter(step => step.skipped).map(step => step.phase_id))],
    ['deterministic_creative_formats', 'deterministic_session']
  );
  const stepOf = call => (call.request.context?.correlation_id ?? '').replace(/^deterministic_testing--/, '');
  // Negative-path steps are sent as authored, without account enrichment, so they
  // say nothing about which owner the runner resolves.
  const enriched = calls.filter(call => !refusals.has(call.request.context?.correlation_id));
  return { storyboard, calls, enriched, stepOf };
}

test('deterministic_testing names the fixture-consuming account as its fixture owner', () => {
  const storyboard = YAML.parse(fs.readFileSync(DETERMINISTIC_TESTING, 'utf8'));
  assert.equal(storyboard.prerequisites.controller_seeding, true);
  const owner = storyboard.context?.account;
  assert.ok(owner, 'a controller-seeded storyboard with two account identities must name its fixture owner');
  const validateAccountRef = ajv.getSchema('/schemas/core/account-ref.json');
  assert.equal(validateAccountRef(owner), true, ajv.errorsText(validateAccountRef.errors));
  assert.deepEqual(owner, { ...FIXTURE_CONSUMER, sandbox: true });

  // The owner is the account that actually buys the seeded product.
  const productIds = new Set(storyboard.fixtures.products.map(product => product.product_id));
  const steps = storyboard.phases.flatMap(phase => phase.steps);
  const consumers = steps.filter(step =>
    (step.sample_request?.packages ?? []).some(pkg => productIds.has(pkg.product_id))
  );
  assert.equal(consumers.length, 3, 'state-machine, delivery and budget buys all consume the seeded product');
  for (const step of consumers) assert.deepEqual(step.sample_request.account, FIXTURE_CONSUMER, step.id);

  const resourceControls = storyboard.phases
    .filter(phase => ['deterministic_media_buy', 'deterministic_creative', 'deterministic_delivery', 'deterministic_budget'].includes(phase.id))
    .flatMap(phase => phase.steps)
    .filter(step => step.task === 'comply_test_controller' &&
    ['force_media_buy_status', 'force_creative_status', 'simulate_delivery', 'simulate_budget_spend'].includes(step.sample_request?.scenario)
  );
  assert.equal(resourceControls.length, 10, 'all Acme lifecycle controls, including negative paths, must be scoped');
  for (const step of resourceControls) assert.deepEqual(step.sample_request.account, owner, step.id);

  // Account provisioning keeps its own, deliberately different identity.
  const provisioning = steps.filter(step => step.task === 'sync_accounts');
  assert.equal(provisioning.length, 1);
  const row = provisioning[0].sample_request.accounts[0];
  assert.deepEqual({ brand: row.brand, operator: row.operator }, PROVISIONED);
  assert.notDeepEqual({ brand: row.brand, operator: row.operator }, FIXTURE_CONSUMER);
});

test('deterministic_testing controller calls resolve to the fixture owner while provisioning stays test.example', async () => {
  const { storyboard, calls, enriched, stepOf } = await runDeterministicTesting();
  const owner = { ...FIXTURE_CONSUMER, sandbox: true };

  // A controller call that authors only `sandbox: true` resolves to the fixture
  // owner instead of the run-scoped default identity.
  const validationSteps = storyboard.phases
    .find(phase => phase.id === 'controller_validation')
    .steps.map(step => step.id);
  const controllerChecks = enriched.filter(
    call => call.task === 'comply_test_controller' && validationSteps.includes(stepOf(call))
  );
  assert.deepEqual(controllerChecks.map(stepOf), ['list_scenarios']);
  for (const call of controllerChecks) assert.deepEqual(call.request.account, owner, stepOf(call));

  // sync_accounts still provisions its authored, unrelated identity.
  const provisioning = calls.filter(call => call.task === 'sync_accounts');
  assert.equal(provisioning.length, 1);
  const [row] = provisioning[0].request.accounts;
  assert.deepEqual({ brand: row.brand, operator: row.operator }, PROVISIONED);
});

// The runner rebinds context.account to whatever account the deterministic_account
// phase's sync_accounts call returns, for the rest of the run; that is how its
// force_account_status steps reach the provisioned account. Omitting the phase
// keeps independent coverage of the declared fixture owner without provisioning.
// The strict account-isolation regression below retains provisioning and verifies
// later resource controls still target Acme.
test('deterministic_testing force and simulate calls retain the fixture owner without provisioning', async () => {
  const { calls, enriched, stepOf } = await runDeterministicTesting({ omitPhases: ['deterministic_account'] });
  const owner = { ...FIXTURE_CONSUMER, sandbox: true };
  const scenarios = ['force_media_buy_status', 'force_creative_status', 'simulate_delivery', 'simulate_budget_spend'];
  const directives = enriched.filter(
    call => call.task === 'comply_test_controller' && scenarios.includes(call.request.scenario)
  );
  for (const scenario of scenarios) {
    assert.ok(directives.some(call => call.request.scenario === scenario), `${scenario} must be exercised`);
  }
  for (const call of directives) {
    assert.deepEqual(call.request.account, owner, `${stepOf(call)} (${call.request.scenario})`);
  }
  // The buys those directives act on take their sandbox flag from the same owner.
  const buys = enriched.filter(call => call.task === 'create_media_buy');
  assert.equal(buys.length, 3);
  for (const call of buys) assert.deepEqual(call.request.account, owner, stepOf(call));
  assert.equal(calls.some(call => call.task === 'sync_accounts'), false);
});

// Keep the provisioning phase in this regression: sync_accounts deliberately
// selects Test for account-state controls, while later resources belong to Acme.
// The negative control removes only their authored identity, reproducing the
// cross-account NOT_FOUND that an identity-insensitive seller would conceal.
async function runDeterministicAccountIsolation({ removeResourceScope = false, removeListFilter = false, accountNamespace = false } = {}) {
  const storyboard = loadStoryboardFile(DETERMINISTIC_TESTING);
  const selected = new Map([
    ['deterministic_account', ['sync_accounts_for_state', 'list_accounts_for_state', 'force_account_suspended', 'force_account_active']],
    ['deterministic_media_buy', ['create_media_buy', 'force_media_buy_active']],
    ['deterministic_delivery', ['create_media_buy_for_delivery', 'simulate_delivery']],
  ]);
  if (accountNamespace) {
    for (const phaseId of [...selected.keys()]) if (phaseId !== 'deterministic_account') selected.delete(phaseId);
  }
  storyboard.phases = storyboard.phases
    .filter(phase => selected.has(phase.id))
    .map(phase => ({ ...phase, steps: phase.steps.filter(step => selected.get(phase.id).includes(step.id)) }));
  for (const [phaseId, stepIds] of selected) {
    assert.deepEqual(storyboard.phases.find(phase => phase.id === phaseId).steps.map(step => step.id), stepIds);
  }
  if (removeListFilter) {
    delete storyboard.phases.find(phase => phase.id === 'deterministic_account').steps.find(step => step.id === 'list_accounts_for_state').sample_request.account;
  }
  if (removeResourceScope) {
    for (const phase of storyboard.phases) {
      for (const step of phase.steps) {
        if (['force_media_buy_active', 'simulate_delivery'].includes(step.id)) {
          step.sample_request.account = { sandbox: true };
        }
      }
    }
  }

  const owner = { ...FIXTURE_CONSUMER, sandbox: true };
  const provisioned = { ...PROVISIONED, sandbox: true };
  const accountKey = account => JSON.stringify({ brand: account?.brand, operator: account?.operator, sandbox: account?.sandbox });
  const accounts = new Map([['acct_acme', { account_id: 'acct_acme', name: 'Acme sandbox', ...owner, status: 'active' }]]);
  if (accountNamespace) accounts.set('acct_existing', { account_id: 'acct_existing', name: 'Existing sandbox', sandbox: true, status: 'active' });
  const currentAccount = accountNamespace ? { account_id: 'acct_existing', sandbox: true } : provisioned;
  const currentAccountId = accountNamespace ? 'acct_existing' : 'acct_provisioned';
  const callerContext = accountNamespace ? { account: { account_id: 'acct_existing' } } : {};
  const callerContextBefore = structuredClone(callerContext);
  const storyboardBefore = structuredClone(storyboard);
  const buys = new Map();
  const calls = [];
  const schemas = { sync_accounts: 'account/sync-accounts', list_accounts: 'account/list-accounts', create_media_buy: 'media-buy/create-media-buy', comply_test_controller: 'compliance/comply-test-controller' };
  let accountStatus = 'active';
  const scenarios = ['seed_product', 'seed_pricing_option', 'force_account_status', 'force_media_buy_status', 'simulate_delivery'];
  const client = {
    executeTask: async (task, request) => {
      const call = { task, request: structuredClone(request) };
      calls.push(call);
      const validateRequest = ajv.getSchema(`/schemas/${schemas[task]}-request.json`);
      assert.ok(validateRequest, `missing ${task} request validator`);
      assert.equal(validateRequest(request), true, ajv.errorsText(validateRequest.errors));
      let data;
      let success = true;
      if (task === 'sync_accounts') {
        const [account] = request.accounts;
        assert.deepEqual({ brand: account.brand, operator: account.operator, sandbox: account.sandbox }, provisioned);
        const created = { account_id: 'acct_provisioned', name: 'Test sandbox', ...provisioned, status: 'active' };
        accounts.set(created.account_id, created);
        data = { accounts: [{ ...created, action: 'created' }] };
      } else if (task === 'list_accounts') {
        const visible = [...accounts.values()];
        const rows = request.account ? visible.filter(row => request.account.account_id ? row.account_id === request.account.account_id : accountKey(row) === accountKey(request.account)) : visible;
        data = { accounts: rows };
      } else if (task === 'create_media_buy') {
        assert.deepEqual(request.account, owner, 'authored buys must consume Acme fixtures');
        const mediaBuyId = `mb_isolation_${buys.size + 1}`;
        buys.set(mediaBuyId, { owner: accountKey(request.account), status: 'pending_start' });
        data = {
          media_buy_id: mediaBuyId,
          media_buy_status: 'pending_start',
          confirmed_at: '2026-01-01T00:00:00Z',
          revision: 1,
          packages: [{ package_id: `pkg_isolation_${buys.size}` }],
        };
      } else {
        assert.equal(task, 'comply_test_controller');
        const params = request.params ?? {};
        if (request.scenario === 'list_scenarios') data = { success: true, scenarios };
        else if (['seed_product', 'seed_pricing_option'].includes(request.scenario)) {
          // Fixture owner declaration is pinned above; this regression isolates
          // resource control scoping after sync_accounts selects another account.
          data = { success: true };
        } else if (request.scenario === 'force_account_status') {
          if (JSON.stringify(request.account) !== JSON.stringify(currentAccount) || params.account_id !== currentAccountId) {
            success = false;
            data = { success: false, error: 'NOT_FOUND', error_detail: 'Controller account scope and account ID do not identify the provisioned Test account' };
          } else {
            data = { success: true, previous_state: accountStatus, current_state: params.status };
            accountStatus = params.status;
          }
        } else {
          assert.ok(['force_media_buy_status', 'simulate_delivery'].includes(request.scenario));
          const buy = buys.get(params.media_buy_id);
          assert.ok(buy, 'controller must reference a buy this strict seller actually created');
          if (accountKey(request.account) !== buy.owner) {
            success = false;
            data = { success: false, error: 'NOT_FOUND', error_detail: 'Media buy belongs to another sandbox account' };
          } else if (request.scenario === 'force_media_buy_status') {
            data = { success: true, previous_state: buy.status, current_state: params.status };
            buy.status = params.status;
          } else data = { success: true, simulated: { impressions: params.impressions, clicks: params.clicks } };
        }
      }
      data.context = request.context;
      data.status = success ? 'completed' : 'failed';
      const validateResponse = ajv.getSchema(`/schemas/${schemas[task]}-response.json`);
      assert.ok(validateResponse, `missing ${task} response validator`);
      assert.equal(validateResponse(data), true, ajv.errorsText(validateResponse.errors));
      call.response = structuredClone(data);
      return { success, status: data.status, ...(success ? {} : { error: 'NOT_FOUND' }), data };
    },
  };
  const tools = ['comply_test_controller', 'sync_accounts', 'list_accounts', 'create_media_buy'].filter(task => !accountNamespace || task !== 'sync_accounts');
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    protocol: 'mcp',
    context: callerContext,
    agentTools: tools,
    _client: client,
    _profile: {
      name: 'strict account-aware deterministic seller',
      tools,
      raw_capabilities: {
        supported_protocols: ['media_buy'],
        account: { require_operator_auth: accountNamespace },
        compliance_testing: { scenarios },
      },
    },
  });
  assert.deepEqual(callerContext, callerContextBefore, 'runner must not mutate caller-selected account context');
  assert.deepEqual(storyboard, storyboardBefore, 'full-object substitution must not mutate authored requests');
  return { calls, result };
}

test('deterministic_testing retains resource ownership after provisioning another account', async () => {
  const positive = await runDeterministicAccountIsolation();
  const steps = positive.result.phases.flatMap(phase => phase.steps);
  assert.deepEqual(steps.filter(step => !step.passed && !step.skipped).map(step => step.step_id), []);
  assert.equal(steps.filter(step => step.skipped).length, 0, 'all eight authored steps must execute');
  const authoredIds = ['sync_accounts_for_state', 'list_accounts_for_state', 'force_account_suspended', 'force_account_active', 'create_media_buy', 'force_media_buy_active', 'create_media_buy_for_delivery', 'simulate_delivery'];
  assert.deepEqual(steps.filter(step => authoredIds.includes(step.step_id)).map(step => step.step_id), authoredIds);
  const controls = positive.calls.filter(call => ['force_media_buy_status', 'simulate_delivery'].includes(call.request.scenario));
  assert.deepEqual(controls.map(call => call.request.scenario), ['force_media_buy_status', 'simulate_delivery']);
  for (const call of controls) assert.deepEqual(call.request.account, { ...FIXTURE_CONSUMER, sandbox: true });
  const accountControls = positive.calls.filter(call => call.request.scenario === 'force_account_status');
  assert.equal(accountControls.length, 2);
  for (const call of accountControls) {
    assert.deepEqual(call.request.account, { ...PROVISIONED, sandbox: true });
    assert.equal(call.request.params.account_id, 'acct_provisioned');
  }
  const lists = positive.calls.filter(call => call.task === 'list_accounts');
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].request.account, { ...PROVISIONED, sandbox: true });
  assert.deepEqual(lists[0].response.accounts.map(account => account.account_id), ['acct_provisioned']);

  const negative = await runDeterministicAccountIsolation({ removeResourceScope: true });
  const failed = negative.result.phases.flatMap(phase => phase.steps).filter(step => !step.passed && !step.skipped);
  assert.deepEqual(failed.map(step => step.step_id), ['force_media_buy_active', 'simulate_delivery']);
  for (const call of negative.calls.filter(call => ['force_media_buy_status', 'simulate_delivery'].includes(call.request.scenario))) {
    assert.deepEqual(call.request.account, { ...PROVISIONED, sandbox: true }, 'removing authored scope must reproduce the wrong owner');
  }
});


test('deterministic_testing exact account listing prevents unrelated visible accounts from supplying its state target', async () => {
  const negative = await runDeterministicAccountIsolation({ removeListFilter: true });
  const failed = negative.result.phases.flatMap(phase => phase.steps).filter(step => !step.passed && !step.skipped);
  assert.deepEqual(failed.map(step => step.step_id), ['force_account_suspended']);
  const reactivation = negative.result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'force_account_active');
  assert.equal(reactivation.skipped, true, 'runner must skip reactivation after the failed suspension');
  const list = negative.calls.find(call => call.task === 'list_accounts');
  assert.equal(list.request.account, undefined, 'negative control removes only the authored exact-account filter');
  assert.deepEqual(list.response.accounts.map(account => account.account_id), ['acct_acme', 'acct_provisioned']);
  const accountControls = negative.calls.filter(call => call.request.scenario === 'force_account_status');
  assert.equal(accountControls.length, 1);
  for (const call of accountControls) {
    assert.deepEqual(call.request.account, { ...PROVISIONED, sandbox: true }, 'controller account stays Test');
    assert.equal(call.request.params.account_id, 'acct_acme', 'unfiltered first row incorrectly supplies Acme account ID');
    assert.equal(call.response.error, 'NOT_FOUND', 'strict seller refuses the mismatched scope and ID');
  }
});


test('deterministic_testing filters the effective account ID when buyer provisioning is not applicable', async () => {
  const { calls, result } = await runDeterministicAccountIsolation({ accountNamespace: true });
  const steps = result.phases.flatMap(phase => phase.steps);
  assert.deepEqual(steps.filter(step => !step.passed && !step.skipped).map(step => step.step_id), []);
  const skipped = steps.filter(step => step.skipped);
  assert.deepEqual(skipped.map(step => step.step_id), ['sync_accounts_for_state']);
  assert.equal(skipped[0].skip_reason, 'not_applicable');
  assert.equal(calls.some(call => call.task === 'sync_accounts'), false);
  const lists = calls.filter(call => call.task === 'list_accounts');
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].request.account, { account_id: 'acct_existing' }, 'full-object reference must use the caller-selected ID, not the storyboard seed default');
  assert.deepEqual(lists[0].response.accounts.map(account => account.account_id), ['acct_existing']);
  const controls = calls.filter(call => call.request.scenario === 'force_account_status');
  assert.equal(controls.length, 2);
  for (const call of controls) {
    assert.deepEqual(call.request.account, { account_id: 'acct_existing', sandbox: true });
    assert.equal(call.request.params.account_id, 'acct_existing');
    assert.equal(call.response.success, true);
  }
});
