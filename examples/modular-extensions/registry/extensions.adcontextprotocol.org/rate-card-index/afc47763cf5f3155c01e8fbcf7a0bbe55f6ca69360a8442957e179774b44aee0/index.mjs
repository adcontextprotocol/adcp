// @adcp-ext/rate-card-index: runtime half of the extension module.
//
// The bundle (dist/bundle.json) says what the data looks like. This file is
// what it means for a buyer to "understand" the extension: evaluate the card
// and cross-check it against the core quote. A buyer that has only the schema
// can validate the schema, but cannot act on a must-understand entry.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = path.dirname(fileURLToPath(import.meta.url));

// Exact decimal arithmetic on BigInt, scaled by 10^12. Floats make
// 1897.5 round differently on different engines (SDK review: an exact-decimal
// resolver is the real SDK cost of #7955).
const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const dec = (n) => BigInt(Number(n).toFixed(SCALE_DIGITS).replace('.', ''));
const mul = (a, b) => (a * b) / SCALE;
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
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function applies(row, selection) {
  const at = selection.start_time && Date.parse(selection.start_time);
  if (at && row.valid_from && at < Date.parse(row.valid_from)) return false;
  if (at && row.valid_until && at >= Date.parse(row.valid_until)) return false;
  if (row.dimension === 'always') return true;
  if (row.dimension === 'format_option') return sameJson(row.format_option_ref, selection.format_option_ref);
  return selection.values?.[row.dimension] === row.value;
}

/**
 * Evaluate a rate card for one selection.
 * Returns the price, a price_breakdown in the core format, and any provisional rows.
 */
export function evaluate(card, selection) {
  const { decimals, mode, step } = card.rounding;
  const r = (a) => (step === 'each_row' ? round(a, decimals, mode) : a);
  const errors = [];
  const firstPerDimension = (kinds) => {
    const seen = new Set();
    return card.rows.filter((row) => {
      if (!kinds.includes(row.kind) || seen.has(row.dimension) || !applies(row, selection)) return false;
      if (row.dimension !== 'always') seen.add(row.dimension); // always rows each fire (#7955)
      return true;
    });
  };

  const indexRows = firstPerDimension(['index']).map((row) => ({ row, points: 0n, labels: [row.name] }));
  for (const pts of firstPerDimension(['index_points'])) {
    const target = indexRows.find((i) => i.row.dimension === pts.target_dimension);
    if (!target) errors.push(`index_points row "${pts.name}" targets ${pts.target_dimension}, but no index row fired there`);
    else {
      target.points += dec(pts.points) / 100n;
      target.labels.push(pts.name);
    }
  }

  const base = dec(card.base_price);
  let running = base;
  const adjustments = [];
  const provisional = [];
  const record = (delta, name, description) => {
    if (delta === 0n) return;
    adjustments.push({ kind: delta > 0n ? 'fee' : 'discount', name, amount: num(abs(delta)), description });
  };

  for (const { row, points, labels } of indexRows) {
    let factor = row.status === 'provisional' ? dec(row.cap) : dec(row.factor);
    factor += points;
    if (row.status === 'provisional') provisional.push({ name: row.name, cap: row.cap, fixed_at: row.fixed_at });
    const next = r(mul(running, factor));
    record(next - running, `index:${row.dimension}`, `${labels.join(' + ')} (x${num(factor)})`);
    running = next;
  }

  const indexed = running;
  const basis = card.premium_basis === 'base' ? base : indexed;
  for (const row of firstPerDimension(['fee', 'discount'])) {
    const amt = r(row.rate !== undefined ? mul(basis, dec(row.rate)) : dec(row.amount));
    const delta = row.kind === 'fee' ? amt : -amt;
    record(delta, `premium:${row.dimension}`, row.name);
    running += delta;
  }

  const price = round(running < 0n ? 0n : running, decimals, mode);
  return {
    price: num(price),
    price_breakdown: { list_price: card.base_price, adjustments },
    provisional,
    errors,
  };
}

const sameBreakdown = (a, b) =>
  a.list_price === b.list_price &&
  a.adjustments.length === b.adjustments.length &&
  a.adjustments.every((x, i) => x.kind === b.adjustments[i].kind && x.amount === b.adjustments[i].amount);

/**
 * Semantic checks the schema cannot express. Called only after the data has
 * validated against this module's definition for the extension point.
 * `enclosing` is the core object that holds extensions.
 */
export function check(point, data, { enclosing }) {
  const errors = [];
  const warnings = [];

  if (point === 'pricing_option') {
    if (!data.quoted_selection) return { errors, warnings };
    const res = evaluate(data, data.quoted_selection);
    errors.push(...res.errors);
    if (enclosing.fixed_price !== undefined && res.price !== enclosing.fixed_price) {
      // Market survey: the seller's quote binds; a local difference is a warning, not INVALID_REQUEST.
      warnings.push(`RATE_CARD_QUOTE_DIFFERS: card evaluates to ${res.price}, seller quotes ${enclosing.fixed_price}; the quote binds`);
    }
    if (enclosing.price_breakdown && !sameBreakdown(res.price_breakdown, enclosing.price_breakdown)) {
      warnings.push('RATE_CARD_BREAKDOWN_DIFFERS: local breakdown differs from the seller price_breakdown');
    }
    for (const p of res.provisional) {
      warnings.push(`RATE_CARD_PROVISIONAL: "${p.name}" is fixed at ${p.fixed_at}; quote is a ceiling (factor <= ${p.cap})`);
    }
    return { errors, warnings, evaluation: res };
  }

  if (point === 'commercial_terms') {
    const purchase = enclosing.purchases?.[data.purchase_index];
    if (!purchase) {
      errors.push(`purchase_index ${data.purchase_index} is outside commercial_terms.purchases`);
      return { errors, warnings };
    }
    const res = evaluate(data.rate_card, data.selection);
    errors.push(...res.errors);
    if (purchase.pricing?.fixed_price !== res.price) {
      // Inside signed terms a disagreement is fatal: the buyer cannot tell which number it is signing.
      errors.push(`RATE_CARD_TERMS_INCONSISTENT: signed card gives ${res.price}, purchase ${data.purchase_index} pricing.fixed_price is ${purchase.pricing?.fixed_price}`);
    }
    for (const p of res.provisional) {
      warnings.push(`RATE_CARD_PROVISIONAL: purchase ${data.purchase_index} price is a ceiling until ${p.fixed_at}; expect a seller re-quote`);
    }
    return { errors, warnings, evaluation: res };
  }

  return { errors: [`rate-card-index does not attach at ${point}`], warnings };
}
