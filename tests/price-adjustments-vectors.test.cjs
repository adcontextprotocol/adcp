/**
 * Validates the price_adjustments resolution vectors in
 * static/compliance/source/test-vectors/price-adjustments/vectors.json.
 *
 * Layers:
 *   1. Every declared option validates against pricing-option.json (product
 *      offer) and canonical-pricing-option.json (accepted snapshot).
 *   2. A reference resolver implementing the normative rule reproduces every
 *      expected resolved price and ordered application, in exact integer
 *      arithmetic at the option's price precision (no floating-point drift).
 *   3. The resolved snapshot (resolved fixed_price, price_breakdown of fired
 *      rows, retained table) validates against canonical-pricing-option.json and
 *      folds back to fixed_price per the price-breakdown invariant.
 *   4. Negative schema cases are rejected and the changed-table identity rule
 *      holds.
 *
 * SDKs consume the same vector file to check their own resolvers.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const vectors = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'static', 'compliance', 'source', 'test-vectors', 'price-adjustments', 'vectors.json'),
    'utf8',
  ),
);

function loadSchemaUri(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadSchemaUri });
  addFormats(ajv);
  return ajv.compileAsync(loadSchemaUri(uri));
}

// --- Reference resolver (the normative rule, in exact integer arithmetic) -----

function decimalPlaces(n) {
  const [, frac = ''] = String(n).split('.');
  return frac.length;
}

function minorExponent(currency) {
  const e = vectors.currency_minor_unit_exponent[currency];
  assert.notEqual(e, undefined, `vector currency ${currency} needs an exponent`);
  return e;
}

// Price precision: the greater of the currency minor-unit exponent and the most
// decimal places carried by fixed_price and any row amount.
function pricePrecision(option) {
  const places = [minorExponent(option.currency), decimalPlaces(option.fixed_price)];
  for (const row of option.price_adjustments || []) {
    if (row.amount !== undefined) places.push(decimalPlaces(row.amount));
  }
  return Math.max(...places);
}

function toScaled(amount, precision) {
  const digits = BigInt(String(amount).replace('.', ''));
  return digits * 10n ** BigInt(precision - decimalPlaces(amount));
}

function toNumber(scaled, precision) {
  return Number(scaled) / 10 ** precision;
}

// Rate as an exact fraction numerator/denominator from its decimal string.
function rateFraction(rate) {
  return { num: BigInt(String(rate).replace('.', '')), den: 10n ** BigInt(decimalPlaces(rate)) };
}

function divRoundHalfAwayFromZero(n, d) {
  const negative = n < 0n;
  const an = negative ? -n : n;
  const q = (2n * an + d) / (2n * d);
  return negative ? -q : q;
}

// Full-identity keys, so different encodings of one value compare equal and the
// same ID under a different scope does not.
function formatKey(ref) {
  return ref.scope === 'publisher' ? `p:${ref.publisher_domain}:${ref.format_option_id}` : `l:${ref.format_option_id}`;
}

function placementKey(ref) {
  return ref.kind === 'seller_inline'
    ? `s:${JSON.stringify(ref.seller_agent)}:${ref.placement_id}`
    : `p:${ref.publisher_domain}:${ref.placement_id}`;
}

function selectedKeys(selection) {
  const placements = selection.placement_selection;
  return {
    format_option: new Set((selection.format_option_refs || []).map(formatKey)),
    placement_selection: new Set(
      placements && placements.mode === 'selected' ? placements.placement_refs.map(placementKey) : [],
    ),
  };
}

function rowKey(row) {
  return row.dimension === 'format_option' ? formatKey(row.format_option_ref) : placementKey(row.placement_ref);
}

function firingRows(option, selection) {
  const selected = selectedKeys(selection);
  const fired = new Set();
  const winners = [];
  for (const row of option.price_adjustments || []) {
    if (fired.has(row.dimension)) continue;
    if (selected[row.dimension] && selected[row.dimension].has(rowKey(row))) {
      fired.add(row.dimension);
      winners.push(row);
    }
  }
  return winners; // declared order is application order
}

function applyRows(startScaled, rows, precision) {
  let running = startScaled;
  for (const row of rows) {
    const sign = row.kind === 'fee' ? 1n : -1n;
    let delta;
    if (row.amount !== undefined) {
      delta = toScaled(row.amount, precision);
    } else {
      const { num, den } = rateFraction(row.rate);
      delta = divRoundHalfAwayFromZero(running * num, den);
    }
    running += sign * delta;
    if (running < 0n) return null;
  }
  return running;
}

function resolve(option, selection) {
  const precision = pricePrecision(option);
  const rows = firingRows(option, selection);
  const total = applyRows(toScaled(option.fixed_price, precision), rows, precision);
  return total === null ? null : { rows, precision, fixed_price: toNumber(total, precision) };
}

function resolvedSnapshot(option, rows, fixedPrice) {
  const snapshot = { ...option, fixed_price: fixedPrice };
  if (!rows.length) return snapshot;
  snapshot.base_fixed_price = option.fixed_price;
  const declared = option.price_breakdown;
  snapshot.price_breakdown = {
    list_price: declared ? declared.list_price : option.fixed_price,
    adjustments: [
      ...(declared ? declared.adjustments : []),
      ...rows.map(({ kind, name, rate, amount }) => ({ kind, name, ...(rate !== undefined ? { rate } : { amount }) })),
    ],
  };
  return snapshot;
}

// --- Tests -------------------------------------------------------------------

test('every declared option validates as a product pricing option and a canonical snapshot option', async () => {
  const [validateOffer, validateCanonical] = await Promise.all([
    compile('/schemas/core/pricing-option.json'),
    compile('/schemas/core/canonical-pricing-option.json'),
  ]);
  for (const [name, option] of Object.entries(vectors.options)) {
    assert.ok(validateOffer(option), `${name} as offer: ${JSON.stringify(validateOffer.errors)}`);
    assert.ok(validateCanonical(option), `${name} as canonical: ${JSON.stringify(validateCanonical.errors)}`);
  }
});

test('resolution cases reproduce the resolved price and ordered application', async () => {
  const validateCanonical = await compile('/schemas/core/canonical-pricing-option.json');
  for (const c of vectors.resolution_cases) {
    const option = vectors.options[c.option];
    const result = resolve(option, c.selection);
    assert.ok(result, `${c.id}: resolved to a negative price`);
    assert.equal(result.fixed_price, c.expect.fixed_price, `${c.id}: fixed_price`);
    assert.deepEqual(
      result.rows.map(row => row.name),
      c.expect.applied,
      `${c.id}: applied rows`,
    );

    const snapshot = resolvedSnapshot(option, result.rows, result.fixed_price);
    assert.ok(validateCanonical(snapshot), `${c.id}: snapshot ${JSON.stringify(validateCanonical.errors)}`);
    if (snapshot.price_breakdown) {
      // The price-breakdown invariant folds list_price through every adjustment.
      const folded = applyRows(
        toScaled(snapshot.price_breakdown.list_price, result.precision),
        snapshot.price_breakdown.adjustments,
        result.precision,
      );
      assert.equal(toNumber(folded, result.precision), snapshot.fixed_price, `${c.id}: breakdown invariant`);
      // The snapshot alone re-derives the resolved price from base_fixed_price.
      assert.equal(snapshot.base_fixed_price, option.fixed_price, `${c.id}: base_fixed_price`);
    } else {
      assert.equal(snapshot.base_fixed_price, undefined, `${c.id}: no base_fixed_price when no row fired`);
    }
  }
});

test('a discount that would drive the running total below zero has no valid resolution', () => {
  for (const c of vectors.invalid_resolution_cases) {
    assert.equal(resolve(vectors.options[c.option], c.selection), null, c.id);
    assert.equal(c.expect_error, 'below_zero');
    assert.equal(c.expect_outcome, 'INVALID_REQUEST');
  }
});

test('buyer-supplied pricing must equal the resolved result', () => {
  for (const c of vectors.buyer_supplied_pricing_cases) {
    const result = resolve(vectors.options[c.option], c.selection);
    const outcome = result.fixed_price === c.supplied_fixed_price ? 'accepted' : 'INVALID_REQUEST';
    assert.equal(outcome, c.expect, c.id);
    if (c.error_field) {
      assert.match(c.error_field, /^pricing\./);
      assert.equal(result.fixed_price, c.resolved_fixed_price, `${c.id}: resolved value carried in error details`);
    }
  }
});

test('a changed table requires a distinct pricing_option_id', () => {
  for (const c of vectors.identity_cases) {
    const previous = vectors.options[c.previous];
    const current = vectors.options[c.current];
    assert.notDeepEqual(previous.price_adjustments, current.price_adjustments, c.id);
    assert.notEqual(previous.pricing_option_id, current.pricing_option_id, c.id);
  }
});

test('schema negative cases are rejected', async () => {
  const [validateOffer, validateCanonical] = await Promise.all([
    compile('/schemas/core/pricing-option.json'),
    compile('/schemas/core/canonical-pricing-option.json'),
  ]);
  for (const c of vectors.schema_negative_cases) {
    const option = { ...vectors.options.cpm_rate_card };
    for (const [key, value] of Object.entries(c.mutate)) {
      if (value === null) delete option[key];
      else option[key] = value;
    }
    if (c.applies_to !== 'canonical') {
      assert.equal(validateOffer(option), false, `${c.id} should be invalid as an offer`);
    }
    assert.equal(validateCanonical(option), false, `${c.id} should be invalid as canonical`);
  }
});
