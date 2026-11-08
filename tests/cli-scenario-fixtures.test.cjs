'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');
const { generatedSchemaDocuments } = require('../scripts/task-responses.cjs');

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
// The schema build generates each task's response, <task>-response.json, from
// its status bodies; each payload below is validated against it.
for (const schema of generatedSchemaDocuments(path.join(__dirname, '../static/schemas/source')).values()) {
  ajv.addSchema(structuredClone(schema));
}

for (const name of ['provenance_enforcement', 'provenance_audit_observation', 'provenance_truth_of_claim']) {
  test(`${name} seeds schema-valid products whose declarations cover every creative probe`, () => {
    const storyboard = YAML.parse(fs.readFileSync(path.join(SCENARIOS, `${name}.yaml`), 'utf8'));
    const validateProduct = ajv.getSchema('/schemas/core/product.json');
    const validateFormat = ajv.getSchema('/schemas/core/format.json');
    for (const product of storyboard.fixtures.products) {
      assert.equal(validateProduct(product), true, ajv.errorsText(validateProduct.errors));
      const missingFormats = { ...product };
      delete missingFormats.format_ids;
      delete missingFormats.format_options;
      assert.equal(validateProduct(missingFormats), false, 'the schema must catch the original regression');
    }
    // Seeded formats nest the declaration under `fixture:` with `format_id` as a
    // sibling key (see universal/pagination-integrity-creative-formats.yaml), so the
    // id has to be folded back in before anything can match a creative against it.
    const formats = (storyboard.fixtures.creative_formats ?? []).map(row => ({
      format_id: row.format_id,
      ...row.fixture,
    }));
    for (const format of formats) {
      assert.equal(validateFormat(format), true, ajv.errorsText(validateFormat.errors));
    }
    // Counted so the branches below cannot quietly stop covering anything: on main every
    // probe is canonical (format_kind), and the legacy branch exists for the 3.1 backport
    // where these storyboards seed a fixture-local format and probe it by format_id.
    let canonicalProbes = 0;
    let legacyProbes = 0;
    for (const step of storyboard.phases.flatMap(phase => phase.steps)) {
      for (const creative of step.sample_request?.creatives ?? []) {
        if (creative.format_id) {
          legacyProbes += 1;
          const format = formats.find(
            format => JSON.stringify(format.format_id) === JSON.stringify(creative.format_id)
          );
          assert.ok(format, `${step.id} references an unseeded format`);
          for (const asset of format.assets ?? []) {
            if (asset.required)
              assert.ok(creative.assets?.[asset.asset_id], `${step.id} omits required ${asset.asset_id}`);
          }
          for (const [id, asset] of Object.entries(creative.assets ?? {})) {
            const declaration = (format.assets ?? []).find(item => item.asset_id === id);
            assert.ok(declaration, `${step.id} submits undeclared asset ${id}`);
            assert.equal(asset.asset_type, declaration.asset_type, `${step.id}/${id} asset type differs`);
          }
          assert.ok(
            storyboard.fixtures.products.some(product =>
              (product.format_ids ?? []).some(id => JSON.stringify(id) === JSON.stringify(creative.format_id))
            ),
            `${step.id} is outside product formats`
          );
        } else {
          canonicalProbes += 1;
          assert.equal(creative.assets?.image?.asset_type, 'image', `${step.id} must submit the declared image asset`);
          // Dimensions come from the declaration, so fixture and probe drift together.
          const option = storyboard.fixtures.products
            .flatMap(product => product.format_options ?? [])
            .find(candidate => candidate.format_kind === creative.format_kind);
          assert.ok(option, `${step.id} is outside product formats`);
          assert.equal(creative.assets.image.width, option.params.width, `${step.id} image width differs from the declaration`);
          assert.equal(creative.assets.image.height, option.params.height, `${step.id} image height differs from the declaration`);
        }
      }
    }
    // On main every provenance probe is canonical; the legacy arm exists for the 3.1
    // backport. Assert the branch this storyboard actually takes is non-empty so the
    // cross-checks above cannot quietly stop covering anything.
    assert.ok(canonicalProbes > 0, `${name} must exercise at least one canonical creative probe`);
    assert.equal(legacyProbes, 0, `${name} probes are canonical on main; a legacy probe here is unexpected`);
  });
}

test('canonical product probes bind their fixtures to the complete product-target sandbox account', () => {
  const storyboard = YAML.parse(fs.readFileSync(path.join(
    __dirname, '../static/compliance/source/universal/canonical-format-validate-input.yaml'
  ), 'utf8'));
  const account = storyboard.context.account;
  const validateAccountRef = ajv.getSchema('/schemas/core/account-ref.json');
  assert.equal(validateAccountRef(account), true, ajv.errorsText(validateAccountRef.errors));
  assert.equal(account.sandbox, true);
  const productIds = new Set(storyboard.fixtures.products.map(product => product.product_id));
  const probes = storyboard.phases.flatMap(phase => phase.steps)
    .filter(step => step.sample_request?.targets?.some(target => target.kind === 'product' && productIds.has(target.id)));
  assert.equal(probes.length, 2, 'both missing-slot and nondeterministic probes must read the seeded product');
  for (const step of probes) assert.deepEqual(step.sample_request.account, account, step.id);
});

test('vendor-metric catalog setup and both compatibility branches share the fixture sandbox account', () => {
  const storyboard = YAML.parse(fs.readFileSync(path.join(SCENARIOS, 'vendor_metric_catalog_precondition.yaml'), 'utf8'));
  const account = storyboard.context.account;
  const validateAccountRef = ajv.getSchema('/schemas/core/account-ref.json');
  assert.equal(validateAccountRef(account), true, ajv.errorsText(validateAccountRef.errors));
  assert.equal(account.sandbox, true);
  const steps = storyboard.phases.flatMap(phase => phase.steps);
  const provision = steps.find(step => step.task === 'sync_accounts').sample_request.accounts[0];
  const identity = {
    brand: provision.brand,
    operator: provision.operator,
    ...(Object.hasOwn(provision, 'operator_unit') ? { operator_unit: provision.operator_unit } : {}),
    sandbox: provision.sandbox,
  };
  assert.deepEqual(identity, account);
  const uses = steps.filter(step => ['comply_test_controller', 'create_media_buy'].includes(step.task));
  assert.equal(uses.length, 3, 'catalog seed and both accept/reject branches must share scope');
  for (const step of uses) assert.deepEqual(step.sample_request.account, account, step.id);
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
  // First declaration the fixed 300x250 image creative cannot satisfy.
  videoFirst: () => ({
    format_kind: 'video',
    params: { duration_seconds: 15 },
    format_option_id: 'preroll_15s',
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
}) {
  const first = DECLARATIONS[shape]();
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
  shape = 'product',
  filterLegacyDiscovery = false,
  stripCanonicalRefs = false,
  failLane = null,
  readback = 'replacement',
  drift = {},
  failDiscovery = null,
  sameKindCatalog = false,
  auction = false,
}) {
  const storyboard = loadStoryboardFile(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'));
  // Strip only response_schema: the stub returns deliberately minimal payloads that are
  // not full schema instances, and independent schema lints already cover that grading.
  // Everything else stays live - an allowlist here would silently stop grading any step
  // kind added to the storyboard later.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
      // Simulate the rejected proposal: narrow the legacy probe by canonical kind.
      if (filterLegacyDiscovery && step.id === 'get_products_legacy_format') {
        step.sample_request.filters ??= {};
        step.sample_request.filters.format_kinds = ['image'];
      }
      // Negative control: withhold the disambiguating selector the storyboard sends.
      if (stripCanonicalRefs) {
        delete step.sample_request?.packages?.[0]?.format_option_refs;
        delete step.context_inputs;
      }
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
          ...(drift[discoveryKey(request)] ?? {}),
        });
        assert.equal(request.filters?.is_fixed_price, undefined, 'inline creative management accepts either pricing type');
        if (auction) for (const price of product.pricing_options) {
          delete price.fixed_price;
          price.floor_price = 8;
        }
        // A seller honouring filters.format_kinds returns nothing when it publishes no
        // canonical declaration to match - exactly the legacy-only case.
        if (request.filters?.format_kinds && !product.format_options) {
          return { success: true, status: 'completed', data: { ...echo, products: [] } };
        }
        // Frozen so that if the SDK ever clones on the capture path, a write-back throws
        // instead of silently making the no-mutation assertion vacuous.
        for (const declaration of product.format_options ?? []) servedDeclarations.push(Object.freeze(declaration));
        data = { ...echo, products: [product] };
      } else if (task === 'create_media_buy') {
        if (failLane === lane) return { success: false, error: 'inline creative rejected' };
        const requested = request.packages[0];
        if (auction) assert.ok(requested.bid_price >= 8, 'inline auction purchases bid at least the discovered floor');
        // A seller that published a selectable id requires a ref naming it. A legacy
        // package is selector-bearing by other means - the creative carries format_id.
        const catalog = buildProduct({ canonical, legacy, shape, sameKindCatalog }).format_options ?? [];
        const requestedKind = requested.creatives?.[0]?.format_kind;
        // Ambiguity is a property of the catalog, not of entry [0]: when several options
        // share the creative's kind, bare format_kind cannot select one and the buyer
        // must name it. core/creative-asset.json makes the ref required in exactly that case.
        const ambiguous = catalog.filter(option => option.format_kind === requestedKind).length > 1;
        const selects = (requested.format_option_refs ?? []).some(ref => ref.format_option_id);
        if (
          (ambiguous || catalog[0]?.format_option_id) &&
          !selects &&
          !requested.creatives?.[0]?.format_id
        ) {
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
        const updating = buys.get(lane);
        if (!updating) return { success: false, error: `no buy for lane ${lane}` };
        data = { ...echo, media_buy_id: request.media_buy_id, affected_packages: [updating.package] };
      } else if (task === 'get_media_buys') {
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
              packages: [{ package_id: buys.get(lane).package.package_id, creative_approvals: approvals }],
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

for (const [canonical, legacy] of [[true, false], [false, true], [true, true]]) {
  test(`inline creatives: auction pricing completes advertised paths (${canonical}, ${legacy})`, async () => {
    const { result, creates } = await runInline({ canonical, legacy, auction: true });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.equal(creates.length, Number(canonical) + Number(legacy));
  });
}

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
// selector-less purchase. Verified against a seller that actually rejects one.
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

  // The seller really would have refused without it: same ambiguous catalog, selector
  // withheld, and the purchase is rejected. Without this, sameKindCatalog proves nothing
  // the plain product-shape test does not already prove.
  const withheld = await runInline({
    canonical: true,
    legacy: false,
    shape: 'product',
    sameKindCatalog: true,
    stripCanonicalRefs: true,
  });
  assert.equal(withheld.result.overall_passed, false, 'an ambiguous same-kind catalog must refuse a selector-less buy');
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


// The canonical discovery mismatch detector. It is a guard, not a selector: it stops an
// image creative being bought against a non-image declaration, and it does NOT make a
// video-first catalog gradable.
test('inline creatives: a video-first canonical declaration never receives a mismatched buy', async () => {
  // Mixed seller: canonical first declaration is video, legacy is still serviceable.
  const { result, creates, ranPhases } = await runInline({
    canonical: true,
    legacy: true,
    shape: 'videoFirst',
  });
  // No canonical path runs, so no image creative is bought against a video declaration.
  assert.deepEqual(ranPhases, ['legacy_format_inline_path']);
  assert.equal(
    creates.filter(call => !call.request.context.correlation_id.includes('legacy')).length,
    0,
    'no canonical create may reach a video-first declaration'
  );
  // Legacy carries coverage, so the seller is still graded.
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
});

test('inline creatives: a canonical-only video-first seller makes zero buys and fails coverage', async () => {
  const { result, creates, ranPhases } = await runInline({
    canonical: true,
    legacy: false,
    shape: 'videoFirst',
  });
  assert.deepEqual(ranPhases, [], 'no execution phase may run');
  assert.equal(creates.length, 0, 'zero creates');
  const coverage = result.phases.flatMap(phase => phase.steps).find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'the coverage gate reports that nothing was exercised');
  assert.equal(result.overall_passed, false, 'the detector guards the buy; it does not make this catalog gradable');
});

// Legacy discovery must NOT narrow with `filters.format_kinds`, and this pins why.
//
// core/product-filters.json defines format_kinds as "Filter to products accepting any
// of these canonical format kinds". A non-projectable legacy format - the case
// adcp-client#3268 names, and what this storyboard's legacy fixture uses - has no
// canonical mapping, so there is no kind for such a product to match on. A seller
// honouring the filter could therefore return nothing and drop out of legacy discovery
// entirely, and the legacy path - the whole point of the fix - would stop being graded.
//
// Deliberately NOT paraphrased as a normative rule about what sellers must return: the
// point is the fixture population this scenario has to keep reachable. Applicability is
// documented on the probe instead of filtered for.
test('inline creatives: legacy discovery does not narrow by canonical format_kinds', async () => {
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
  // And the canonical probe does narrow, because every canonical declaration has a kind.
  const canonicalDiscovery = calls.find(
    call =>
      call.task === 'get_products' &&
      (call.request.context?.correlation_id ?? '').includes('canonical')
  );
  assert.deepEqual(canonicalDiscovery.request.filters.format_kinds, ['image']);
});

// The concrete loss if the filter were added, proved against the SAME conformant stub
// the positive control uses: the 'legacy only' test above shows this seller passing
// unfiltered, so the only variable here is the filter.
test('inline creatives: narrowing legacy discovery by format_kinds costs a legacy-only seller its only path', async () => {
  const { result, creates } = await runInline({
    canonical: false,
    legacy: true,
    filterLegacyDiscovery: true,
  });
  const phases = result.phases;
  // The mechanism, not just the verdict: discovery returns nothing, so the gate never
  // opens, no buy happens, and the coverage assertion is what fails.
  assert.equal(
    phases.find(phase => phase.phase_id === 'legacy_format_inline_path').steps.length,
    0,
    'the legacy gate must never open when the filtered probe returns no product'
  );
  assert.equal(creates.length, 0, 'a filtered legacy-only seller never gets to buy');
  const coverage = phases.flatMap(phase => phase.steps).find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'the conformant seller fails the coverage gate');
  assert.equal(result.overall_passed, false);
});

// deterministic_testing seeds `test-product` / `test-pricing` and consumes them as
// Acme Outdoor buying through Pinnacle, but its deterministic_account phase also
// provisions an unrelated test.example account through sync_accounts. Without a
// top-level context.account nothing names which of the two owns the fixtures, so
// accountless controller calls fall back to the run-scoped default and a
// fail-closed seeder has no single owner to write to. The installed SDK still seeds
// under the run-scoped default; newer runners (verified on 17.0.0-beta.15) seed
// under context.account, which the static test below pins to the consuming account.
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
  // the SI phase is skipped: the stub advertises no si_* tools, and SI carries no account.
  const steps = result.phases.flatMap(phase => phase.steps);
  assert.deepEqual(steps.filter(step => !step.passed && !step.skipped).map(step => step.step_id), []);
  assert.deepEqual(
    [...new Set(steps.filter(step => step.skipped).map(step => step.phase_id))],
    ['deterministic_session']
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
