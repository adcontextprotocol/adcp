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
      if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
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

/** Build the product a `get_products` response advertises for one discovery call. */
function advertisedProduct({ product_id = 'advertised-product', canonical, legacy, suffix = '', namedCanonical = true }) {
  return {
    product_id,
    pricing_options: [{ pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
    ...(canonical && {
      format_options: [
        namedCanonical ? { format_kind: 'image', format_option_id: `image${suffix}` } : { format_kind: 'image' },
      ],
    }),
    ...(legacy && {
      format_ids: [{ agent_url: 'https://creative.example/', id: `non-projectable-legacy${suffix}` }],
    }),
  };
}

/**
 * Drive the inline storyboard against a scripted seller.
 *
 * `products` is called with the path that issued the `get_products`
 * (`'canonical'` / `'legacy'`, derived from the step's correlation_id) plus the
 * zero-based call index, so a test can hand each path a different first
 * product. Keying on the path rather than the index keeps these tests honest if
 * a phase is ever added or reordered.
 */
test('inline creatives: each path phase is gated on its own discovery capture', () => {
  // The repo's pinned runner ignores a `skip_if` that reads context, so the
  // behavioral tests below cannot observe this guard — assert it statically.
  // Runners that DO evaluate skip_if against context fail an all-skipped
  // non-optional phase, so without the guard a conformant canonical-only or
  // legacy-only seller fails there. Each expression must name that path's own
  // capture, so the gate and the buy come from one get_products response.
  const storyboard = YAML.parse(fs.readFileSync(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'), 'utf8'));
  const gates = {
    canonical_format_inline_path: '!context.canonical_format_option_id',
    canonical_unnamed_format_inline_path:
      '!context.canonical_unnamed_format_kind || context.canonical_format_option_id',
    legacy_format_inline_path: '!context.legacy_format_id',
  };
  for (const [phaseId, expected] of Object.entries(gates)) {
    const phase = storyboard.phases.find(p => p.id === phaseId);
    assert.ok(phase, `phase ${phaseId} is missing`);
    assert.equal(phase.skip_if, expected, `${phaseId} must be gated on its own discovery capture`);
    assert.notEqual(phase.optional, true, `${phaseId} must stay non-optional so an advertised path's failure is fatal`);
    const captureKey = expected.split('||')[0].trim().replace('!context.', '');
    const discovery = storyboard.phases.find(p => p.id === phase.depends_on[0]);
    assert.ok(
      discovery.steps.some(step => (step.context_outputs ?? []).some(o => o.key === captureKey)),
      `${phaseId} gates on ${captureKey}, which ${phase.depends_on[0]} must capture`
    );
  }

  // The unnamed route's second gate: on runners that cannot read context in
  // skip_if, this probe is what stops a selector-less purchase reaching a
  // product whose same-kind format_options need a format_option_ref.
  const unnamedProbe = storyboard.phases
    .find(p => p.id === 'canonical_unnamed_format_discovery')
    .steps[0].validations.find(v => v.check === 'field_absent');
  assert.ok(unnamedProbe, 'unnamed discovery must require format_option_id to be absent');
  assert.equal(unnamedProbe.path, 'products[0].format_options[0].format_option_id');
});

async function runInline({ canonical, legacy, failCanonical = false, readback = 'replacement', products, namedCanonical = true, rejectSelectorLess }) {
  const storyboard = loadStoryboardFile(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'));
  // Only `response_schema` is dropped: the scripted seller returns minimal
  // bodies and the independent storyboard schema lints cover that portion of
  // grading. Every other authored check stays graded, so a storyboard that
  // asserts the wrong field still fails here.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
    }
  }
  const calls = [];
  const created = new Map();
  const client = {
    executeTask: async (task, request) => {
      calls.push({ task, request });
      const correlation = request.context?.correlation_id ?? '';
      const pathName = correlation.includes('canonical_unnamed')
        ? 'canonical-unnamed'
        : correlation.includes('canonical')
          ? 'canonical'
          : 'legacy';
      const isCanonical = pathName === 'canonical';
      let data = task === 'comply_test_controller' ? { success: true, scenario: request.scenario } : {};
      if (task === 'get_adcp_capabilities') {
        data = {
          context: request.context,
          supported_protocols: ['mcp'],
          media_buy: { features: { inline_creative_management: true } },
        };
      } else if (task === 'get_products') {
        data = {
          context: request.context,
          products: products
            ? products({ path: pathName, index: callsTo(calls, 'get_products').length - 1 })
            : [advertisedProduct({ canonical, legacy, namedCanonical })],
        };
      } else if (task === 'create_media_buy') {
        if (failCanonical && isCanonical) return { success: false, error: 'inline creative rejected' };
        const requested = request.packages[0];
        const hasSelector =
          requested.format_option_refs !== undefined ||
          requested.format_ids !== undefined ||
          requested.format_kind !== undefined;
        if (!hasSelector && rejectSelectorLess) rejectSelectorLess();
        const media_buy_id = `${pathName}-buy`;
        created.set(pathName, {
          package_id: 'package',
          product_id: requested.product_id,
          pricing_option_id: requested.pricing_option_id,
          budget: requested.budget,
          context: { buyer_ref: requested.context?.buyer_ref },
        });
        data = {
          context: request.context,
          media_buy_id,
          packages: [{ package_id: 'package', context: { buyer_ref: requested.context?.buyer_ref } }],
        };
      } else if (task === 'update_media_buy') {
        // Echo the package the create step actually bought, so the storyboard's
        // `field_contains affected_packages[*]` check really grades that the
        // purchased product and pricing option came from this path's discovery.
        data = {
          context: request.context,
          media_buy_id: request.media_buy_id,
          affected_packages: [created.get(pathName)],
        };
      } else if (task === 'get_media_buys') {
        const brokenReadback = pathName.startsWith('canonical');
        const approvals =
          brokenReadback && readback === 'missing'
            ? []
            : [
                {
                  creative_id: `acme-inline-${pathName}-display-${
                    brokenReadback && readback === 'original' ? 'v1' : 'v2'
                  }`,
                },
              ];
        data = {
          context: request.context,
          media_buys: [
            {
              media_buy_id: request.media_buy_ids[0],
              packages: [{ package_id: 'package', creative_approvals: approvals }],
            },
          ],
        };
      }
      return { success: true, status: 'completed', data };
    },
  };
  const tools = [
    'comply_test_controller',
    'get_adcp_capabilities',
    'get_products',
    'create_media_buy',
    'update_media_buy',
    'get_media_buys',
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

/** Which of the three format routes issued a recorded call. */
const routeOf = call => {
  const c = call.request.context?.correlation_id ?? '';
  return c.includes('canonical_unnamed') ? 'canonical-unnamed' : c.includes('canonical') ? 'canonical' : 'legacy';
};
const routesThatBought = calls => [...new Set(callsTo(calls, 'create_media_buy').map(routeOf))].sort();

const callsTo = (calls, task) => calls.filter(call => call.task === task);
const forPath = (entries, name) => entries.find(call => routeOf(call) === name);
const phaseOf = (result, id) => result.phases.find(phase => phase.phase_id === id);

/** Compact failure digest — only failing steps, so an assert message stays small. */
function digest(result) {
  return JSON.stringify(
    result.phases.map(phase => ({
      phase: phase.phase_id,
      passed: phase.passed,
      failed: phase.steps
        .filter(step => !step.passed)
        .map(step => ({
          id: step.step_id,
          skip: step.skip_reason,
          error: step.error,
          checks: (step.validations ?? []).filter(v => !v.passed).map(v => v.description ?? v.check),
        })),
    }))
  );
}

function assertOverall(result, expected) {
  if (result.overall_passed !== expected)
    assert.fail(`overall_passed was ${result.overall_passed}, expected ${expected}: ${digest(result)}`);
}

function assertPhase(result, id, expected) {
  const phase = phaseOf(result, id);
  assert.ok(phase, `phase ${id} is missing from the result`);
  if (phase.passed !== expected) assert.fail(`phase ${id} passed=${phase.passed}, expected ${expected}: ${digest(result)}`);
}

// The unnamed canonical route is gated twice: a phase-level `skip_if` for
// runners that read context, and a `field_absent` probe on the discovery step
// for those that don't. A named product fails that probe, so its captures are
// never promoted and the route cannot fire on any runner.
for (const [name, seller, expectedRoutes] of [
  ['canonical only (named)', { canonical: true, legacy: false }, ['canonical']],
  ['canonical only (unnamed)', { canonical: true, legacy: false, namedCanonical: false }, ['canonical-unnamed']],
  ['legacy only', { canonical: false, legacy: true }, ['legacy']],
  ['dual emission', { canonical: true, legacy: true }, ['canonical', 'legacy']],
]) {
  test(`inline creatives: ${name} runs only advertised format paths`, async () => {
    const { result, calls } = await runInline(seller);
    assertOverall(result, true);
    assert.deepEqual(routesThatBought(calls), expectedRoutes);
    const creates = callsTo(calls, 'create_media_buy');
    assert.equal(callsTo(calls, 'update_media_buy').length, creates.length);
    assert.equal(callsTo(calls, 'get_media_buys').length, creates.length);
    assert.equal(callsTo(calls, 'sync_creatives').length, 0);
    // Three independent probes, one per route — never shared.
    assert.equal(callsTo(calls, 'get_products').length, 3);
    if (expectedRoutes.includes('canonical')) {
      const pkg = forPath(creates, 'canonical').request.packages[0];
      assert.equal(pkg.format_option_refs[0].format_option_id, 'image');
      assert.equal(pkg.creatives[0].format_kind, 'image');
    }
    if (expectedRoutes.includes('canonical-unnamed')) {
      const pkg = forPath(creates, 'canonical-unnamed').request.packages[0];
      // The whole point of this route: no package selector at all, the
      // creative carries format_kind alone.
      assert.equal(pkg.format_option_refs, undefined, 'unnamed route must not send format_option_refs');
      assert.equal(pkg.format_ids, undefined);
      assert.equal(pkg.format_kind, undefined);
      assert.equal(pkg.creatives[0].format_kind, 'image');
      assert.equal(pkg.creatives[0].format_id, undefined);
    }
    if (expectedRoutes.includes('legacy')) {
      assert.deepEqual(forPath(creates, 'legacy').request.packages[0].creatives[0].format_id, {
        agent_url: 'https://creative.example/',
        id: 'non-projectable-legacy',
      });
    }
  });
}

test('inline creatives: a named same-kind catalog never receives a selector-less purchase', async () => {
  // Two format_options sharing one format_kind: bare format_kind is ambiguous,
  // so format_option_ref is required and a correct seller rejects a package
  // with no selector. The unnamed route must not fire against such a product.
  let selectorLessRejections = 0;
  const { result, calls } = await runInline({
    canonical: true,
    legacy: false,
    rejectSelectorLess: () => (selectorLessRejections += 1),
    products: () => [
      {
        product_id: 'ambiguous-named-product',
        pricing_options: [
          { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 },
        ],
        format_options: [
          { format_kind: 'image', format_option_id: 'image-300x250' },
          { format_kind: 'image', format_option_id: 'image-728x90' },
        ],
      },
    ],
  });
  assert.deepEqual(routesThatBought(calls), ['canonical'], 'only the named route may buy here');
  assert.equal(selectorLessRejections, 0, 'no selector-less purchase may reach a named same-kind catalog');
  assertOverall(result, true);
});

test('inline creatives: an unnamed same-kind-free catalog is bought by format_kind alone', async () => {
  let selectorLess = 0;
  const { result, calls } = await runInline({
    canonical: true,
    legacy: false,
    namedCanonical: false,
    rejectSelectorLess: () => (selectorLess += 1),
  });
  assert.deepEqual(routesThatBought(calls), ['canonical-unnamed']);
  assert.equal(selectorLess, 1, 'the unnamed route is exactly the selector-less purchase');
  assertOverall(result, true);
});

test('inline creatives: no usable representation cannot pass by skipping both paths', async () => {
  const { result } = await runInline({ canonical: false, legacy: false });
  assertOverall(result, false);
});

test('inline creatives: an advertised path failure is not hidden by the other path passing', async () => {
  const { result } = await runInline({ canonical: true, legacy: true, failCanonical: true });
  assertOverall(result, false);
  assertPhase(result, 'canonical_format_inline_path', false);
});

for (const readback of ['missing', 'original']) {
  test(`inline creatives: ${readback} replacement approval fails readback`, async () => {
    const { result } = await runInline({ canonical: true, legacy: false, readback });
    assertOverall(result, false);
    const read = result.phases
      .flatMap(phase => phase.steps)
      .find(step => step.step_id === 'get_canonical_media_buy_after_inline_replacement');
    assert.ok(read, 'canonical readback step is missing from the result');
    assert.equal(read.passed, false);
    const coverage = result.phases
      .flatMap(phase => phase.steps)
      .find(step => step.step_id === 'assert_inline_creative_path');
    assert.ok(coverage, 'coverage assertion step is missing from the result');
    assert.equal(coverage.passed, false, 'failed readback must not contribute coverage');
  });
}

for (const readback of ['missing', 'original']) {
  test(`inline creatives: ${readback} canonical approval fails even when legacy readback passes`, async () => {
    const { result } = await runInline({ canonical: true, legacy: true, readback });
    assertOverall(result, false);
    assertPhase(result, 'canonical_format_inline_path', false);
    assertPhase(result, 'legacy_format_inline_path', true);
  });
}

test('inline creatives: each path buys the product its own discovery response returned', async () => {
  // Both discovery calls advertise both representations but name a different
  // first product. Each path must buy the product and format ITS OWN discovery
  // response returned — never a product observed on the other path's call.
  // This is the regression for a gate read from a different call than the buy.
  const { result, calls } = await runInline({
    canonical: true,
    legacy: true,
    products: ({ path: pathName }) => [
      advertisedProduct({
        product_id: `product-from-${pathName}-call`,
        canonical: true,
        legacy: true,
        suffix: `-${pathName}`,
      }),
    ],
  });
  assertOverall(result, true);
  const creates = callsTo(calls, 'create_media_buy');
  assert.deepEqual(routesThatBought(calls), ['canonical', 'legacy']);
  const canonicalPackage = forPath(creates, 'canonical').request.packages[0];
  assert.equal(canonicalPackage.product_id, 'product-from-canonical-call');
  assert.equal(canonicalPackage.pricing_option_id, 'fixed-cpm');
  assert.equal(canonicalPackage.format_option_refs[0].format_option_id, 'image-canonical');
  assert.equal(canonicalPackage.creatives[0].format_kind, 'image');
  const legacyPackage = forPath(creates, 'legacy').request.packages[0];
  assert.equal(legacyPackage.product_id, 'product-from-legacy-call');
  assert.deepEqual(legacyPackage.creatives[0].format_id, {
    agent_url: 'https://creative.example/',
    id: 'non-projectable-legacy-legacy',
  });
});

test('inline creatives: a representation that moves between discovery calls still grades both paths', async () => {
  // The canonical path's discovery call advertises only format_options; the
  // legacy path's advertises only format_ids, on a different product. A gate
  // read from one shared call would have declared one representation
  // unavailable and skipped a path the seller does publish.
  const { result, calls } = await runInline({
    canonical: true,
    legacy: true,
    products: ({ path: pathName }) => [
      pathName === 'canonical'
        ? advertisedProduct({ product_id: 'canonical-only-product', canonical: true, legacy: false })
        : advertisedProduct({ product_id: 'legacy-only-product', canonical: false, legacy: true }),
    ],
  });
  assertOverall(result, true);
  const creates = callsTo(calls, 'create_media_buy');
  assert.equal(creates.length, 2);
  assert.equal(forPath(creates, 'canonical').request.packages[0].product_id, 'canonical-only-product');
  assert.equal(forPath(creates, 'legacy').request.packages[0].product_id, 'legacy-only-product');
});

test('KNOWN LIMIT: a representation withheld from its own discovery call is not graded', async () => {
  // Documented, not desired. The gate is a seller self-declaration on a
  // brief-driven response, and no capability flag declares which format
  // representations a seller emits, so the storyboard cannot cross-check it.
  // A seller with a broken canonical path can withhold format_options from the
  // canonical discovery call and pass on legacy alone. Asserting the current
  // behavior here means a future tightening fails this test loudly instead of
  // changing grading silently. Tracked in the changeset.
  const { result, calls } = await runInline({
    canonical: true,
    legacy: true,
    failCanonical: true,
    products: ({ path: pathName }) => [
      advertisedProduct({ canonical: !pathName.startsWith('canonical'), legacy: true }),
    ],
  });
  assert.deepEqual(routesThatBought(calls), ['legacy'], 'no canonical route was exercised');
  assertOverall(result, true);
  assertPhase(result, 'canonical_format_discovery', false);
});
