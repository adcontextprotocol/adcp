'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');

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

for (const name of ['provenance_enforcement', 'provenance_audit_observation', 'provenance_truth_of_claim']) {
  test(`${name} seeds schema-valid products whose declarations cover every creative probe`, () => {
    const storyboard = YAML.parse(fs.readFileSync(path.join(SCENARIOS, `${name}.yaml`), 'utf8'));
    const validateProduct = ajv.getSchema('/schemas/core/product.json');
    const validateFormat = ajv.getSchema('/schemas/core/format.json');
    for (const product of storyboard.fixtures.products) {
      const validate = validateProduct;
      assert.equal(validate(product), true, ajv.errorsText(validate.errors));
      const missingFormats = { ...product };
      delete missingFormats.format_ids;
      delete missingFormats.format_options;
      assert.equal(validate(missingFormats), false, 'the schema must catch the original regression');
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
    assert.ok(canonicalProbes + legacyProbes > 0, 'the storyboard must probe at least one creative');
    assert.equal(
      canonicalProbes,
      storyboard.phases.flatMap(phase => phase.steps).flatMap(step => step.sample_request?.creatives ?? []).length -
        legacyProbes,
      'every probe must be classified'
    );
  });
}

// The storyboard reads a product in `product_discovery` and re-reads it inside each
// format path. Keyed on correlation_id so a case can hand a *different* product back
// to a later read and prove the gate and the buy stay bound to one product.
// Each representation now has its own get_products, and the buy is built from that
// same response - so a case can hand a different product to each call and prove the
// storyboard never gates on one response and buys from another.
function discoveryKey(request) {
  const correlation = request.context?.correlation_id ?? '';
  if (correlation.includes('unnamed_option')) return 'unnamedPath';
  return correlation.includes('canonical') ? 'canonicalPath' : 'legacyPath';
}

function buildProduct({
  product_id = 'advertised-product',
  pricing_option_id = 'fixed-cpm',
  canonical,
  legacy,
  // canonical-format-option.json requires only format_kind and params, so a product
  // may publish a usable canonical option with no stable id at all.
  namedOption = true,
}) {
  return {
    product_id,
    pricing_options: [{ pricing_option_id, pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
    ...(canonical && {
      format_options: [
        { format_kind: 'image', params: { width: 300, height: 250 }, ...(namedOption && { format_option_id: 'image' }) },
      ],
    }),
    ...(legacy && { format_ids: [{ agent_url: 'https://creative.example/', id: 'non-projectable-legacy' }] }),
  };
}

async function runInline({ canonical, legacy, failCanonical = false, readback = 'replacement', drift = {}, namedOption = true, failDiscovery = null }) {
  const storyboard = loadStoryboardFile(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'));
  // Strip only response_schema: the stub returns deliberately minimal payloads that are
  // not full schema instances, and independent schema lints already cover that grading.
  // Everything else stays live - an allowlist here would silently stop grading any step
  // kind added to the storyboard later. The stub echoes context and package buyer_ref so
  // the create/update assertions can run for real.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
    }
  }
  const calls = [];
  // Per-lane memory: update_media_buy's readback assertions check package state that
  // only create_media_buy established, so the stub has to behave like a real seller.
  const buys = new Map();
  const client = {
    executeTask: async (task, request) => {
      calls.push({ task, request });
      const correlation = request.context?.correlation_id ?? '';
      // Three lanes now: named-canonical, unnamed-canonical and legacy. The creative ids
      // the storyboard asserts on are lane-scoped, so the stub has to be too.
      const lane = correlation.includes('unnamed_option')
        ? 'unnamed-option'
        : correlation.includes('canonical')
          ? 'canonical'
          : 'legacy';
      const isCanonical = lane === 'canonical';
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
        data = {
          ...echo,
          products: [buildProduct({ canonical, legacy, namedOption, ...(drift[discoveryKey(request)] ?? {}) })],
        };
      } else if (task === 'create_media_buy') {
        if (failCanonical && isCanonical) return { success: false, error: 'inline creative rejected' };
        const requested = request.packages[0];
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
        const state = buys.get(lane);
        data = {
          ...echo,
          media_buy_id: request.media_buy_id,
          affected_packages: [state.package],
        };
      } else if (task === 'get_media_buys') {
        const approvals =
          isCanonical && readback === 'missing'
            ? []
            : [{ creative_id: `acme-inline-${lane}-display-${isCanonical && readback === 'original' ? 'v1' : 'v2'}` }];
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
  return { result, calls };
}

for (const [name, canonical, legacy] of [
  ['canonical only', true, false],
  ['legacy only', false, true],
  ['dual emission', true, true],
]) {
  test(`inline creatives: ${name} buys on exactly its advertised representations`, async () => {
    const { result, calls } = await runInline({ canonical, legacy });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    const creates = calls.filter(call => call.task === 'create_media_buy');
    assert.equal(creates.length, Number(canonical) + Number(legacy));
    assert.equal(calls.filter(call => call.task === 'get_media_buys').length, creates.length);
    // One discovery per execution path, always - a path whose representation is absent
    // simply captures nothing and skips.
    assert.equal(calls.filter(call => call.task === 'get_products').length, 3);
    assert.equal(
      calls.some(call => call.task === 'sync_creatives'),
      false
    );
    if (legacy) {
      const legacyCreate = creates.find(call => call.request.context.correlation_id.includes('legacy'));
      assert.deepEqual(legacyCreate.request.packages[0].creatives[0].format_id, {
        agent_url: 'https://creative.example/',
        id: 'non-projectable-legacy',
      });
    }
  });
}

// #3268's core requirement: brief-mode get_products carries no ordering or stability
// guarantee, so a seller legitimately returning different results per call must not be
// failed. Each path discovers and buys from one response, so there is nothing to diverge.
test('inline creatives: discovery results that change between calls cause no false failure', async () => {
  const { result, calls } = await runInline({
    canonical: true,
    legacy: true,
    drift: {
      canonicalPath: { product_id: 'ranked-first-at-call-one', pricing_option_id: 'cpm-a' },
      legacyPath: { product_id: 'ranked-first-at-call-two', pricing_option_id: 'cpm-b' },
    },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  const creates = calls.filter(call => call.task === 'create_media_buy');
  assert.equal(creates.length, 2);
  // Each buy is built from the response its own phase read.
  for (const [lane, productId, pricingId] of [
    ['canonical', 'ranked-first-at-call-one', 'cpm-a'],
    ['legacy', 'ranked-first-at-call-two', 'cpm-b'],
  ]) {
    const create = creates.find(call => call.request.context.correlation_id.includes(lane));
    assert.equal(create.request.packages[0].product_id, productId, `${lane} bought the wrong product`);
    assert.equal(create.request.packages[0].pricing_option_id, pricingId, `${lane} bought the wrong pricing option`);
  }
});

// The main-only false failure this design removes: a representation visible to one
// get_products and absent from the next must not fail a conformant seller.
test('inline creatives: a representation absent from one discovery call is not a failure', async () => {
  const { result, calls } = await runInline({
    canonical: true,
    legacy: true,
    // The legacy discovery call comes back canonical-only, exactly as the reference
    // seller behaved on main.
    drift: { legacyPath: { legacy: false } },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  const phases = result.phases;
  assert.equal(phases.find(phase => phase.phase_id === 'canonical_format_inline_path').passed, true);
  // The legacy execution phase skipped rather than buying an unusable reference.
  assert.equal(calls.filter(call => call.task === 'create_media_buy').length, 1);
  const legacyExec = phases.find(phase => phase.phase_id === 'legacy_format_inline_path');
  assert.equal(legacyExec.steps.length, 0, 'legacy execution must skip, not run');
  // The discovery probe itself stays visible rather than being regraded away, but it
  // sits in an optional phase so it cannot fail a seller for a representation it does
  // not publish.
  const legacyDiscovery = phases.find(phase => phase.phase_id === 'legacy_format_discovery');
  assert.equal(legacyDiscovery.steps.length, 1);
  assert.equal(result.failed_count, 0, 'an optional discovery probe must not count as a failure');
});

// format_option_id is optional in canonical-format-option.json. Requiring it would let
// the optional discovery phase silently skip a canonical path the seller can actually serve.
test('inline creatives: a canonical option with no stable format_option_id still completes', async () => {
  const { result, calls } = await runInline({ canonical: true, legacy: false, namedOption: false });
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  // The ref-based path correctly stands down; the unnamed-option path carries the seller.
  const refPath = result.phases.find(phase => phase.phase_id === 'canonical_format_inline_path');
  assert.equal(refPath.steps.length, 0, 'the ref path cannot run without a format_option_id');
  const unnamedPath = result.phases.find(phase => phase.phase_id === 'canonical_unnamed_option_inline_path');
  assert.equal(unnamedPath.passed, true);
  assert.ok(unnamedPath.steps.length > 0, 'an advertised unnamed canonical option must not be silently skipped');
  const create = calls.find(call => call.task === 'create_media_buy');
  assert.equal(create.request.packages[0].creatives[0].format_kind, 'image');
  // Nothing may reference an id the seller never published.
  assert.equal(JSON.stringify(create.request).includes('format_option_id'), false);
});

// A discovery call that hard-errors is NOT the same as a seller that does not publish
// the representation. The probe stays visible instead of being regraded away, so the
// gap is reported even though the other path carries the run.
test('inline creatives: a failed discovery call stays visible rather than being hidden', async () => {
  const { result } = await runInline({ canonical: true, legacy: true, failDiscovery: 'canonicalPath' });
  const phases = result.phases;
  const discovery = phases.find(phase => phase.phase_id === 'canonical_format_discovery');
  assert.equal(discovery.steps.length, 1, 'the failed discovery probe must still be reported');
  assert.equal(discovery.steps[0].passed, false, 'it must not be regraded away as a moot peer branch');
  // The ref path stands down because nothing was captured, and legacy still carries coverage.
  assert.equal(phases.find(phase => phase.phase_id === 'canonical_format_inline_path').steps.length, 0);
  assert.equal(phases.find(phase => phase.phase_id === 'legacy_format_inline_path').passed, true);
});

test('inline creatives: no usable representation cannot pass by skipping both paths', async () => {
  const { result } = await runInline({ canonical: false, legacy: false });
  assert.equal(result.overall_passed, false);
});

test('inline creatives: an advertised path failure is not hidden by the other path passing', async () => {
  const { result } = await runInline({ canonical: true, legacy: true, failCanonical: true });
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
    const phases = result.phases;
    assert.equal(phases.find(phase => phase.phase_id === 'canonical_format_inline_path').passed, false);
    assert.equal(
      phases.find(phase => phase.phase_id === 'legacy_format_inline_path').passed,
      true,
      JSON.stringify(
        phases
          .find(phase => phase.phase_id === 'legacy_format_inline_path')
          .steps.map(step => ({
            id: step.step_id,
            error: step.error,
            validations: step.validations.filter(v => !v.passed),
          }))
      )
    );
  });
}
