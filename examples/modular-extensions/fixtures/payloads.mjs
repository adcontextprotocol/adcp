// Seller messages used by the demo and the tests. Digests come from the
// extension lock files, so the fixtures stay valid after a rebuild.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = (pkg) => JSON.parse(readFileSync(path.join(ROOT, 'packages', pkg, 'extension.lock.json'), 'utf8'));
export const RATE_CARD = lock('ext-rate-card-index');
export const SELLER_ADJ = lock('ext-seller-adjustable-terms');
export const DAYPART = lock('acmetv-ext-daypart-codes');
export const bundleOf = (pkg) => JSON.parse(readFileSync(path.join(ROOT, 'packages', pkg, 'dist/bundle.json'), 'utf8'));

/** A Ster-style card: base x buying option (+ position points) x month x spot length x market. */
export const rateCard = () => ({
  base_price: 1000,
  premium_basis: 'indexed',
  rounding: { step: 'each_row', decimals: 0, mode: 'half_away_from_zero' },
  quoted_selection: {
    values: { buying_option: 'vast', position: 'preferred', month: '2027-03', spot_length: '20s' },
    start_time: '2027-03-01T00:00:00+01:00',
  },
  rows: [
    { kind: 'index', name: 'Your Time Vast', dimension: 'buying_option', value: 'vast', factor: 2.0 },
    { kind: 'index', name: 'Your Time Variabel', dimension: 'buying_option', value: 'variabel', factor: 1.85 },
    { kind: 'index_points', name: 'Preferred position', dimension: 'position', value: 'preferred', points: 30, target_dimension: 'buying_option' },
    { kind: 'index', name: 'March', dimension: 'month', value: '2027-03', factor: 1.1 },
    { kind: 'index', name: 'April', dimension: 'month', value: '2027-04', factor: 1.15 },
    { kind: 'index', name: '20s spot', dimension: 'spot_length', value: '20s', factor: 0.75 },
    { kind: 'index', name: '30s spot', dimension: 'spot_length', value: '30s', factor: 1.0 },
    { kind: 'index', name: '60s spot', dimension: 'spot_length', value: '60s', factor: 1.8 },
    {
      kind: 'index',
      name: 'Market index (early request, capped at 100)',
      dimension: 'always',
      status: 'provisional',
      cap: 1.0,
      fixed_at: '2027-01-16T00:00:00+01:00',
    },
    { kind: 'fee', name: 'First in break', dimension: 'position', value: 'first_in_break', rate: 0.3 },
  ],
});

/** What the seller quotes for rateCard().quoted_selection: 1000 x 2.30 x 1.10 x 0.75, whole euros per step. */
export const quotedBreakdown = () => ({
  list_price: 1000,
  adjustments: [
    { kind: 'fee', name: 'index:buying_option', amount: 1300, description: 'Your Time Vast + preferred position (x2.3)' },
    { kind: 'fee', name: 'index:month', amount: 230, description: 'March (x1.1)' },
    { kind: 'discount', name: 'index:spot_length', amount: 632, description: '20s spot (x0.75)' },
  ],
});

/** get_products: one cpp pricing option, core quote + two optional extension entries. */
export const pricingOption = () => ({
  pricing_option_id: 'po_prime_cpp_2554',
  pricing_model: 'cpp',
  currency: 'EUR',
  fixed_price: 1898,
  parameters: { demographic_system: 'nmo', demographic: '25-54' },
  price_breakdown: quotedBreakdown(),
  eligible_adjustments: ['fee', 'discount'],
  extensions: [
    { uri: RATE_CARD.uri, digest: RATE_CARD.digest, data: rateCard() },
    {
      uri: DAYPART.uri,
      digest: DAYPART.digest,
      data: { dayparts: [{ code: 'PT1', label: 'Prime 1', start: '19:00', end: '21:00' }] },
    },
  ],
});

/** Accepted commercial terms: core purchase + two binding (must-understand) extension entries. */
export const commercialTerms = () => {
  const card = rateCard();
  const selection = card.quoted_selection;
  delete card.quoted_selection;
  return {
    brand: { domain: 'brand.example.com' },
    purchases: [
      {
        product_id: 'nl_tv_prime',
        pricing_option_id: 'po_prime_cpp_2554',
        pricing: {
          pricing_option_id: 'po_prime_cpp_2554',
          pricing_model: 'cpp',
          currency: 'EUR',
          fixed_price: 1898,
          parameters: { demographic_system: 'nmo', demographic: '25-54' },
          price_breakdown: quotedBreakdown(),
        },
        budget: 189800,
        start_time: '2027-03-01T00:00:00+01:00',
        end_time: '2027-03-31T23:59:59+02:00',
      },
    ],
    start_time: '2027-03-01T00:00:00+01:00',
    end_time: '2027-03-31T23:59:59+02:00',
    extensions: [
      { uri: RATE_CARD.uri, digest: RATE_CARD.digest, data: { purchase_index: 0, selection, rate_card: card } },
      {
        uri: SELLER_ADJ.uri,
        digest: SELLER_ADJ.digest,
        data: {
          allowances: [
            {
              allowance_id: 'allow_release_1',
              purchase_index: 0,
              path: '/budget',
              constraint: { kind: 'decrease', max_change_fraction: 0.2 },
              min_notice: { interval: 7, unit: 'days' },
            },
            {
              allowance_id: 'allow_shift_1',
              purchase_index: 0,
              path: '/start_time',
              constraint: { kind: 'time_shift', direction: 'later', max_shift: { interval: 2, unit: 'days' } },
              min_notice: { interval: 24, unit: 'hours' },
            },
          ],
        },
      },
    ],
  };
};

/** get_adcp_capabilities from the seller. */
export const sellerCapabilities = () => ({
  status: 'completed',
  adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
  supported_protocols: ['media_buy'],
  declared_extensions: [
    { uri: RATE_CARD.uri, digest: RATE_CARD.digest, points: ['pricing_option', 'commercial_terms'] },
    { uri: SELLER_ADJ.uri, digest: SELLER_ADJ.digest, points: ['commercial_terms'] },
    { uri: DAYPART.uri, digest: DAYPART.digest, points: ['pricing_option'] },
  ],
});

/** An extension the buyer has never seen, marked must-understand. */
export const UNKNOWN_MU = {
  uri: 'https://ext.acmetv.example.com/adcp/make-good-credits',
  digest: 'sha256:' + 'ab'.repeat(32),
};
