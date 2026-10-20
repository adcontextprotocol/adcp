// Buyer-side runtime behaviour: validation, must-understand, digests, negotiation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBuyerValidator,
  loadModule,
  negotiate,
  registryFetcher,
} from '../lib/buyer-validator.mjs';
import { projectPricingOption } from '../lib/seller.mjs';
import { digestOfValue, refKey, sha256Digest } from '../lib/digest.mjs';
import { evaluate } from '../packages/ext-rate-card-index/index.mjs';
import * as F from '../fixtures/payloads.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = (p) => path.join(ROOT, 'packages', p);
const PRICING = '/schemas/pricing-options/cpp-option.json';
const TERMS = '/schemas/media-buy/commercial-terms.json';

// The buyer installed two modules. It has never heard of AcmeTV's extensions.
const modules = [await loadModule(PKG('ext-rate-card-index')), await loadModule(PKG('ext-seller-adjustable-terms'))];
const buyer = createBuyerValidator({ modules });
const codes = (r) => r.errors.map((e) => e.code);
const byUri = (r, uri) => r.extensions.find((e) => e.uri === uri);

test('valid pricing option with a known extension passes; the card reproduces the seller quote', () => {
  const r = buyer.validate(PRICING, F.pricingOption());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const card = byUri(r, F.RATE_CARD.uri);
  assert.equal(card.status, 'understood');
  assert.equal(card.must_understand, false);
  assert.equal(card.evaluation.price, 1898);
  assert.deepEqual(card.evaluation.price_breakdown.adjustments.map((a) => a.amount), [1300, 230, 632]);
  assert.match(card.warnings.join(), /RATE_CARD_PROVISIONAL/);
});

test('unknown optional (vendor) extension is ignored, and the option stays usable', () => {
  const r = buyer.validate(PRICING, F.pricingOption());
  assert.equal(byUri(r, F.DAYPART.uri).status, 'ignored');
});

test('unknown optional extension can still be schema-checked from the registry, but is not interpreted', () => {
  const withFetch = createBuyerValidator({ modules, fetcher: registryFetcher(path.join(ROOT, 'registry')) });
  const r = withFetch.validate(PRICING, F.pricingOption());
  assert.equal(r.ok, true);
  assert.equal(byUri(r, F.DAYPART.uri).note, 'schema-valid, not interpreted (no module)');
});

test('valid commercial terms with two binding extensions pass', () => {
  const r = buyer.validate(TERMS, F.commercialTerms());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.extensions.map((e) => [e.status, e.must_understand]), [['understood', true], ['understood', true]]);
});

test('unknown must-understand extension is rejected (pricing option, flag set)', () => {
  const po = F.pricingOption();
  po.extensions.push({ ...F.UNKNOWN_MU, must_understand: true, data: { credits: 3 } });
  const r = buyer.validate(PRICING, po);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['EXTENSION_NOT_UNDERSTOOD']);
});

test('any unknown extension inside commercial_terms is rejected, even when flagged optional', () => {
  const ct = F.commercialTerms();
  ct.extensions.unshift({ ...F.UNKNOWN_MU, must_understand: false, data: { credits: 3 } }); // the extension point keeps uri order
  assert.deepEqual(codes(buyer.validate(TERMS, ct)), ['EXTENSION_NOT_UNDERSTOOD']);
});

test('known uri with a digest the buyer does not hold: rejected when binding, ignored when optional', () => {
  const revised = 'sha256:' + 'cd'.repeat(32);
  const ct = F.commercialTerms();
  ct.extensions[0].digest = revised;
  assert.deepEqual(codes(buyer.validate(TERMS, ct)), ['EXTENSION_VERSION_NOT_UNDERSTOOD']);

  const po = F.pricingOption();
  po.extensions[0].digest = revised;
  const r = buyer.validate(PRICING, po);
  assert.equal(r.ok, true);
  assert.equal(byUri(r, F.RATE_CARD.uri).status, 'ignored');
});

test('digest mismatch: a bundled definition that does not hash to its key fails closed', () => {
  const tampered = F.bundleOf('ext-rate-card-index');
  tampered.definitions.RateCard.properties.base_price.exclusiveMinimum = -1e9;
  const bundled = { [refKey(F.RATE_CARD.uri, F.RATE_CARD.digest)]: tampered };
  const r = buyer.validate(TERMS, F.commercialTerms(), { bundledExtensions: bundled });
  assert.deepEqual(codes(r), ['EXTENSION_DIGEST_MISMATCH']);
});

test('digest mismatch: an installed module whose bundle bytes changed refuses to load', async () => {
  const dir = mkdtempSync(path.join(ROOT, '.tmp-tamper-'));
  try {
    cpSync(PKG('ext-rate-card-index'), dir, { recursive: true });
    writeFileSync(path.join(dir, 'dist/bundle.json'), '{"tampered":true}');
    await assert.rejects(loadModule(dir), { code: 'EXTENSION_DIGEST_MISMATCH' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('digest mismatch on fetch of an optional unknown extension: ignored with a warning, never validated', () => {
  const evil = createBuyerValidator({ modules, fetcher: () => Buffer.from('{"definitions":{}}') });
  const r = evil.validate(PRICING, F.pricingOption());
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code), ['EXTENSION_DIGEST_MISMATCH']);
});

test('divergent digests for one uri in one message fail closed', () => {
  const po = F.pricingOption();
  po.extensions.push({ ...po.extensions[0], digest: 'sha256:' + 'ef'.repeat(32) });
  const r = buyer.validate(PRICING, po);
  assert.deepEqual([...new Set(codes(r))], ['EXTENSION_DIGEST_DIVERGENT']);
});

test('binding terms that fail the extension schema are rejected (unknown constraint kind)', () => {
  const ct = F.commercialTerms();
  ct.extensions[1].data.allowances[0].constraint = { kind: 'value_floor', min: 1000 };
  assert.deepEqual(codes(buyer.validate(TERMS, ct)), ['EXTENSION_DATA_INVALID']);
});

test('binding terms that fail the module semantics are rejected (path does not resolve in the purchase)', () => {
  const ct = F.commercialTerms();
  ct.extensions[1].data.allowances[0].path = '/impressions';
  const r = buyer.validate(TERMS, ct);
  assert.deepEqual(codes(r), ['EXTENSION_SEMANTIC_ERROR']);
  assert.match(r.errors[0].message, /does not resolve in purchase 0/);
});

test('signed card that disagrees with the signed price is rejected', () => {
  const ct = F.commercialTerms();
  ct.purchases[0].pricing.fixed_price = 1900;
  ct.purchases[0].pricing.price_breakdown.adjustments[0].amount = 1302;
  assert.deepEqual(codes(buyer.validate(TERMS, ct)), ['EXTENSION_SEMANTIC_ERROR']);
});

test('a seller quote that differs from the card is only a warning at discovery (quote binds)', () => {
  const po = F.pricingOption();
  po.fixed_price = 1850;
  const r = buyer.validate(PRICING, po);
  assert.equal(r.ok, true);
  assert.match(byUri(r, F.RATE_CARD.uri).warnings.join(), /RATE_CARD_QUOTE_DIFFERS/);
});

test('core-invalid payloads stop before extensions are looked at', () => {
  const po = F.pricingOption();
  delete po.currency;
  const r = buyer.validate(PRICING, po);
  assert.deepEqual([...new Set(codes(r))], ['CORE_SCHEMA_INVALID']);
  assert.equal(r.extensions.length, 0);
});

test('capability negotiation intersects on exact uri@digest; seller projects options for the buyer', () => {
  const caps = F.sellerCapabilities();
  assert.equal(buyer.validate('/schemas/protocol/get-adcp-capabilities-response.json', caps).ok, true);
  const n = negotiate(caps.declared_extensions, modules);
  assert.deepEqual(n.usable, [refKey(F.RATE_CARD.uri, F.RATE_CARD.digest), refKey(F.SELLER_ADJ.uri, F.SELLER_ADJ.digest)]);
  assert.deepEqual(n.sellerOnly, [refKey(F.DAYPART.uri, F.DAYPART.digest)]);

  const understood = new Set(n.usable);
  const projected = projectPricingOption(F.pricingOption(), understood);
  assert.deepEqual(projected.extensions.map((t) => t.uri), [F.RATE_CARD.uri]);

  const mu = F.pricingOption();
  mu.extensions.push({ ...F.UNKNOWN_MU, must_understand: true, data: {} });
  assert.equal(projectPricingOption(mu, understood), null);
});

test('rate card: premium basis is explicit data (the 1254 vs 1245 question from #7955)', () => {
  const sel = { values: { buying_option: 'variabel', month: '2027-04', spot_length: '60s', position: 'first_in_break' } };
  // 1000 x1.85 = 1850; x1.15 = 2127.5 -> 2128; x1.8 = 3830.4 -> 3830; +30% premium
  assert.equal(evaluate(F.rateCard(), sel).price, 3830 + 1149); // premium on the indexed price
  assert.equal(evaluate({ ...F.rateCard(), premium_basis: 'base' }, sel).price, 3830 + 300); // on the base
});

test('rate card output is a valid core price_breakdown; an index of x2 or more must be an amount, not a rate', () => {
  const res = evaluate(F.rateCard(), F.rateCard().quoted_selection);
  assert.equal(buyer.validate('/schemas/pricing-options/price-breakdown.json', res.price_breakdown).ok, true);
  // Core price_breakdown caps rate below 1, so an index of x2 or more must be an amount
  // (#7955 pricing-models.mdx:801 falls back the same way). Vast + preferred position is x2.3:
  const asRate = { list_price: 1000, adjustments: [{ kind: 'fee', name: 'index:buying_option', rate: 1.3 }] };
  assert.deepEqual([...new Set(codes(buyer.validate('/schemas/pricing-options/price-breakdown.json', asRate)))], ['CORE_SCHEMA_INVALID']);
});

test('raw-body digest and JCS digest agree only because the bundle is served as JCS bytes', () => {
  const pretty = JSON.stringify(F.bundleOf('ext-rate-card-index'), null, 2);
  // A host that pretty-prints the same definition breaks today's raw-body rule...
  assert.notEqual(sha256Digest(Buffer.from(pretty)), F.RATE_CARD.digest);
  // ...while the JCS digest of the value is stable, so an embedded copy is verifiable.
  assert.equal(digestOfValue(JSON.parse(pretty)), F.RATE_CARD.digest);
  assert.equal(modules[0].digest, F.RATE_CARD.digest);
});
