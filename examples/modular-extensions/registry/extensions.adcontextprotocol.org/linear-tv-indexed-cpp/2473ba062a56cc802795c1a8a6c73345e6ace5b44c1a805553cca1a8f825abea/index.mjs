// @adcp-ext/linear-tv-indexed-cpp: runtime half of a pricing-model extension.
//
// The bundle registers branch `indexed_cpp` in the core open union pricing_model.
// This file is what "understanding" the branch means:
//  - pricing_model:   the ceiling reproduces from base x indices x cap; the
//                     option sits on a product in a channel the model applies to;
//  - media_buy_state: a fixed market index is inside [floor, cap], fixed no
//                     earlier than agreed, and the rate follows from it;
//  - settle():        the invoice is delivered points x the fixed rate.
// Both sides use the same code: the seller to quote, the buyer to verify.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = path.dirname(fileURLToPath(import.meta.url));
export const BRANCH = 'indexed_cpp';
const BRANCH_DECL = JSON.parse(readFileSync(path.join(packageDir, 'extension.json'), 'utf8')).extends.find((e) => e.branch === BRANCH);

// Exact decimal arithmetic on BigInt, scaled by 10^12 (same approach as rate-card-index).
const SCALE_DIGITS = 12;
const dec = (n) => BigInt(Number(n).toFixed(SCALE_DIGITS).replace('.', ''));
const mul = (a, b) => (a * b) / 10n ** BigInt(SCALE_DIGITS);
const abs = (a) => (a < 0n ? -a : a);
function round(a, decimals, mode) {
  const q = 10n ** BigInt(SCALE_DIGITS - decimals);
  const sign = a < 0n ? -1n : 1n;
  let whole = abs(a) / q;
  const rem2 = (abs(a) % q) * 2n;
  if (rem2 > q || (rem2 === q && (mode === 'half_away_from_zero' || whole % 2n === 1n))) whole += 1n;
  return sign * whole * q;
}
const num = (a) => {
  const s = abs(a).toString().padStart(SCALE_DIGITS + 1, '0');
  return Number(`${a < 0n ? '-' : ''}${s.slice(0, -SCALE_DIGITS)}.${s.slice(-SCALE_DIGITS)}`);
};

/** Rate per rating point at a given market index: base x each index x market, rounded after each step. */
export function rateAt(data, marketIndex) {
  const { decimals, mode } = data.rounding;
  let running = dec(data.base_price);
  for (const i of data.indices) running = round(mul(running, dec(i.factor)), decimals, mode);
  return num(round(mul(running, dec(marketIndex)), decimals, mode));
}

export const ceiling = (data) => rateAt(data, data.market_index.cap);

/** The invoice line for delivered points once the index is fixed (core spend stays rate x points, in currency). */
export function settle(data, fixing, deliveredPoints) {
  const rate = rateAt(data, fixing.market_index);
  const amount = num(round(mul(dec(deliveredPoints), dec(rate)), 2, 'half_away_from_zero'));
  return { rate, points: deliveredPoints, amount };
}

const isProduct = (n) => n && typeof n === 'object' && !Array.isArray(n) && typeof n.product_id === 'string' && Array.isArray(n.pricing_options);

function checkModel(data, { decl, ancestors = [] }) {
  const errors = [];
  const warnings = [];
  const ceil = ceiling(data);
  if (ceil !== data.ceiling_price) errors.push(`INDEXED_CPP_CEILING_MISMATCH: base x indices x cap gives ${ceil}, ceiling_price is ${data.ceiling_price}`);
  const { floor, cap } = data.market_index;
  if (floor !== undefined && floor > cap) errors.push(`INDEXED_CPP_BOUNDS: market index floor ${floor} is above cap ${cap}`);
  // Scope: the model applies to some channels only. The product (when the option is on one) must be sold in one of them.
  const product = ancestors.findLast(isProduct);
  const allowed = decl?.applies_to?.channels;
  if (product && allowed && !(product.channels ?? []).some((c) => allowed.includes(c))) {
    errors.push(`INDEXED_CPP_OUT_OF_SCOPE: product ${product.product_id} is sold as [${product.channels ?? []}]; ${BRANCH} applies to [${allowed}]`);
  }
  warnings.push(`INDEXED_CPP_PROVISIONAL: rate is at most ${ceil} per point until the market index is fixed at ${data.market_index.fixed_at}`);
  return { errors, warnings, evaluation: { ceiling_price: ceil, floor_price: floor !== undefined ? rateAt(data, floor) : undefined } };
}

function checkFixings(state, { enclosing, self }) {
  const violations = [];
  const purchases = enclosing.accepted_proposal?.commercial_terms?.purchases ?? [];
  for (const f of state.fixings) {
    const at = `fixing for purchase ${f.purchase_index}`;
    const pricing = purchases[f.purchase_index]?.pricing;
    const body = pricing?.extension_model;
    if (pricing?.pricing_model !== `${self.uri}#${BRANCH}` || body?.uri !== self.uri) {
      violations.push(`${at}: the accepted purchase is not priced with ${BRANCH}`);
      continue;
    }
    const data = body.data;
    const { floor, cap, fixed_at } = data.market_index;
    if (f.market_index > cap) violations.push(`${at}: market index ${f.market_index} is above the signed cap ${cap}`);
    if (floor !== undefined && f.market_index < floor) violations.push(`${at}: market index ${f.market_index} is below the signed floor ${floor}`);
    if (Date.parse(f.fixed_at) < Date.parse(fixed_at)) violations.push(`${at}: fixed at ${f.fixed_at}, before the agreed ${fixed_at}`);
    const rate = rateAt(data, f.market_index);
    if (rate !== f.rate) violations.push(`${at}: rate ${f.rate} does not follow from index ${f.market_index} (expected ${rate})`);
  }
  return { errors: [], warnings: [], violations };
}

/**
 * Semantic checks the schema cannot express. Called only after the data has
 * validated against this module's definition for the hook.
 */
export function check(point, data, context) {
  if (point === 'pricing_model' && context.branch === BRANCH) return checkModel(data, context);
  if (point === 'media_buy_state') return checkFixings(data, context);
  if (point === 'capabilities') {
    const allowed = BRANCH_DECL.applies_to.channels;
    const outside = allowed ? data.channels.filter((c) => !allowed.includes(c)) : [];
    return { errors: [], warnings: outside.length ? [`INDEXED_CPP_CAPABILITY_SCOPE: declared for [${outside}], outside the model's channels`] : [] };
  }
  return { errors: [`linear-tv-indexed-cpp does not attach at ${point}`], warnings: [] };
}
