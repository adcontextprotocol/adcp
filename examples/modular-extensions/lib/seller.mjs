// Seller-side projection for one buyer: the mirror of the buyer's fail-closed rule.
// `understood` is the set of uri@digest the buyer declared in
// understood_extensions (kernel field on the request envelope).
import { refKey } from './digest.mjs';
import { BRANCH_ID_RE } from './buyer-validator.mjs';

/**
 * Returns the pricing option to send, or null when it cannot be offered to
 * this buyer: its pricing model is an extension branch the buyer does not
 * understand, or it carries a must-understand entry the buyer does not
 * understand. Optional entries the buyer does not understand are dropped to save bytes.
 */
export function projectPricingOption(option, understood) {
  if (BRANCH_ID_RE.test(option.pricing_model ?? '')) {
    const body = option.extension_model;
    if (!body || !understood.has(refKey(body.uri, body.digest))) return null;
  }
  if (!option.extensions) return option;
  const kept = [];
  for (const t of option.extensions) {
    const ok = understood.has(refKey(t.uri, t.digest));
    if (!ok && t.must_understand) return null;
    if (ok) kept.push(t);
  }
  const { extensions, ...rest } = option;
  return kept.length ? { ...rest, extensions: kept } : rest;
}

/** A product with only the pricing options this buyer can buy, or null when none is left. */
export function projectProduct(product, understood) {
  const pricing_options = product.pricing_options.map((o) => projectPricingOption(o, understood)).filter(Boolean);
  return pricing_options.length ? { ...product, pricing_options } : null;
}
