#!/usr/bin/env node
// Walk-through: capability negotiation, a get_products pricing option, accepted
// commercial terms, and the fail-closed cases. Run `npm run build` first.
//
// The rate card stays on get_products on purpose: it explains a discovery-time pricing
// option, and the pricing_option extension point exists only on the core-model option files that
// get_products products carry. Proposals (and their commercial_terms) come from
// request_proposals; see demo-pricing.mjs and examples/buyer-app/app.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuyerValidator, loadModule, negotiate, registryFetcher } from './lib/buyer-validator.mjs';
import { projectPricingOption } from './lib/seller.mjs';
import { refKey } from './lib/digest.mjs';
import * as F from './fixtures/payloads.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const short = (key) => key.replace(/^https:\/\//, '').replace(/@sha256:(.{8}).*/, '@sha256:$1…');
const h = (s) => console.log(`\n== ${s} ${'='.repeat(Math.max(0, 74 - s.length))}`);
function show(report) {
  console.log(`  ok: ${report.ok}`);
  for (const e of report.extensions) {
    const tag = e.must_understand ? 'must-understand' : 'optional';
    console.log(`  ${e.path.padEnd(20)} ${short(refKey(e.uri, e.digest)).padEnd(64)} ${tag.padEnd(15)} -> ${e.status}${e.code ? ` (${e.code})` : ''}${e.note ? ` [${e.note}]` : ''}`);
    for (const w of e.warnings) console.log(`  ${''.padEnd(20)} warning: ${w}`);
  }
  for (const e of report.errors) console.log(`  error ${e.code}: ${e.message}`);
  for (const w of report.warnings) console.log(`  warning ${w.code}: ${w.message}`);
}

// The buyer installed two extension packages; it never installed AcmeTV's.
const modules = [
  await loadModule(path.join(ROOT, 'packages/ext-rate-card-index')),
  await loadModule(path.join(ROOT, 'packages/ext-seller-adjustable-terms')),
];
const buyer = createBuyerValidator({ modules, fetcher: registryFetcher(path.join(ROOT, 'registry')) });

h('1. Installed modules (digest re-verified from bytes on disk)');
for (const m of modules) console.log(`  ${m.manifest.name.padEnd(24)} v${m.version}  ${short(refKey(m.uri, m.digest))}`);

h('2. get_adcp_capabilities -> negotiation (exact uri@digest match)');
const caps = F.sellerCapabilities();
console.log(`  capabilities valid against patched core: ${buyer.validate('/schemas/protocol/get-adcp-capabilities-response.json', caps).ok}`);
const n = negotiate(caps.declared_extensions, modules);
console.log(`  usable:      ${n.usable.map(short).join(', ')}`);
console.log(`  seller only: ${n.sellerOnly.map(short).join(', ')}`);
const understood = new Set(n.usable);
const projected = projectPricingOption(F.pricingOption(), understood);
console.log(`  seller projects the pricing option for this buyer: keeps ${projected.extensions.length} of 2 extension entries`);

h('3. get_products pricing option (cpp, NL TV): core quote + 2 optional entries');
const po = buyer.validate('/schemas/pricing-options/cpp-option.json', F.pricingOption());
show(po);
const ev = po.extensions[0].evaluation;
console.log(`  local evaluation of quoted_selection: price ${ev.price} (seller fixed_price ${F.pricingOption().fixed_price})`);
for (const a of ev.price_breakdown.adjustments) console.log(`    ${a.kind.padEnd(8)} ${a.name.padEnd(20)} ${String(a.amount).padStart(5)}  ${a.description}`);

h('4. Accepted commercial_terms: 2 binding extension entries (all must-understand)');
show(buyer.validate('/schemas/media-buy/commercial-terms.json', F.commercialTerms()));

h('5. Fail-closed cases');
const cases = [
  [
    'unknown must-understand entry on a pricing option',
    '/schemas/pricing-options/cpp-option.json',
    () => {
      const p = F.pricingOption();
      p.extensions.push({ ...F.UNKNOWN_MU, must_understand: true, data: { credits: 3 } });
      return [p];
    },
  ],
  [
    'unknown entry in commercial_terms marked optional (point rule overrides)',
    '/schemas/media-buy/commercial-terms.json',
    () => {
      const c = F.commercialTerms();
      c.extensions.unshift({ ...F.UNKNOWN_MU, must_understand: false, data: {} }); // keeps uri order
      return [c];
    },
  ],
  [
    'seller revised rate-card-index (new digest) inside signed terms',
    '/schemas/media-buy/commercial-terms.json',
    () => {
      const c = F.commercialTerms();
      c.extensions[0].digest = 'sha256:' + 'cd'.repeat(32);
      return [c];
    },
  ],
  [
    'bundled definition does not hash to its uri@digest key',
    '/schemas/media-buy/commercial-terms.json',
    () => {
      const tampered = F.bundleOf('ext-rate-card-index');
      tampered.definitions.RateCard.properties.base_price.exclusiveMinimum = -1e9;
      return [F.commercialTerms(), { bundledExtensions: { [refKey(F.RATE_CARD.uri, F.RATE_CARD.digest)]: tampered } }];
    },
  ],
  [
    'two digests for one uri in one message',
    '/schemas/pricing-options/cpp-option.json',
    () => {
      const p = F.pricingOption();
      p.extensions.push({ ...p.extensions[0], digest: 'sha256:' + 'ef'.repeat(32) });
      return [p];
    },
  ],
  [
    'allowance with a constraint kind this digest does not define',
    '/schemas/media-buy/commercial-terms.json',
    () => {
      const c = F.commercialTerms();
      c.extensions[1].data.allowances[0].constraint = { kind: 'value_floor', min: 1000 };
      return [c];
    },
  ],
];
for (const [label, schema, make] of cases) {
  const r = buyer.validate(schema, ...make());
  console.log(`  ${label.padEnd(72)} ok=${r.ok}  ${[...new Set(r.errors.map((e) => e.code))].join(', ')}`);
}
console.log();
