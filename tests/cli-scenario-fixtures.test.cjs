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
    assert.ok(canonicalProbes > 0, 'these storyboards probe canonical creatives');
    assert.equal(legacyProbes, 0, 'the provenance storyboards carry no legacy creative probe');
  });
}

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
  // Prepends a declaration of a DIFFERENT canonical kind. The product still accepts
  // image, so it legitimately matches filters.format_kinds: ['image'].
  leadKind = null,
}) {
  const first = DECLARATIONS[shape]();
  return {
    product_id,
    pricing_options: [{ pricing_option_id, pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
    ...(canonical && {
      format_options: [
        ...(leadKind ? [{ format_kind: leadKind, params: { duration_ms_exact: 15000 }, format_option_id: 'lead_option' }] : []),
        first,
        ...(sameKindCatalog ? [{ ...DECLARATIONS[shape](), format_option_id: `${first.format_option_id ?? 'image'}_premium` }] : []),
      ],
    }),
    ...(legacy && { format_ids: [{ agent_url: 'https://creative.example/', id: 'non-projectable-legacy' }] }),
  };
}

async function runInline({
  canonical,
  legacy,
  shape = 'product',
  failLane = null,
  readback = 'replacement',
  drift = {},
  failDiscovery = null,
  sameKindCatalog = false,
  filterLegacyDiscovery = false,
  leadKind = null,
}) {
  const storyboard = loadStoryboardFile(path.join(SCENARIOS, 'inline_creatives_without_sync.yaml'));
  // Strip only response_schema: the stub returns deliberately minimal payloads that are
  // not full schema instances, and independent schema lints already cover that grading.
  // Everything else stays live - an allowlist here would silently stop grading any step
  // kind added to the storyboard later.
  let legacyProbeFiltered = 0;
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
      // Simulates the proposed change: narrow legacy discovery by canonical kind too.
      if (filterLegacyDiscovery && step.id === 'get_products_legacy_format') {
        step.sample_request.filters.format_kinds = ['image'];
        legacyProbeFiltered += 1;
      }
    }
  }
  if (filterLegacyDiscovery) {
    assert.equal(legacyProbeFiltered, 1, 'the legacy discovery step must have been found and filtered');
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
        // A seller honouring filters.format_kinds returns nothing for a legacy-only
        // product whose format_id has no canonical projection: it accepts no canonical
        // kind, so it cannot match the filter.
        if (request.filters?.format_kinds && !canonical) {
          return { success: true, status: 'completed', data: { ...echo, products: [] } };
        }
        const product = buildProduct({
          canonical,
          legacy,
          shape,
          sameKindCatalog,
          leadKind,
          ...(drift[discoveryKey(request)] ?? {}),
        });
        // Frozen so that if the SDK ever stops aliasing the captured object, a
        // write-back throws here rather than leaving the no-mutation assertion vacuous.
        for (const declaration of product.format_options ?? []) servedDeclarations.push(Object.freeze(declaration));
        data = { ...echo, products: [product] };
      } else if (task === 'create_media_buy') {
        if (failLane === lane) return { success: false, error: 'inline creative rejected' };
        const requested = request.packages[0];
        // A seller that published a selectable id requires a ref naming it. A legacy
        // package is selector-bearing by other means - the creative carries format_id.
        const declarations = buildProduct({ canonical, legacy, shape, sameKindCatalog, leadKind }).format_options ?? [];
        const published = declarations[0];
        // A product whose declarations share one format_kind cannot be routed by
        // format_kind alone, so a correct seller REQUIRES a disambiguating ref. Gate on
        // the actual ambiguity rather than on `[0]` carrying an id, so the same-kind
        // case is a real negative control instead of a restatement of the named case.
        const ambiguous =
          declarations.filter(option => option.format_kind === published?.format_kind).length > 1;
        if (
          (ambiguous || published?.format_option_id) &&
          !requested.format_option_refs &&
          !requested.creatives?.[0]?.format_id
        ) {
          return { success: false, error: 'format_option_refs[] is required to disambiguate same-kind format options' };
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
        if (!buys.has(lane)) return { success: false, error: `no buy established for lane ${lane}` };
        data = { ...echo, media_buy_id: request.media_buy_id, affected_packages: [buys.get(lane).package] };
      } else if (task === 'get_media_buys') {
        if (!buys.has(lane)) return { success: false, error: `no buy established for lane ${lane}` };
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
// fixture uses - has no canonical projection, so there is no format_kind to match. And
// core/product-filters.json defines format_kinds as "Filter to products accepting any
// of these canonical format kinds", which such a product does not.
//
// So a seller correctly honouring the filter would exclude itself from legacy
// discovery, and the legacy path - the whole point of the fix - would stop being
// graded. Applicability is documented on the probe instead of filtered for.
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

// The concrete loss if the filter were added, measured against the SAME conformant stub
// the other cases use: a legacy-only seller honouring format_kinds returns no product,
// the legacy gate never opens, and the run fails the coverage gate having bought nothing.
// The unfiltered control directly above is what makes this attributable to the filter.
test('inline creatives: filtering legacy discovery costs a legacy-only seller its only path', async () => {
  const unfiltered = await runInline({ canonical: false, legacy: true });
  assert.equal(unfiltered.result.overall_passed, true, 'control: the legacy-only seller passes today');
  assert.equal(unfiltered.creates.length, 1);

  const filtered = await runInline({ canonical: false, legacy: true, filterLegacyDiscovery: true });
  assert.equal(filtered.result.overall_passed, false, 'the filter removes the seller\'s only gradeable path');
  assert.equal(filtered.creates.length, 0, 'nothing is bought because the gate never opened');
  assert.equal(
    filtered.result.phases.find(phase => phase.phase_id === 'legacy_format_inline_path').steps.length,
    0,
    'the legacy execution phase stands down'
  );
  const coverage = filtered.result.phases
    .flatMap(phase => phase.steps)
    .find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'the coverage gate is what reports the loss');
});


// Negative control for the same-kind case: proves the stub's rejection branch is
// reachable, which is what makes the positive assertion above meaningful. A seller
// publishing two declarations that share one format_kind with NO format_option_id
// violates product-format-declaration.json ("REQUIRED when a product contains multiple
// declarations with the same format_kind"). format_kind alone cannot route it, so the
// unnamed path's selector-less purchase is correctly rejected and the run fails.
test('inline creatives: an ambiguous unnamed same-kind catalog is failed, not silently bought', async () => {
  const { result, creates } = await runInline({
    canonical: true,
    legacy: false,
    shape: 'unnamed',
    sameKindCatalog: true,
  });
  assert.equal(result.overall_passed, false, 'a selector-less buy against an ambiguous catalog must fail');
  assert.equal(creates.length, 1, 'the unnamed path does attempt the buy');
  assert.equal(
    creates[0].request.packages[0].format_option_refs,
    undefined,
    'and it carries no ref, which is exactly why the seller rejects it'
  );
});


// filters.format_kinds narrows to products that ACCEPT image; it does not constrain
// format_options[0]. A conformant multi-kind product may therefore lead with another
// kind, and capturing that declaration would ship a 300x250 image asset under
// format_kind: "video_hosted" - which a correct seller rejects, on a NON-optional
// phase. The field_value guard on the optional discovery probe is what prevents it.
test('inline creatives: a product leading with another format kind never gets a mismatched buy', async () => {
  const { result, calls, creates, ranPhases } = await runInline({
    canonical: true,
    legacy: true,
    shape: 'product',
    leadKind: 'video_hosted',
  });
  // Nothing may be bought under the lead declaration's kind.
  for (const create of creates) {
    for (const creative of create.request.packages[0].creatives ?? []) {
      assert.notEqual(
        creative.format_kind,
        'video_hosted',
        'an image asset must never be shipped under the lead declaration kind'
      );
    }
    assert.notEqual(
      create.request.packages[0].format_option_refs?.[0]?.format_option_id,
      'lead_option',
      'no ref may select the mismatched lead declaration'
    );
  }
  // All three canonical gates close; here the legacy path still carries the run.
  assert.deepEqual(ranPhases, ['legacy_format_inline_path']);
  assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
  // The canonical probe is where it is reported, and it is optional so it does not gate.
  const probe = result.phases
    .find(phase => phase.phase_id === 'canonical_format_discovery')
    .steps.find(step => step.task === 'get_products');
  assert.equal(probe.passed, false, 'the mismatch is reported on the optional discovery probe');
  assert.equal(calls.filter(call => call.task === 'create_media_buy').length, 1);
});


// The guard detects a mismatch; it does NOT select a compatible declaration. A
// canonical-ONLY seller leading with another kind is therefore not graded on any
// canonical path, and with no legacy representation to carry it the closing
// assert_contribution fails the run. Pinned so the guard is never mistaken for
// order-independent format selection, and so the real applicability limit stays visible.
test('inline creatives: a canonical-only catalog leading with another kind fails the coverage gate', async () => {
  const { result, creates, ranPhases } = await runInline({
    canonical: true,
    legacy: false,
    shape: 'product',
    leadKind: 'video_hosted',
  });
  assert.equal(result.overall_passed, false, 'the guard does not rescue a mismatched first declaration');
  assert.deepEqual(ranPhases, [], 'no canonical path is graded');
  assert.equal(creates.length, 0, 'and crucially, nothing mismatched is ever bought');
  const coverage = result.phases
    .flatMap(phase => phase.steps)
    .find(step => step.task === 'assert_contribution');
  assert.equal(coverage.passed, false, 'the coverage gate is what reports it');
});
