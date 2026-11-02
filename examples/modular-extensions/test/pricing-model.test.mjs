// A pricing model core does not have, as an open-union branch (the hook design): the
// linear-tv-indexed-cpp extension registers `indexed_cpp` in the buying
// module's pricing_model union. Plus the contrast case: an explanatory rate
// card that only explains a binding core quote, and stays ignorable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createBuyerValidator, loadModule } from '../lib/buyer-validator.mjs';
import { createAdcpClient } from '../lib/client.mjs';
import { coreUri, loadCoreSchemas } from '../lib/core-schemas.mjs';
import { termsDigest } from '../lib/digest.mjs';
import { projectPricingOption } from '../lib/seller.mjs';
import { INDEXED, INDEXED_BRANCH, RATE_CARD, createTvSeller, indexedTerms } from '../lib/mock-tv-seller.mjs';
import { buildBundle } from '../scripts/build-extensions.mjs';
import { settle } from '../packages/ext-linear-tv-indexed-cpp/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = (p) => path.join(ROOT, 'packages', p);
const PRODUCT = '/schemas/core/product.json';
const PRICING = '/schemas/core/canonical-pricing-option.json';
const PROPOSAL = '/schemas/core/canonical-proposal.json';
const codes = (r) => [...new Set(r.errors.map((e) => e.code))];
const ns = (dir) => {
  const lock = JSON.parse(readFileSync(path.join(PKG(dir), 'extension.lock.json'), 'utf8'));
  return { EXTENSION_URI: lock.uri, EXTENSION_DIGEST: lock.digest, EXTENSION_MODULE_DIR: new URL(`../packages/${dir}/`, import.meta.url) };
};
const indexedModule = await loadModule(PKG('ext-linear-tv-indexed-cpp'));
const rateCardModule = await loadModule(PKG('ext-rate-card-index'));
const tvBuyer = createBuyerValidator({ modules: [indexedModule] });
const plainBuyer = createBuyerValidator();
const branchPricing = () => ({
  pricing_option_id: 'po_prime_indexed_early',
  pricing_model: INDEXED_BRANCH,
  currency: 'EUR',
  extension_model: { uri: INDEXED.uri, digest: INDEXED.digest, data: indexedTerms() },
});
// Discovery (get_products) carries pricing options; proposals come from request_proposals.
const brief = { buying_mode: 'brief', brief: 'Prime time 25-54 in March' };
let requests = 0;
const proposalRequest = () => ({ idempotency_key: `request-tv-${String(++requests).padStart(4, '0')}-aaaaaaa`, brief: 'Prime time 25-54 in March', brand: { domain: 'brand.example.com' } });

test('pricing_model is an open union: core takes an extension branch only with its body and no core price; upstream rejects it', () => {
  assert.equal(tvBuyer.validate(PRICING, branchPricing()).ok, true);
  const noBody = branchPricing();
  delete noBody.extension_model;
  assert.deepEqual(codes(tvBuyer.validate(PRICING, noBody)), ['CORE_SCHEMA_INVALID']);
  assert.deepEqual(codes(tvBuyer.validate(PRICING, { ...branchPricing(), fixed_price: 1898 })), ['CORE_SCHEMA_INVALID']);
  assert.deepEqual(codes(tvBuyer.validate(PRICING, { pricing_option_id: 'p', pricing_model: 'cpm', currency: 'EUR', extension_model: branchPricing().extension_model })), ['CORE_SCHEMA_INVALID']);
  // The body must belong to the extension the discriminator names.
  const other = branchPricing();
  other.extension_model.uri = RATE_CARD.uri;
  assert.deepEqual(codes(tvBuyer.validate(PRICING, other)), ['EXTENSION_BRANCH_MISMATCH']);
  // Upstream: pricing_model is a closed enum and extension_model does not exist.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const { id, schema } of loadCoreSchemas(path.join(ROOT, 'core/upstream'))) ajv.addSchema({ ...schema, $id: coreUri(id) });
  assert.equal(ajv.validate(coreUri(PRICING), branchPricing()), false);
  assert.ok(ajv.errors.some((e) => e.instancePath === '/pricing_model' && e.keyword === 'enum'));
});

test('the seller offers indexed_cpp only on its linear-TV product; a buyer with the module validates it and reproduces the ceiling', async () => {
  const seller = createTvSeller();
  const client = await createAdcpClient({ transport: seller.transport, extensions: [ns('ext-linear-tv-indexed-cpp')] });
  const { products } = await client.getProducts(brief);
  assert.deepEqual(products.map((p) => [p.product_id, p.channels, p.pricing_options.map((o) => o.pricing_model)]), [
    ['nl_tv_prime_2554', ['linear_tv'], ['cpp', INDEXED_BRANCH]],
    ['nl_online_video', ['olv'], ['cpm']],
  ]);
  const r = tvBuyer.validate(PRODUCT, products[0]);
  const branch = r.extensions.find((e) => e.point === 'pricing_model');
  assert.deepEqual([branch.path, branch.branch, branch.must_understand, branch.status], ['/pricing_options/1/extension_model', 'indexed_cpp', true, 'understood']);
  assert.deepEqual(branch.evaluation, { ceiling_price: 1898, floor_price: 1518 });
  assert.match(branch.warnings.join(), /at most 1898 per point until the market index is fixed/);
});

test('scope: the same branch on a product outside the model channels is rejected', () => {
  const [prime, olv] = createTvSeller().catalog();
  olv.pricing_options.push(prime.pricing_options[1]);
  const r = tvBuyer.validate(PRODUCT, olv);
  assert.deepEqual(codes(r), ['EXTENSION_SEMANTIC_ERROR']);
  assert.match(r.errors[0].message, /INDEXED_CPP_OUT_OF_SCOPE: product nl_online_video is sold as \[olv\]; indexed_cpp applies to \[linear_tv,radio\]/);
});

test('a buyer without the module never receives the branch: the seller projects it out and quotes core cpp at the published index', async () => {
  const seller = createTvSeller();
  const client = await createAdcpClient({ transport: seller.transport });
  const discovery = await client.getProducts(brief);
  assert.deepEqual(discovery.products[0].pricing_options.map((o) => o.pricing_option_id), ['po_prime_cpp_late']);
  assert.equal(discovery.proposals, undefined, 'get_products is discovery only; proposals come from request_proposals');
  const { outcome, products, proposals } = await client.requestProposals(proposalRequest());
  assert.equal(outcome, 'proposed');
  assert.deepEqual(products[0].pricing_options.map((o) => o.pricing_option_id), ['po_prime_cpp_late']);
  assert.match(proposals[0].terms_digest, /^sha256:/);
  const { pricing, budget } = proposals[0].commercial_terms.purchases[0];
  assert.deepEqual([pricing.pricing_model, pricing.fixed_price, budget], ['cpp', 2050, 205000]);
  // Projection is the seller-side mirror of fail-closed: a branch the buyer did not list is dropped.
  assert.equal(projectPricingOption(branchPricing(), new Set()), null);
});

test('unknown branch in a list of options: the buyer drops only that option with a warning; the product stays buyable', async () => {
  // A seller that ignores understood_extensions in its catalog and sends the branch anyway:
  const seller = createTvSeller({ ignoreUnderstood: 'products' });
  const client = await createAdcpClient({ transport: seller.transport });
  const { products } = await client.getProducts(brief);
  assert.deepEqual(products.map((p) => [p.product_id, p.pricing_options.map((o) => o.pricing_option_id)]), [
    ['nl_tv_prime_2554', ['po_prime_cpp_late']],
    ['nl_online_video', ['po_olv_cpm']],
  ]);
  const prime = client.lastReports[0];
  assert.deepEqual([prime.ok, prime.dropped, prime.warnings.map((w) => w.code)], [true, ['/pricing_options/1'], ['EXTENSION_OPTION_DROPPED']]);
  assert.deepEqual(prime.extensions.find((e) => e.point === 'pricing_model').status, 'dropped');
  // The policy comes from the union's owner (buying's pricing layer, in the final layout), not from the validator.
  const union = loadCoreSchemas().find((s) => s.id === '/schemas/pricing-options/extension-option.json').schema['x-adcp-open-union'];
  assert.equal(union.unknown_in_list, 'drop_option');
  // A list whose every option is unknown leaves nothing to buy: the product is rejected.
  const [catalogPrime] = seller.catalog();
  const onlyBranch = { ...catalogPrime, pricing_options: [catalogPrime.pricing_options[1]] };
  assert.deepEqual(codes(plainBuyer.validate(PRODUCT, onlyBranch)), ['EXTENSION_NOT_UNDERSTOOD']);
});

test('fail closed: signed terms that carry an unknown branch are rejected; the drop policy never applies there', async () => {
  const seller = createTvSeller({ ignoreUnderstood: true });
  const client = await createAdcpClient({ transport: seller.transport });
  // The pricing of a purchase is not an array item, so the branch is rejected, not dropped.
  assert.deepEqual(codes(plainBuyer.validate(PRICING, branchPricing())), ['EXTENSION_NOT_UNDERSTOOD']);
  // In one request_proposals response, the same unknown branch is dropped from a product's list of
  // options but rejected as the pricing of a signed purchase, so the response fails closed.
  await assert.rejects(client.requestProposals(proposalRequest()), (e) => e.code === 'EXTENSION_NOT_UNDERSTOOD');
  assert.deepEqual(client.lastReport.dropped, ['/products/0/pricing_options/1']);
  assert.deepEqual(client.lastReport.errors.map((e) => e.path), ['/proposals/0/commercial_terms/purchases/0/pricing/extension_model']);
  const { proposals: [draft] } = await seller.transport.call('request_proposals', proposalRequest());
  assert.equal(draft.commercial_terms.purchases[0].pricing.pricing_model, INDEXED_BRANCH);
  assert.throws(() => client.check(PROPOSAL, draft, 'proposal'), (e) => e.code === 'EXTENSION_NOT_UNDERSTOOD');
  assert.match(client.lastReport.errors[0].message, /must-understand at pricing_model#indexed_cpp/);
  assert.deepEqual(client.lastReport.dropped, []);
  const { proposals: [committed] } = await seller.transport.call('refine_proposals', {
    idempotency_key: 'finalize-tv-0001-aaaaa',
    refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
  });
  await assert.rejects(client.acceptProposal({ proposal: committed, idempotency_key: 'accept-tv-0001-aaaaaaa', account: { account_id: 'acc' } }), (e) => e.code === 'EXTENSION_NOT_UNDERSTOOD');
});

test('signed terms carry the branch under terms_digest; the index is fixed after booking and delivered points settle at the fixed rate', async () => {
  const seller = createTvSeller();
  const violations = [];
  const client = await createAdcpClient({ transport: seller.transport, extensions: [ns('ext-linear-tv-indexed-cpp')], onViolation: (v) => violations.push(v.message) });
  const { proposals: [draft] } = await client.requestProposals(proposalRequest());
  const { proposals: [committed] } = await client.refineProposals({ idempotency_key: 'finalize-tv-0002-aaaaa', refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
  const purchase = committed.commercial_terms.purchases[0];
  assert.equal(purchase.pricing.pricing_model, INDEXED_BRANCH);
  assert.equal(purchase.budget, 189800); // 100 points at the 1898 ceiling
  assert.equal(client.lastReport.extensions.find((e) => e.point === 'pricing_model').path, '/commercial_terms/purchases/0/pricing/extension_model');
  // The branch is inside terms_digest: a different cap is a different contract.
  const capped = structuredClone(committed.commercial_terms);
  capped.purchases[0].pricing.extension_model.data.market_index.cap = 1.2;
  assert.notEqual(termsDigest(capped), committed.terms_digest);
  const { media_buy_id } = await client.acceptProposal({ proposal: committed, idempotency_key: 'accept-tv-0002-aaaaaaa', account: { account_id: 'acc' } });

  // 16 January: the seller fixes the market index at 96.
  seller.ops.fixMarketIndex(media_buy_id, 0.96);
  let { media_buys: [mb] } = await client.getMediaBuys({ media_buy_ids: [media_buy_id] });
  const state = client.lastReport.extensions.find((e) => e.point === 'media_buy_state');
  assert.deepEqual([state.status, violations], ['understood', []]);
  const fixing = mb.extensions_state[0].data.fixings[0];
  assert.deepEqual([fixing.market_index, fixing.rate], [0.96, 1822]);

  // After airing: delivered points x fixed rate. The buyer recomputes the seller's invoice with the same module.
  const invoice = seller.ops.invoice(media_buy_id, 104.1);
  assert.deepEqual(invoice, { rate: 1822, points: 104.1, amount: 189670.2 });
  assert.deepEqual(settle(mb.accepted_proposal.commercial_terms.purchases[0].pricing.extension_model.data, fixing, 104.1), invoice);
  assert.ok(invoice.amount <= purchase.budget, 'core budget still caps spend');

  // A rate that does not follow from the index, or an index above the signed cap, is a dispute.
  seller.ops.fixMarketIndex(media_buy_id, 0.96, { rate: 1850 });
  ({ media_buys: [mb] } = await client.getMediaBuys({ media_buy_ids: [media_buy_id] }));
  assert.deepEqual(violations, ['fixing for purchase 0: rate 1850 does not follow from index 0.96 (expected 1822)']);
  const above = structuredClone(mb);
  above.extensions_state[0].data.fixings[0] = { ...fixing, market_index: 1.05, rate: 1993 };
  const r2 = client.check('/schemas/media-buy/get-media-buys-response.json', { status: 'completed', media_buys: [above] }, 'get_media_buys');
  assert.match(r2.violations[0].message, /market index 1.05 is above the signed cap 1$/);
});

test('an explanatory rate card stays ignorable: the binding quote is a core cpp price whether or not the buyer reads the card', async () => {
  const [prime] = createTvSeller().catalog();
  const late = prime.pricing_options[0];
  // Without the rate-card module: valid, the card is ignored, the option is buyable at fixed_price.
  const plain = plainBuyer.validate('/schemas/pricing-options/cpp-option.json', late);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.extensions.map((e) => [e.uri, e.must_understand, e.status]), [[RATE_CARD.uri, false, 'ignored']]);
  // With it: the card explains the same number. It never changes which number binds.
  const reader = createBuyerValidator({ modules: [rateCardModule] }).validate('/schemas/pricing-options/cpp-option.json', late);
  assert.equal(reader.extensions[0].evaluation.price, late.fixed_price);
  assert.deepEqual(reader.extensions[0].evaluation.price_breakdown, late.price_breakdown);
  // Contrast: the indexed branch is not explanatory. The same plain buyer cannot buy it: it drops the
  // option from the product's list, and rejects the branch outright where it is not a list item.
  const plainProduct = plainBuyer.validate(PRODUCT, prime);
  assert.deepEqual([plainProduct.ok, plainProduct.dropped], [true, ['/pricing_options/1']]);
  assert.deepEqual(codes(plainBuyer.validate(PRICING, branchPricing())), ['EXTENSION_NOT_UNDERSTOOD']);
  // And the plain buyer's signed price is the core model, not the card.
  const client = await createAdcpClient({ transport: createTvSeller().transport });
  const { proposals: [p] } = await client.requestProposals(proposalRequest());
  assert.deepEqual(p.commercial_terms.purchases[0].pricing.price_breakdown, late.price_breakdown);
});

test('the capabilities hook: the seller declares where it offers the model; the buyer checks the fragment against the extension', async () => {
  const seller = createTvSeller();
  const client = await createAdcpClient({ transport: seller.transport, extensions: [ns('ext-linear-tv-indexed-cpp')] });
  const caps = await client.capabilities();
  assert.deepEqual(client.lastReport.extensions.map((e) => [e.point, e.status]), [['capabilities', 'understood']]);
  assert.deepEqual(caps.negotiation.usable, [`${INDEXED.uri}@${INDEXED.digest}`]);
  const bad = structuredClone(caps);
  delete bad.negotiation;
  bad.declared_extensions[0].capabilities = { channels: ['olv'], points_sources: ['nmo'] };
  assert.match(tvBuyer.validate('/schemas/protocol/get-adcp-capabilities-response.json', bad).extensions[0].warnings.join(), /INDEXED_CPP_CAPABILITY_SCOPE: declared for \[olv\]/);
});

test('a binding extension point keeps uri order: an out-of-order entry fails closed', async () => {
  const { proposals: [p] } = await createTvSeller().transport.call('request_proposals', proposalRequest());
  const ct = p.commercial_terms;
  ct.extensions = [
    { uri: 'https://b.example.com/x', digest: 'sha256:' + '1'.repeat(64), data: {} },
    { uri: 'https://a.example.com/x', digest: 'sha256:' + '2'.repeat(64), data: {} },
  ];
  assert.deepEqual(codes(tvBuyer.validate('/schemas/media-buy/commercial-terms.json', ct)), ['EXTENSION_ORDER_INVALID', 'EXTENSION_NOT_UNDERSTOOD']);
});

test('the build checks a registration against the hook core declares: branches only on unions, with what the union owner requires', () => {
  const dir = mkdtempSync(path.join(ROOT, '.tmp-branch-'));
  try {
    cpSync(PKG('ext-linear-tv-indexed-cpp'), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'extension.json'), 'utf8'));
    const write = (m) => writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(m));
    const noReports = structuredClone(manifest);
    delete noReports.extends[0].reports_as;
    write(noReports);
    assert.throws(() => buildBundle(dir), /the pricing_model union requires reports_as/);
    const onExtensionPoint = structuredClone(manifest);
    onExtensionPoint.extends[0].point = 'pricing_option';
    onExtensionPoint.requires.points.pricing_option = 1;
    write(onExtensionPoint);
    assert.throws(() => buildBundle(dir), /pricing_option is an extension point; it takes no branch/);
    const unknown = structuredClone(manifest);
    unknown.extends[0].point = 'billing_basis';
    unknown.requires.points.billing_basis = 1;
    write(unknown);
    assert.throws(() => buildBundle(dir), /core declares no such hook/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
