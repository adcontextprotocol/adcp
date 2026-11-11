// Structural guarantees: core never depends on extensions, the core delta is
// exactly core/patches.json, each hook is declared by the layer that owns the
// host schema (the kernel lists none of a module's), every vendored file sits in
// its final-layout layer, the layout's rules hold on the vendored subset with zero
// violations after the 3.4 fixes in core/patches.json, and digests are reproducible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { coreUri, loadCoreSchemas } from '../lib/core-schemas.mjs';
import { digestOfValue, jcs, sha256Digest } from '../lib/digest.mjs';
import { KERNEL, annotatedHooks, applyPatches, hooksByLayer, layerDigests, placement, readPatches } from '../scripts/build-core.mjs';
import { lint } from '../scripts/layout-lint.mjs';
import { COMPAT, COMPAT_ASSEMBLY, layerOfLabel } from '../scripts/vendor-core.mjs';
import * as L from '../lib/layout.mjs';
import { refOccurrences } from '../lib/layout.mjs';
import { buildBundle, extensionPackages, lintExtensionRefs } from '../scripts/build-extensions.mjs';
import * as F from '../fixtures/payloads.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const core = loadCoreSchemas();
const coreIds = new Set(core.map((s) => s.id));
const layerOf = placement();
const owner = (id) => layerOf[id.replace(/^\/schemas\//, '')];

function* refsOf(node) {
  if (Array.isArray(node)) for (const v of node) yield* refsOf(v);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref') yield v;
      else yield* refsOf(v);
    }
}

test('lint: every core $ref stays inside core', () => {
  const outside = [];
  for (const { id, schema } of core) {
    for (const ref of refsOf(schema)) {
      if (ref.startsWith('#')) continue;
      if (!coreIds.has(ref.split('#')[0])) outside.push(`${id} -> ${ref}`);
    }
  }
  assert.deepEqual(outside, []);
});

test('lint: no core schema names an extension, and @adcp/core imports nothing', () => {
  const extUris = extensionPackages().map((d) => JSON.parse(readFileSync(path.join(d, 'extension.json'), 'utf8')).id);
  const all = core.map((s) => JSON.stringify(s.schema)).join('\n');
  for (const uri of extUris) assert.equal(all.includes(uri), false, uri);
  assert.doesNotMatch(read('packages/core/src/index.ts'), /^import /m);
  assert.deepEqual(JSON.parse(read('packages/core/package.json')).dependencies, {});
});

test('lint: an extension may $ref core by absolute URI, but nothing cross-origin', () => {
  const ok = { definitions: { A: { $ref: 'https://adcontextprotocol.org/schemas/core/duration.json' } } };
  assert.deepEqual(lintExtensionRefs(ok, coreIds), []);
  const bad = { definitions: { A: { $ref: 'https://evil.example.com/x.json' }, B: { $ref: '/schemas/core/duration.json' } } };
  assert.equal(lintExtensionRefs(bad, coreIds).length, 2);
  const missing = { definitions: { A: { $ref: 'https://adcontextprotocol.org/schemas/core/nope.json' } } };
  assert.match(lintExtensionRefs(missing, coreIds)[0], /not in the pinned core bundle/);
});

test('core/upstream is byte-identical to adcp-main, and core/schemas = upstream + core/patches.json', () => {
  const upstream = JSON.parse(read('core/UPSTREAM.json'));
  for (const [file, digest] of Object.entries(upstream.files)) {
    assert.equal(sha256Digest(readFileSync(path.join(ROOT, 'core/upstream', file))), digest, file);
  }
  const changed = applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)));
  for (const { file, schema } of core) {
    const rel = path.relative(path.join(ROOT, 'core/schemas'), file);
    const expected = changed.get(rel) ?? JSON.parse(read(`core/upstream/${rel}`));
    assert.deepEqual(schema, expected, rel);
  }
  // Grouped by owning layer: the kernel adds the mechanism, each module opens its own hooks.
  const owner = placement();
  const byLayer = {};
  for (const file of changed.keys()) (byLayer[owner[file]] ??= []).push(file);
  for (const files of Object.values(byLayer)) files.sort();
  assert.deepEqual(byLayer, {
    core: ['core/extension-branch-id.json', 'core/extension-declaration.json', 'core/extension-entry.json', 'core/extension-hook.json', 'core/version-envelope.json'],
    _assembly: ['protocol/get-adcp-capabilities-response.json'],
    'buying/pricing': [
      'core/canonical-pricing-option.json',
      'core/pricing-option.json',
      'pricing-options/cpm-option.json',
      'pricing-options/cpp-option.json',
      'pricing-options/extension-option.json',
    ],
    'buying/commitment': ['core/product-audience-evidence-requirements.json', 'media-buy/commercial-terms.json'],
    // The offer layer only lets its closed requests carry the kernel envelope's understood_extensions, by $ref.
    'buying/offer': ['media-buy/refine-proposals-request.json', 'media-buy/request-proposals-request.json'],
    'buying/execution': ['core/package-format-snapshot.json', 'media-buy/get-media-buys-response.json'],
    // The layout's 3.4 fixes, each wire-preserving: kernel types with registry composition, and bridge points.
    'kernel-types': ['core/brand-ref.json', 'core/format-kind-id.json', 'core/indicator-type-id.json', 'core/indicator.json', 'core/media-asset.json'],
    accounts: ['core/account.json'],
    'buying/supply': [
      'core/audience-evidence-requirements.json',
      'core/audience-evidence-selection.json',
      'core/canonical-audience-evidence.json',
      'core/canonical-placement.json',
      'core/canonical-product.json',
      'core/collection.json',
      'core/placement.json',
      'core/product-card-reference-asset.json',
      'core/product-filters.json',
      'core/product-offer-filters.json',
      'core/spot-reporting-capability.json',
    ],
  });
  for (const file of ['media-buy/request-proposals-request.json', 'media-buy/refine-proposals-request.json']) {
    assert.deepEqual(changed.get(file).properties.understood_extensions, { $ref: '/schemas/core/version-envelope.json#/properties/understood_extensions' }, file);
  }
  assert.ok(changed.get('core/version-envelope.json').properties.understood_extensions.items);
});

test('a patch can only touch files its own layer owns, and every op is additive or wire-preserving', () => {
  const layers = readPatches();
  const steal = structuredClone(layers);
  steal.find((l) => l.layer === KERNEL).patches.push({ op: 'add', file: 'media-buy/commercial-terms.json', pointer: '/properties/x', value: {} });
  assert.throws(() => applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), steal), /belongs to layer buying\/commitment/);
  // A module can't patch another module's file either: kernel types and creative are not buying's.
  const cross = structuredClone(layers);
  cross.find((l) => l.layer === 'buying/pricing').patches.push({ op: 'add', file: 'core/duration.json', pointer: '/x-note', value: 'x' });
  assert.throws(() => applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), cross), /belongs to layer kernel-types/);
  // Nor can one buying layer patch another's: commercial_terms is commitment's, not pricing's.
  const sibling = structuredClone(layers);
  sibling.find((l) => l.layer === 'buying/pricing').patches.push({ op: 'add', file: 'media-buy/commercial-terms.json', pointer: '/x-note', value: 'x' });
  assert.throws(() => applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), sibling), /belongs to layer buying\/commitment/);
  const replace = structuredClone(layers);
  replace.find((l) => l.layer === 'buying/pricing').patches.push({ op: 'replace', file: 'pricing-options/cpp-option.json', pointer: '/required', value: [] });
  assert.throws(() => applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), replace), /unsupported op/);
  // compose checks the $ref it replaces.
  const wrongRef = structuredClone(layers);
  wrongRef.find((l) => l.layer === 'buying/supply').patches.push({ op: 'compose', file: 'core/product-filters.json', pointer: '/properties/format_kinds/items', ref: '/schemas/enums/indicator-type.json' });
  assert.throws(() => applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), wrongRef), /expected a \$ref to \/schemas\/enums\/indicator-type.json/);
  // widen keeps the upstream schema as its first branch: everything valid before stays valid.
  const widened = JSON.parse(read('core/schemas/core/canonical-pricing-option.json')).properties.pricing_model;
  assert.deepEqual(widened.anyOf[0], JSON.parse(read('core/upstream/core/canonical-pricing-option.json')).properties.pricing_model);
});

test('hooks: the kernel declares only its own; each buying layer declares hooks on its own schemas; one owner per hook', () => {
  const hooks = annotatedHooks();
  const owners = Object.fromEntries(Object.entries(hooksByLayer(hooks)).map(([l, h]) => [l, Object.keys(h).sort()]));
  assert.deepEqual(owners, {
    core: ['capabilities', 'task'],
    'buying/pricing': ['pricing_model', 'pricing_option'],
    'buying/commitment': ['commercial_terms'],
    'buying/execution': ['media_buy_state'],
  });
  // The owner labels the extension docs (npm run docs) print for each hook.
  assert.deepEqual(Object.fromEntries(hooks.map((h) => [h.name, L.ownerLabel(h.layer)])), {
    capabilities: 'kernel (core)',
    task: 'kernel (core)',
    pricing_model: 'buying (pricing layer)',
    pricing_option: 'buying (pricing layer)',
    commercial_terms: 'buying (commitment layer)',
    media_buy_state: 'buying (execution layer)',
  });
  // The kernel's own hooks (the capability fragment and the task union) sit on the kernel's own type, not on a module's object.
  assert.deepEqual([...new Set(hooks.filter((h) => h.layer === KERNEL).map((h) => h.id))], ['/schemas/core/extension-declaration.json']);
  // No kernel schema enumerates module hook names (extension-declaration.points is an open name).
  const kernelText = core.filter((s) => owner(s.id) === KERNEL).map((s) => JSON.stringify(s.schema)).join('\n');
  for (const name of ['pricing_option', 'commercial_terms', 'media_buy_state', 'pricing_model']) {
    assert.equal(kernelText.includes(`"${name}"`), false, `kernel names the ${name} hook`);
  }
  // Every annotation validates against the kernel's hook vocabulary.
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const { id, schema } of core) ajv.addSchema({ ...schema, $id: coreUri(id) });
  const hookSchema = coreUri('/schemas/core/extension-hook.json');
  for (const h of hooks) {
    const def = h.kind === 'extension-point' ? 'ExtensionPoint' : 'OpenUnion';
    assert.equal(ajv.validate(`${hookSchema}#/definitions/${def}`, h.value), true, `${h.id} ${h.name}: ${JSON.stringify(ajv.errors)}`);
  }
  // release.json lists exactly the annotated hooks per layer.
  const release = JSON.parse(read('core/release.json'));
  for (const [layer, names] of Object.entries(owners)) assert.deepEqual(Object.keys(release.layers[layer].hooks).sort(), names, layer);
});

test('frozen per layer: every layer hashes to its core/release.json digest', () => {
  const release = JSON.parse(read('core/release.json'));
  const digests = layerDigests();
  assert.deepEqual(Object.keys(digests).sort(), Object.keys(release.layers).sort());
  for (const [layer, digest] of Object.entries(digests)) assert.equal(release.layers[layer].digest, digest, layer);
  assert.equal(release.layers.core.role, 'kernel');
  assert.equal(release.layers['kernel-types'].role, 'kernel-types');
  assert.equal(release.layers.creative.role, 'module');
  for (const l of L.BUYING_LAYERS) {
    const entry = release.layers[`buying/${l}`];
    if (!entry) continue; // a layer that owns no vendored file (delivery) has no entry
    assert.equal(entry.role, 'module-layer', l);
    // Each buying layer names the layers directly below it, as the layout's layer DAG does.
    assert.deepEqual(entry.depends_on, L.BUYING_DIRECT_DEPS[l].map((d) => `buying/${d}`), l);
  }
  assert.equal(release.layers['buying/offer'].version, '0.1'); // opt-in, starts at 0.x
  assert.equal(release.layers._compat.role, 'assembly');
});

const FINAL_PLACEMENT = path.join(ROOT, 'analysis/final/raw/placement-final-v2.json');
test("layers follow the final layout: every vendored file has the layout's owner; hook majors stay 1", { skip: !existsSync(FINAL_PLACEMENT) && 'analysis/final/raw/placement-final-v2.json is missing' }, () => {
  const layout = JSON.parse(readFileSync(FINAL_PLACEMENT, 'utf8'));
  const upstream = JSON.parse(read('core/placement.json')).layers;
  assert.deepEqual(Object.keys(upstream).sort(), Object.keys(JSON.parse(read('core/UPSTREAM.json')).files).sort());
  for (const [file, layer] of Object.entries(upstream)) {
    assert.notEqual(layout[file]?.label, 'retire', file);
    // The 3.x compatibility assembly is the one declared exception: legacy formats 4.0 already slates for removal.
    assert.equal(layer, file in COMPAT_ASSEMBLY ? COMPAT : layerOfLabel(layout[file].label), file);
  }
  const compat = JSON.parse(read('core/placement.json')).compat_assembly;
  assert.deepEqual(Object.keys(compat).sort(), Object.keys(COMPAT_ASSEMBLY).sort());
  for (const [file, e] of Object.entries(compat)) assert.equal(e.layout_label, layout[file].label, file);
  const counts = {};
  for (const layer of Object.values(upstream)) counts[layer] = (counts[layer] ?? 0) + 1;
  assert.deepEqual(counts, {
    _assembly: 3,
    _compat: 2,
    accounts: 11,
    'buying/catalogs': 2,
    'buying/commitment': 38,
    'buying/execution': 10,
    'buying/offer': 7,
    'buying/pricing': 20,
    'buying/supply': 97,
    'buying/targeting': 63,
    core: 13,
    creative: 61,
    governance: 1,
    identity: 3,
    'kernel-types': 87,
    reporting: 16,
    signals: 4,
    'sponsored-intelligence': 1,
    'x-audience-evidence-on-products': 3,
    'x-format-declarations-on-products': 1,
    'x-reliable-reporting-account-attachments': 2,
    'x-spot-lifecycle': 1,
  });
  // Every layer is the kernel layer, a standard module, a buying layer, the assembly, or an extension's files.
  // trusted-match, the compliance-testing leaf, and buying/delivery own no vendored file.
  const release = JSON.parse(read('core/release.json'));
  for (const layer of Object.keys(release.layers)) {
    const known = [L.KERNEL, L.KERNEL_TYPES, L.ASSEMBLY, L.COMPAT, L.LEAF, ...L.STANDARD_MODULES.filter((m) => m !== 'buying'), ...L.BUYING_LAYERS.map((l) => `buying/${l}`)];
    assert.ok(known.includes(layer) || layer.startsWith('x-'), layer);
  }
  assert.deepEqual(Object.values(release.layers).flatMap((l) => Object.values(l.hooks ?? {})), [1, 1, 1, 1, 1, 1]);
});

// The layout's rules, checked on the vendored subset only (446 upstream files and the 8 the patches create),
// not on the whole tree. Blocking: the target is zero violations, with no baseline.
const result = lint();
const upstreamCore = loadCoreSchemas(path.join(ROOT, 'core/upstream'));
const CROSSING = path.join(ROOT, 'analysis/final/raw/crossing-edges-v2.csv');
const allPatches = readPatches().flatMap((l) => l.patches.map((p) => ({ ...p, layer: l.layer })));

test('layout checks are blocking at zero: no violation in the vendored subset after the 3.4 fixes', () => {
  assert.deepEqual(result.violations, []);
  assert.equal(result.bridged, 23);
  // npm run build:core runs the check after the core build, and it exits 1 on any violation.
  assert.match(JSON.parse(read('package.json')).scripts['build:core'], /build-core\.mjs && node scripts\/layout-lint\.mjs/);
});

test('blocking: a scratch patch that adds one module-to-module $ref fails the check', () => {
  const layers = readPatches();
  layers.find((l) => l.layer === 'buying/pricing').patches.push({ op: 'add', file: 'pricing-options/cpp-option.json', pointer: '/properties/x_scratch', value: { $ref: '/schemas/core/assets/image-asset.json' } });
  const changed = applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), layers);
  const schemas = core.map((s) => ({ ...s, schema: changed.get(s.id.replace(/^\/schemas\//, '')) ?? s.schema }));
  const r = lint(schemas, placement(layers));
  assert.deepEqual(r.violations.map((v) => [v.check, v.from, v.to, v.src, v.path]), [['star', 'buying/pricing', 'creative', 'pricing-options/cpp-option.json', 'x_scratch']]);
  // A bridge point doesn't excuse a $ref to a module its bridge doesn't connect: C4 connects buying and creative, not signals.
  layers.find((l) => l.layer === 'buying/pricing').patches.push({ op: 'add', file: 'pricing-options/cpm-option.json', pointer: '/properties/x_scratch', value: { 'x-adcp-bridge-point': { bridge: 'C4', extension: 'format-declarations-on-products' }, $ref: '/schemas/core/signal-listing.json' } });
  const changed2 = applyPatches((f) => JSON.parse(read(`core/upstream/${f}`)), layers);
  const r2 = lint(core.map((s) => ({ ...s, schema: changed2.get(s.id.replace(/^\/schemas\//, '')) ?? s.schema })), placement(layers));
  assert.deepEqual(r2.violations.map((v) => [v.check, v.from, v.to, v.src]), [
    ['extension', 'x-format-declarations-on-products', 'signals', 'pricing-options/cpm-option.json'],
    ['star', 'buying/pricing', 'creative', 'pricing-options/cpp-option.json'],
  ]);
});

/** The layout's fix id for a crossing-edges row: the bridge id, the older extension, or the kernel type. */
function layoutFixId(row) {
  if (row.fix_class === 'c') return row.fix.split(' ')[0];
  if (row.fix_class === 'x') return row.fix.replace(/^extension point filled by /, '');
  return row.fix.split(':')[0];
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

test("every $ref upstream breaks gets the layout's 3.4 fix in core/patches.json, or sits in the 3.x compatibility assembly", () => {
  const pj = JSON.parse(read('core/placement.json'));
  const layoutOnly = { ...placement(), ...Object.fromEntries(Object.entries(pj.compat_assembly).map(([f, e]) => [f, layerOfLabel(e.layout_label)])) };
  const before = L.layoutViolations(upstreamCore, layoutOnly);
  assert.equal(before.length, 45);
  const applied = {};
  for (const v of before) {
    let fix;
    if (v.src in COMPAT_ASSEMBLY) fix = 'compat';
    else {
      const p = allPatches.find(
        (p) =>
          p.file === v.src &&
          ((p.op === 'compose' && p.pointer === v.pointer) ||
            (p.op === 'add' && p.pointer.endsWith('/x-adcp-bridge-point') && `${v.pointer}/`.startsWith(`${p.pointer.replace(/\/x-adcp-bridge-point$/, '')}/`)))
      );
      assert.ok(p, `no 3.4 fix for ${L.violationKey(v)}`);
      assert.equal(p.layer, layoutOnly[v.src], `${v.src}: the fix belongs to the file's own layer`);
      fix = p.fix;
    }
    v.fix = fix;
    applied[fix] = (applied[fix] ?? 0) + 1;
  }
  assert.deepEqual(applied, { C2a: 1, C3: 3, C4: 4, C6: 13, C8: 1, 'spot-lifecycle': 1, compat: 7, format_kind_id: 3, indicator: 3, indicator_type_id: 2, media_asset: 7 });
  // The fix ids are the layout's: crossing-edges-v2.csv names the same fix for every $ref outside the compatibility
  // assembly, and only removals 4.0 already slates (or $refs inside the legacy product) go to the compatibility assembly.
  if (existsSync(CROSSING)) {
    const rows = new Map(parseCsv(readFileSync(CROSSING, 'utf8')).map((r) => [`${r.src} -> ${r.dst} @ ${r.path}`, r]));
    for (const v of before) {
      const row = rows.get(L.violationKey(v));
      assert.ok(row, L.violationKey(v));
      if (v.fix === 'compat') assert.ok(row.fix_class === 'slated' || v.src === 'core/product.json', L.violationKey(v));
      else assert.equal(v.fix, layoutFixId(row), L.violationKey(v));
      if (row.fix_class === 'slated') assert.equal(v.fix, 'compat', L.violationKey(v));
      else assert.match(row.release_34, /same bytes/, L.violationKey(v));
    }
  }
});

test('every bridge point names a bridge (or older extension) that connects the host module', () => {
  const points = refOccurrences(core).filter((r) => r.point);
  assert.ok(points.length > 0);
  for (const r of points) {
    const host = L.moduleOf(placement()[r.src]);
    if (r.point.bridge) {
      const [name, declaring] = L.BRIDGES[r.point.bridge];
      assert.equal(r.point.extension, name, r.src);
      assert.equal(declaring, host, `${r.src}: ${r.point.bridge} is declared by ${declaring}`);
    } else assert.deepEqual(L.OTHER_EXTENSIONS[r.point.extension], [host], r.src);
  }
  assert.deepEqual([...new Set(points.map((r) => r.point.bridge ?? r.point.extension))].sort(), ['C2a', 'C3', 'C4', 'C6', 'C8', 'spot-lifecycle']);
});

test('registry composition keeps validation: a composed field accepts exactly what the module-owned $ref accepted', () => {
  const ajvOf = (schemas) => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const { id, schema } of schemas) ajv.addSchema({ ...schema, $id: coreUri(id) });
    return ajv;
  };
  const before = ajvOf(upstreamCore);
  const after = ajvOf(core);
  const registries = JSON.parse(read('core/patches.json')).registries;
  const composes = allPatches.filter((p) => p.op === 'compose');
  assert.equal(composes.length, 15);
  for (const p of composes) {
    const at = `${coreUri(`/schemas/${p.file}`)}#${p.pointer}`;
    const node = p.pointer.split('/').slice(1).reduce((n, t) => n[t], JSON.parse(read(`core/schemas/${p.file}`)));
    const registry = JSON.parse(read(`core/schemas${p.ref.slice('/schemas'.length)}`));
    if (registries[p.ref]) {
      assert.equal(node['x-adcp-registry'], p.ref, at);
      assert.deepEqual(node.allOf[0], { $ref: registries[p.ref] }, at);
    } else assert.equal(node['x-adcp-composed-from'], p.ref, at);
    if (registry.enum) {
      // Every known value, and a value the registry doesn't know, validate the same way before and after.
      for (const value of [...registry.enum, 'not_a_known_value', 7]) assert.equal(after.validate(at, value), before.validate(at, value), `${at} ${value}`);
      assert.equal(after.validate(at, 'not_a_known_value'), false, at);
    }
  }
  // An asset format with no module-owned $ref inside is inlined verbatim next to the kernel media_asset core.
  const logo = JSON.parse(read('core/schemas/core/brand-ref.json')).properties.brand_kit_override.properties.logo;
  const { $schema, $id, ...imageAsset } = JSON.parse(read('core/schemas/core/assets/image-asset.json'));
  assert.deepEqual(logo.allOf, [{ $ref: '/schemas/core/media-asset.json' }, imageAsset]);
  // Real payloads: the creator network's get_media_buys readback and a brand kit logo still validate.
  const sample = { url: 'https://cdn.example.com/logo.png', width: 400, height: 400 };
  const logoAt = `${coreUri('/schemas/core/brand-ref.json')}#/properties/brand_kit_override/properties/logo`;
  assert.equal(after.validate(logoAt, sample), before.validate(logoAt, sample));
});

test('star and layer rules: lower layers only, siblings excluded, the kernel layer and assemblies always allowed', () => {
  assert.equal(L.classifyRef('buying/delivery', 'buying/targeting'), null);
  assert.equal(L.classifyRef('buying/supply', 'buying/catalogs'), null);
  assert.equal(L.classifyRef('buying/pricing', 'buying/supply'), 'layer');
  assert.equal(L.classifyRef('buying/delivery', 'buying/offer'), 'layer');
  assert.equal(L.classifyRef('buying/offer', 'buying/execution'), 'sibling');
  assert.equal(L.classifyRef('buying/catalogs', 'buying/pricing'), 'sibling');
  assert.equal(L.classifyRef('buying/targeting', 'kernel-types'), null);
  assert.equal(L.classifyRef('creative', 'buying/supply'), 'star');
  assert.equal(L.classifyRef('kernel-types', 'buying/pricing'), 'kernel');
  assert.equal(L.classifyRef('_compat', 'signals'), null);
  assert.equal(L.classifyRef('buying/supply', 'x-audience-evidence-on-products'), 'extension-point');
  assert.equal(L.classifyRef('x-audience-evidence-on-products', 'signals'), null);
  assert.equal(L.classifyRef('x-audience-evidence-on-products', 'creative'), 'extension');
  assert.deepEqual(L.buyingDeps('delivery'), ['targeting', 'pricing', 'catalogs', 'commitment', 'supply', 'execution']);
  // execution's get_media_buys embeds the accepted proposal record, which the layout places in supply, below
  // both offer and execution; so the siblings meet only through supply.
  const accepted = refOccurrences(core).filter((r) => r.src === 'media-buy/get-media-buys-response.json' && r.dst === 'core/canonical-proposal.json');
  assert.deepEqual(accepted.map((r) => [placement()[r.src], placement()[r.dst], r.path]), [['buying/execution', 'buying/supply', 'media_buys[].accepted_proposal']]);
});

test('why core must change: upstream rejects extensions in commercial_terms and uri@digest in extensions_supported', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const { id, schema } of loadCoreSchemas(path.join(ROOT, 'core/upstream'))) ajv.addSchema({ ...schema, $id: coreUri(id) });
  assert.equal(ajv.validate(coreUri('/schemas/media-buy/commercial-terms.json'), F.commercialTerms()), false);
  assert.equal(ajv.errors[0].params.additionalProperty, 'extensions');
  const caps = { ...F.sellerCapabilities(), extensions_supported: [`${F.RATE_CARD.uri}@${F.RATE_CARD.digest}`] };
  assert.equal(ajv.validate(coreUri('/schemas/protocol/get-adcp-capabilities-response.json'), caps), false);
});

test('digests are reproducible from source and independent of key order', () => {
  for (const dir of extensionPackages()) {
    const { digest, bytes } = buildBundle(dir);
    const lock = JSON.parse(readFileSync(path.join(dir, 'extension.lock.json'), 'utf8'));
    assert.equal(digest, lock.digest, dir);
    assert.deepEqual(readFileSync(path.join(dir, 'dist/bundle.json')), bytes);
  }
  const a = { b: 1, a: [true, null, 'x', 1.5], c: { z: 0, y: 'é' } };
  const b = { c: { y: 'é', z: 0 }, a: [true, null, 'x', 1.5], b: 1 };
  assert.equal(digestOfValue(a), digestOfValue(b));
  assert.equal(jcs(a), '{"a":[true,null,"x",1.5],"b":1,"c":{"y":"é","z":0}}');
});

test('extension packages depend on core, never the reverse', () => {
  for (const dir of extensionPackages()) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.peerDependencies['@adcp/core'], pkg.name);
    assert.match(readFileSync(path.join(dir, 'src/index.ts'), 'utf8'), /from '@adcp\/core'/);
  }
});
