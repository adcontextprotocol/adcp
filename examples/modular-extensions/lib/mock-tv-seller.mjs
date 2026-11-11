// An in-process sales agent for the pricing-model scenario: a fictional Dutch linear-TV sales
// house ("TvHuis"). Same transport interface and the same SDK helper (lib/server.mjs) as
// lib/mock-seller.mjs.
//
// Two tasks carry pricing. get_products is discovery: products (core/product.json) whose
// core-model options can carry the explanatory pricing_option extension point (the rate card), next to
// the indexed branch. request_proposals is the proposal flow: canonical proposals with
// commercial_terms and terms_digest, plus compact products (core/canonical-product.json),
// whose canonical pricing options have the pricing_model union but no pricing_option extension point.
//
// What it shows (the hook design):
//  - a pricing model that core does not have, offered as an open-union branch
//    (pricing_model = <extension uri>#indexed_cpp), only on its linear-TV
//    product; its online-video product stays core cpm. The generated writer
//    linearTvIndexedCpp.indexedCppBranch() builds the discriminator and the body;
//  - an explanatory rate card (rate-card-index) on the core cpp option: the
//    quote binds, the card only explains it, and a buyer may ignore it
//    (rateCardIndex.pricingOptionEntry());
//  - per-buyer projection: a buyer that did not list linear-tv-indexed-cpp in
//    understood_extensions never receives the indexed option, and is quoted
//    in core cpp at the published market index instead;
//  - signed terms that carry the branch under terms_digest, and readback of the
//    market index the seller fixes after booking (linearTvIndexedCpp.mediaBuyStateEntry()),
//    announced on the core feed.
// Every request it receives and every response it sends validates against core.
import { refKey, termsDigest } from './digest.mjs';
import { projectProduct } from './seller.mjs';
import { SellerRejection, createAdcpServer } from './server.mjs';
import { ceiling, rateAt, settle } from '../packages/ext-linear-tv-indexed-cpp/index.mjs';
import { evaluate } from '../packages/ext-rate-card-index/index.mjs';
import * as linearTvIndexedCpp from '../packages/ext-linear-tv-indexed-cpp/src/index.mjs';
import * as rateCardIndex from '../packages/ext-rate-card-index/src/index.mjs';

const ref = (m) => ({ uri: m.EXTENSION_URI, version: m.EXTENSION_VERSION, digest: m.EXTENSION_DIGEST });
export const INDEXED = ref(linearTvIndexedCpp);
export const RATE_CARD = ref(rateCardIndex);
export const INDEXED_BRANCH = linearTvIndexedCpp.INDEXED_CPP;

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const AUDIENCE = { demographic_system: 'nmo', demographic: '25-54' };
const FLIGHT = { start_time: '2027-03-01T00:00:00+01:00', end_time: '2027-03-31T23:59:59+02:00' };
const POINTS = 100; // GRPs the buyer plans for March

/** Early request: indices fixed at booking, market index fixed after the deadline and capped at 100 (modelled on Ster's published structure). */
export const indexedTerms = () => {
  const data = {
    audience: AUDIENCE,
    base_price: 1000,
    indices: [
      { name: 'Your Time Vast + preferred position', dimension: 'buying_option', value: 'vast_preferred', factor: 2.3 },
      { name: 'March', dimension: 'month', value: '2027-03', factor: 1.1 },
      { name: '20s spot', dimension: 'spot_length', value: '20s', factor: 0.75 },
    ],
    market_index: { fixed_at: '2027-01-16T00:00:00+01:00', floor: 0.8, cap: 1.0 },
    rounding: { decimals: 0, mode: 'half_away_from_zero' },
    settlement: { points_source: 'nmo', invoice: 'delivered_points_x_fixed_rate' },
  };
  return { ...data, ceiling_price: ceiling(data) };
};

/** Late request: the same chain at the published market index (108), as an explanatory rate card. */
export const lateRateCard = () => ({
  base_price: 1000,
  premium_basis: 'indexed',
  rounding: { step: 'each_row', decimals: 0, mode: 'half_away_from_zero' },
  quoted_selection: { values: { buying_option: 'vast', position: 'preferred', month: '2027-03', spot_length: '20s' }, start_time: FLIGHT.start_time },
  rows: [
    { kind: 'index', name: 'Your Time Vast', dimension: 'buying_option', value: 'vast', factor: 2.0 },
    { kind: 'index_points', name: 'Preferred position', dimension: 'position', value: 'preferred', points: 30, target_dimension: 'buying_option' },
    { kind: 'index', name: 'March', dimension: 'month', value: '2027-03', factor: 1.1 },
    { kind: 'index', name: '20s spot', dimension: 'spot_length', value: '20s', factor: 0.75 },
    { kind: 'index', name: 'Market index (published)', dimension: 'always', factor: 1.08 },
  ],
});

function catalog() {
  const card = lateRateCard();
  const quote = evaluate(card, card.quoted_selection);
  const base = {
    publisher_properties: [{ publisher_domain: 'tvhuis.example', selection_type: 'all' }],
    delivery_type: 'guaranteed',
    format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: 'video_20s' }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 1440,
      timezone: 'Europe/Amsterdam',
      supports_webhooks: false,
      available_metrics: ['grps'],
      date_range_support: 'date_range',
    },
  };
  return [
    {
      ...base,
      product_id: 'nl_tv_prime_2554',
      name: 'Prime time, NMO 25-54, March 2027',
      description: 'Linear TV prime-time spots, bought per rating point.',
      channels: ['linear_tv'],
      pricing_options: [
        {
          pricing_option_id: 'po_prime_cpp_late',
          pricing_model: 'cpp',
          currency: 'EUR',
          fixed_price: quote.price,
          parameters: AUDIENCE,
          price_breakdown: quote.price_breakdown,
          extensions: [rateCardIndex.pricingOptionEntry(card)],
        },
        { pricing_option_id: 'po_prime_indexed_early', currency: 'EUR', ...linearTvIndexedCpp.indexedCppBranch(indexedTerms()) },
      ],
    },
    {
      ...base,
      product_id: 'nl_online_video',
      name: 'Online video, March 2027',
      description: 'Pre-roll on the broadcaster apps.',
      channels: ['olv'],
      delivery_type: 'non_guaranteed',
      pricing_options: [{ pricing_option_id: 'po_olv_cpm', pricing_model: 'cpm', currency: 'EUR', fixed_price: 28 }],
    },
  ];
}

/** A discovery product as a compact canonical product: canonical pricing options carry no pricing_option extension point. */
const CANONICAL_OPTION_KEYS = ['pricing_option_id', 'pricing_model', 'currency', 'fixed_price', 'floor_price', 'price_breakdown', 'parameters', 'min_spend_per_package', 'extension_model'];
export function canonicalProduct(p) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...pick(p, ['product_id', 'name', 'description', 'channels', 'delivery_type']),
    pricing_options: p.pricing_options.map((o) => pick(o, CANONICAL_OPTION_KEYS)),
  };
}

/** The buying layers the TV sales house implements, listed in its capabilities (`modules`). */
export const TV_SELLER_MODULES = ['buying/targeting', 'buying/pricing', 'buying/commitment', 'buying/supply', 'buying/offer', 'buying/execution'];

/**
 * @param options.ignoreUnderstood a misbehaving seller (conformance fixtures): it ignores the
 *   buyer's understood_extensions and sends every extension it supports. true: everywhere;
 *   'products': in product lists only (get_products, and request_proposals products), so the
 *   proposal's signed terms stay projected.
 */
export function createTvSeller({ now = () => Date.parse('2026-12-01T09:00:00Z'), ignoreUnderstood = false, modules = TV_SELLER_MODULES } = {}) {
  const server = createAdcpServer({ protocols: ['media_buy'], ignoreUnderstood: ignoreUnderstood === true, modules });
  server.declare(linearTvIndexedCpp, { capabilities: linearTvIndexedCpp.capabilitiesFragment({ channels: ['linear_tv'], points_sources: ['nmo'] }) });
  server.declare(rateCardIndex, { points: ['pricing_option'] }); // the explanatory card only; this seller never signs it

  const proposals = new Map();
  const mediaBuys = new Map();
  let seq = 0;
  const nextId = (p) => `${p}_${++seq}`;
  const everything = new Set(server.declared.map((d) => refKey(d.uri, d.digest)));
  /** What a product list may carry for this caller; 'products' mode leaks every extension into product lists only. */
  const forProducts = (ctx) => (ignoreUnderstood === 'products' ? everything : ctx.understood);

  /** The buyer's March plan, priced in the best model this buyer can read. */
  function commercialTermsFor(understood) {
    const prime = projectProduct(catalog()[0], understood); // always keeps the core cpp option
    const indexed = prime.pricing_options.find((o) => o.pricing_model === INDEXED_BRANCH);
    const late = prime.pricing_options.find((o) => o.pricing_option_id === 'po_prime_cpp_late');
    const pricing = indexed
      ? { pricing_option_id: indexed.pricing_option_id, currency: 'EUR', ...linearTvIndexedCpp.indexedCppBranch(linearTvIndexedCpp.readIndexedCpp(indexed)) }
      : { pricing_option_id: late.pricing_option_id, pricing_model: 'cpp', currency: 'EUR', fixed_price: late.fixed_price, parameters: AUDIENCE, price_breakdown: late.price_breakdown };
    // The budget caps spend in currency (core). At the ceiling it buys POINTS; at a lower fixed rate, more.
    const rate = indexed ? linearTvIndexedCpp.readIndexedCpp(indexed).ceiling_price : late.fixed_price;
    const budget = rate * POINTS;
    return {
      brand: { domain: 'brand.example.com' },
      purchases: [{ product_id: prime.product_id, pricing_option_id: pricing.pricing_option_id, pricing, budget, ...FLIGHT }],
      ...FLIGHT,
      total_budget: { amount: budget, currency: 'EUR' },
    };
  }

  function snapshot(fields) {
    const p = { ...fields, terms_digest: termsDigest(fields.commercial_terms) };
    server.assertCore('/schemas/core/canonical-proposal.json', p, 'proposal', 'INVALID_RESPONSE');
    proposals.set(p.proposal_id, p);
    return structuredClone(p);
  }

  /** Discovery: products and pricing options only. Proposals come from request_proposals. */
  server.handle('get_products', (req, ctx) => {
    const products = catalog().map((p) => projectProduct(p, forProducts(ctx))).filter(Boolean);
    for (const p of products) server.assertCore('/schemas/core/product.json', p, `product ${p.product_id}`, 'INVALID_RESPONSE');
    return { products };
  });

  server.handle('request_proposals', (req, ctx) => {
    const draft = snapshot({
      proposal_id: nextId('prop'),
      proposal_kind: 'new_media_buy',
      proposal_status: 'draft',
      expires_at: iso(now() + 2 * DAY),
      name: 'Prime time 25-54, March 2027',
      commercial_terms: commercialTermsFor(ctx.understood),
    });
    const products = catalog().map((p) => projectProduct(p, forProducts(ctx))).filter(Boolean).map(canonicalProduct);
    return { status: 'completed', outcome: 'proposed', proposals: [draft], products };
  });

  server.handle('refine_proposals', (req, ctx) => ({
    proposals: req.refinements.map((r) => {
      const src = proposals.get(r.proposal_id);
      if (!src || src.proposal_status !== 'draft' || r.action !== 'finalize') throw new SellerRejection('INVALID_REQUEST', 'only finalize of a draft is modelled');
      const { terms_digest, ...rest } = src;
      return snapshot({
        ...rest,
        proposal_id: nextId('prop'),
        proposal_status: 'committed',
        expires_at: iso(now() + 3 * DAY),
        commercial_terms: commercialTermsFor(ctx.understood),
      });
    }),
  }));

  server.handle('accept_proposal', (req) => {
    const p = proposals.get(req.proposal_id);
    if (!p || p.proposal_status !== 'committed') throw new SellerRejection('PROPOSAL_NOT_COMMITTED', req.proposal_id);
    if (p.terms_digest !== req.proposal_terms_digest) throw new SellerRejection('TERMS_DIGEST_MISMATCH', req.proposal_id);
    const media_buy_id = nextId('mb');
    const ct = p.commercial_terms;
    mediaBuys.set(media_buy_id, {
      media_buy_id,
      name: req.name ?? p.name,
      accepted_proposal_id: p.proposal_id,
      accepted_proposal_terms_digest: p.terms_digest,
      accepted_proposal: { ...structuredClone(p), proposal_status: 'accepted', accepted_at: iso(now()), media_buy_id },
      status: 'pending_start',
      currency: 'EUR',
      total_budget: ct.total_budget.amount,
      start_time: ct.start_time,
      end_time: ct.end_time,
      confirmed_at: iso(now()),
      revision: 1,
      available_actions: [],
      packages: ct.purchases.map((pu, i) => ({ package_id: `pkg_${i + 1}`, product_id: pu.product_id, budget: pu.budget, start_time: pu.start_time, end_time: pu.end_time })),
    });
    return { media_buy_id, revision: 1, accepted_proposal_id: p.proposal_id };
  });

  server.handle('get_media_buys', (req) => ({
    status: 'completed',
    media_buys: (req.media_buy_ids ?? [...mediaBuys.keys()]).map((id) => structuredClone(mediaBuys.get(id))),
  }));

  /** The accepted indexed_cpp data of a purchase, or a rejection when it is priced in a core model. */
  const acceptedModel = (mb, i = 0) => {
    const model = linearTvIndexedCpp.readIndexedCpp(mb.accepted_proposal.commercial_terms.purchases[i].pricing);
    if (!model) throw new SellerRejection('NOT_INDEXED', 'this purchase is priced in a core model; there is no index to fix');
    return model;
  };

  const ops = {
    /**
     * The day after the request deadline: fix the market index and write readback.
     * `rate` overrides the computed rate (to simulate a seller error).
     */
    fixMarketIndex(mediaBuyId, marketIndex, { rate, at = '2027-01-16T09:00:00+01:00' } = {}) {
      const mb = mediaBuys.get(mediaBuyId);
      const model = acceptedModel(mb);
      mb.revision += 1;
      const change = server.publish({
        change_id: nextId('chg'),
        recorded_at: iso(now()),
        resource: { type: 'media_buy', account_id: 'acc_brand_example', resource_id: mb.media_buy_id },
        action: 'updated',
        origin: { kind: 'seller_system' },
        resource_revision: mb.revision,
        changed_paths: ['/extensions_state'],
        repair: { task: 'get_media_buys' },
        reason: 'market_index_fixed',
        summary: `market index fixed at ${marketIndex * 100}`,
      });
      const fixing = { purchase_index: 0, market_index: marketIndex, rate: rate ?? rateAt(model, marketIndex), fixed_at: at, revision: mb.revision, change_id: change.change_id };
      mb.extensions_state = [linearTvIndexedCpp.mediaBuyStateEntry({ fixings: [fixing] })];
      return change;
    },

    /** After airing: the invoice line for delivered rating points, at the fixed rate. */
    invoice(mediaBuyId, deliveredPoints) {
      const mb = mediaBuys.get(mediaBuyId);
      const fixing = linearTvIndexedCpp.readMediaBuyState(mb)?.fixings[0];
      if (!fixing) throw new SellerRejection('INDEX_NOT_FIXED', 'the market index is not fixed yet; invoice after fixing');
      return settle(acceptedModel(mb), fixing, deliveredPoints);
    },
  };

  const transport = server.transport;
  const supported = server.declared.map(({ uri, digest, points, capabilities }) => ({ uri, digest, ...(points ? { points } : {}), ...(capabilities ? { capabilities } : {}) }));
  return { transport, ops, supported, catalog };
}
