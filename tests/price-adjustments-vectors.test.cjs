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

const PER_UNIT_MODELS = new Set(['cpm', 'vcpm', 'cpc', 'cpcv', 'cpv', 'cpp']);

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

// round half away from zero of running x proportion, where the proportion is
// the exact decimal num/10^scale.
function proportionOf(running, proportion) {
  const { int, scale } = parseDecimal(proportion);
  return divRoundHalfAwayFromZero(running * int, 10n ** BigInt(scale));
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

function rowMatches(row, selected) {
  return row.dimension === 'always' || selected[row.dimension].has(rowKey(row));
}

function inWindow(row, at) {
  if (row.valid_from === undefined && row.valid_until === undefined) return true;
  assert.ok(at !== undefined, `row ${row.name} has a window but the case has no flight`);
  return (
    (row.valid_from === undefined || at >= Date.parse(row.valid_from)) &&
    (row.valid_until === undefined || at < Date.parse(row.valid_until))
  );
}

// A flight [start, end) that crosses a window boundary of a row that would
// otherwise apply is rejected; the buyer splits it.
function crossesBoundary(option, selection) {
  if (!selection.flight) return false;
  const start = Date.parse(selection.flight.start_time);
  const end = Date.parse(selection.flight.end_time);
  const selected = selectedKeys(selection);
  return (option.price_adjustments || []).some(row => {
    if (!rowMatches(row, selected)) return false;
    return [row.valid_from, row.valid_until].some(edge => {
      if (edge === undefined) return false;
      const t = Date.parse(edge);
      return t > start && t < end;
    });
  });
}

// Declared order; first valid matching row per selection dimension, every valid
// always row.
function firingRows(option, selection) {
  const at = selection.flight ? Date.parse(selection.flight.start_time) : undefined;
  const selected = selectedKeys(selection);
  const fired = new Set();
  const winners = [];
  for (const row of option.price_adjustments || []) {
    if (!inWindow(row, at) || !rowMatches(row, selected)) continue;
    if (row.dimension !== 'always') {
      if (fired.has(row.dimension)) continue;
      fired.add(row.dimension);
    }
    winners.push(row);
  }
  return winners;
}

function resolve(option, selection) {
  if (crossesBoundary(option, selection)) return { error: 'flight_spans_validity_boundary' };
  const precision = pricePrecision(option);
  const base = toScaled(option.fixed_price, precision);
  const rows = firingRows(option, selection);
  const entries = [];

  // Indices compound in declared order; each step applies its delta.
  let indexed = base;
  for (const row of rows.filter(r => r.kind === 'index')) {
    if (parseDecimal(row.factor).int === 10n ** BigInt(parseDecimal(row.factor).scale)) continue; // factor 1
    const up = Number(row.factor) > 1;
    const { int, scale } = parseDecimal(row.factor);
    const proportionNum = (up ? int - 10n ** BigInt(scale) : 10n ** BigInt(scale) - int);
    const delta = divRoundHalfAwayFromZero(indexed * proportionNum, 10n ** BigInt(scale));
    indexed += up ? delta : -delta;
    entries.push({ kind: up ? 'fee' : 'discount', name: row.name, rate: toNumber(proportionNum, scale) });
  }

  // Premiums are computed from the indexed price; fixed amounts are not indexed.
  let total = indexed;
  for (const row of rows.filter(r => r.kind !== 'index')) {
    const delta = row.amount !== undefined ? toScaled(row.amount, precision) : proportionOf(indexed, row.rate);
    total += row.kind === 'fee' ? delta : -delta;
    if (delta > 0n) entries.push({ kind: row.kind, name: row.name, amount: toNumber(delta, precision) });
  }
  if (total < 0n) return { error: 'below_zero' };
  return { rows, entries, precision, fixed_price: toNumber(total, precision) };
}

// The accepted snapshot records each fired row as its own price_breakdown entry
// after the declared adjustments.
function resolvedSnapshot(option, result) {
  const snapshot = { ...option, fixed_price: result.fixed_price };
  if (!result.entries.length) return snapshot;
  snapshot.base_fixed_price = option.fixed_price;
  const declared = option.price_breakdown;
  snapshot.price_breakdown = {
    list_price: declared ? declared.list_price : option.fixed_price,
    adjustments: [...(declared ? declared.adjustments : []), ...result.entries],
  };
  return snapshot;
}

// The price-breakdown invariant: fold list_price through every adjustment.
function foldBreakdown(breakdown, precision) {
  let running = toScaled(breakdown.list_price, precision);
  for (const adjustment of breakdown.adjustments) {
    const sign = adjustment.kind === 'fee' ? 1n : -1n;
    running +=
      sign *
      (adjustment.amount !== undefined ? toScaled(adjustment.amount, precision) : proportionOf(running, adjustment.rate));
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
    assert.equal(result.error, undefined, `${c.id}: ${result.error}`);
    assert.equal(result.fixed_price, c.expect.fixed_price, `${c.id}: fixed_price`);
    assert.deepEqual(
      result.rows.map(row => row.name),
      c.expect.applied,
      `${c.id}: applied rows`,
    );
    const amounts = result.entries.filter(entry => entry.amount !== undefined).map(entry => entry.amount);
    if (c.expect.adjustment_amounts) assert.deepEqual(amounts, c.expect.adjustment_amounts, `${c.id}: fired-row amounts`);
    if (c.expect.breakdown) assert.deepEqual(result.entries, c.expect.breakdown, `${c.id}: price_breakdown rows`);

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

test('premium-only tables: cross-dimension order never changes the resolved price', () => {
  for (const c of vectors.resolution_cases) {
    const option = vectors.options[c.option];
    if ((option.price_adjustments || []).some(row => row.kind === 'index' || row.valid_from)) continue;
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

test('purchases with no valid resolution are rejected, never clamped', () => {
  for (const c of vectors.invalid_resolution_cases) {
    assert.equal(resolve(vectors.options[c.option], c.selection).error, c.expect_error, c.id);
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
      assert.deepEqual(result.entries.map(entry => entry.amount), c.resolved_adjustment_amounts, `${c.id}: resolved breakdown carried in error details`);
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
