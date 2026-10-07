/**
 * Validates the price_adjustments resolution vectors in
 * static/compliance/source/test-vectors/price-adjustments/vectors.json.
 *
 * Layers:
 *   1. Every declared option validates against pricing-option.json (product
 *      offer) and canonical-pricing-option.json (accepted snapshot).
 *   2. A reference resolver implementing the normative additive rule
 *      reproduces every resolved price, ordered application, and fired-row
 *      amount in exact integer arithmetic at the option's price precision.
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

const PER_UNIT_MODELS = new Set(['cpm', 'vcpm', 'cpc', 'cpcv', 'cpv']);

// Exact decimal parse of a JSON number by value, never by lexical form:
// trailing zeros and exponent notation do not change the result.
function parseDecimal(n) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  assert.ok(m, `unparseable number ${n}`);
  const frac = (m[3] || '').replace(/0+$/, '');
  const scale = frac.length - Number(m[4] || 0);
  const digits = BigInt(m[2] + frac);
  return scale >= 0 ? { int: digits, scale } : { int: digits * 10n ** BigInt(-scale), scale: 0 };
}

// Fewest decimal places that exactly represent the value.
function decimalPlaces(n) {
  const { int, scale } = parseDecimal(n);
  let places = scale;
  let rest = int;
  while (places > 0 && rest % 10n === 0n) {
    rest /= 10n;
    places -= 1;
  }
  return places;
}

function minorExponent(currency) {
  const e = vectors.currency_minor_unit_exponent[currency];
  assert.notEqual(e, undefined, `vector currency ${currency} needs an exponent`);
  return e;
}

// Price precision: the greatest of the currency minor-unit exponent, 4 for
// per-unit models, and the decimals that exactly represent fixed_price and each
// row amount.
function pricePrecision(option) {
  const places = [minorExponent(option.currency), decimalPlaces(option.fixed_price)];
  if (PER_UNIT_MODELS.has(option.pricing_model)) places.push(4);
  for (const row of option.price_adjustments || []) {
    if (row.amount !== undefined) places.push(decimalPlaces(row.amount));
  }
  return Math.max(...places);
}

function toScaled(amount, precision) {
  const { int, scale } = parseDecimal(amount);
  assert.ok(scale <= precision, `${amount} needs more than ${precision} decimals`);
  return int * 10n ** BigInt(precision - scale);
}

function toNumber(scaled, precision) {
  return Number(scaled) / 10 ** precision;
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
  return winners;
}

// Each delta is computed from the base fixed_price, never from another row.
function rowDelta(row, baseScaled, precision) {
  if (row.amount !== undefined) return toScaled(row.amount, precision);
  const { int, scale } = parseDecimal(row.rate);
  return divRoundHalfAwayFromZero(baseScaled * int, 10n ** BigInt(scale));
}

function resolve(option, selection) {
  const precision = pricePrecision(option);
  const base = toScaled(option.fixed_price, precision);
  const rows = firingRows(option, selection);
  const deltas = rows.map(row => rowDelta(row, base, precision));
  const total = rows.reduce((sum, row, k) => sum + (row.kind === 'fee' ? deltas[k] : -deltas[k]), base);
  if (total < 0n) return null;
  return {
    rows,
    precision,
    fixed_price: toNumber(total, precision),
    amounts: deltas.map(delta => toNumber(delta, precision)),
  };
}

// The accepted snapshot records each fired row as its currency amount; a row
// whose delta rounds to zero contributes nothing and is omitted.
function resolvedSnapshot(option, result) {
  const snapshot = { ...option, fixed_price: result.fixed_price };
  const fired = result.rows.map((row, k) => ({ row, amount: result.amounts[k] })).filter(entry => entry.amount > 0);
  if (!fired.length) return snapshot;
  snapshot.base_fixed_price = option.fixed_price;
  const declared = option.price_breakdown;
  snapshot.price_breakdown = {
    list_price: declared ? declared.list_price : option.fixed_price,
    adjustments: [
      ...(declared ? declared.adjustments : []),
      ...fired.map(({ row, amount }) => ({ kind: row.kind, name: row.name, amount })),
    ],
  };
  return snapshot;
}

// The price-breakdown invariant: fold list_price through every adjustment.
function foldBreakdown(breakdown, precision) {
  let running = toScaled(breakdown.list_price, precision);
  for (const adjustment of breakdown.adjustments) {
    const sign = adjustment.kind === 'fee' ? 1n : -1n;
    if (adjustment.amount !== undefined) {
      running += sign * toScaled(adjustment.amount, precision);
    } else {
      const { int, scale } = parseDecimal(adjustment.rate);
      running += sign * divRoundHalfAwayFromZero(running * int, 10n ** BigInt(scale));
    }
  }
  return running;
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
    if (c.expect.adjustment_amounts) {
      assert.deepEqual(result.amounts, c.expect.adjustment_amounts, `${c.id}: fired-row amounts`);
    }

    const snapshot = resolvedSnapshot(option, result);
    assert.ok(validateCanonical(snapshot), `${c.id}: snapshot ${JSON.stringify(validateCanonical.errors)}`);
    if (snapshot.price_breakdown) {
      const folded = foldBreakdown(snapshot.price_breakdown, result.precision);
      assert.equal(toNumber(folded, result.precision), snapshot.fixed_price, `${c.id}: breakdown invariant`);
      assert.equal(snapshot.base_fixed_price, option.fixed_price, `${c.id}: base_fixed_price`);
    } else {
      assert.equal(snapshot.base_fixed_price, undefined, `${c.id}: no base_fixed_price when no row fired`);
    }
  }
});

test('cross-dimension order never changes the resolved price', () => {
  for (const c of vectors.resolution_cases) {
    const option = vectors.options[c.option];
    const reversed = { ...option, price_adjustments: [...(option.price_adjustments || [])].reverse() };
    const flipped = resolve(reversed, c.selection);
    // Reversing rows also reverses first-match precedence within a dimension, so
    // only compare when no dimension has more than one matching row.
    const selected = firingRows(option, c.selection).length;
    const matching = (option.price_adjustments || []).filter(row => selectedKeys(c.selection)[row.dimension].has(rowKey(row))).length;
    if (selected === matching) assert.equal(flipped.fixed_price, resolve(option, c.selection).fixed_price, c.id);
  }
});

test('precision is defined by numeric value, not lexical form', () => {
  assert.equal(decimalPlaces(JSON.parse('0.0100')), 2);
  assert.equal(decimalPlaces(JSON.parse('20.00')), 0);
  assert.equal(decimalPlaces(1e-7), 7);
  assert.equal(decimalPlaces(1.5e-7), 8);
  assert.equal(decimalPlaces(0.00125), 5);
  assert.equal(decimalPlaces(1000), 0);
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
      assert.deepEqual(result.amounts, c.resolved_adjustment_amounts, `${c.id}: resolved breakdown carried in error details`);
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
