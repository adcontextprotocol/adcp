const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

function readSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const scope = {
  uses: ['paid_amplification', 'content_reuse'],
  start_date: '2026-11-01',
  end_date: '2027-01-31',
  exclusivity: { scope: 'competing_beverage_brands', countries: ['US'] },
};

test('purchase rights reference the shared rights scope and carry the experimental markers', () => {
  const rights = readSchema('/schemas/media-buy/product-purchase.json').properties.rights;
  assert.equal(rights.items.$ref, '/schemas/brand/rights-scope.json');
  assert.equal(rights['x-status'], 'experimental');
  assert.equal(rights['x-added-in'], '3.3.0');
  assert.match(rights.description, /media_buy\.purchase_rights/);
  const rightsScope = readSchema('/schemas/brand/rights-scope.json');
  assert.equal(rightsScope['x-added-in'], '3.3.0');
  assert.equal(rightsScope.properties.uses.minItems, 1);
});

test('rights-terms composes rights-scope and keeps its pricing requirements', async () => {
  const terms = readSchema('/schemas/brand/rights-terms.json');
  assert.equal(terms.allOf[0].$ref, '/schemas/brand/rights-scope.json');
  const validate = await compile('/schemas/brand/rights-terms.json');
  const priced = { pricing_option_id: 'po_1', amount: 100, currency: 'USD', uses: ['likeness'], impression_cap: 10 };
  assert.equal(validate(priced), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...priced, ...scope }), true, JSON.stringify(validate.errors));
  for (const field of ['pricing_option_id', 'amount', 'currency', 'uses']) {
    const { [field]: _omitted, ...rest } = priced;
    assert.equal(validate(rest), false, `${field} stays required`);
  }
  assert.equal(validate({ ...priced, uses: ['not_a_use'] }), false);
  assert.equal(validate({ ...priced, uses: [] }), false);
});

test('product purchase accepts rights without rights pricing and validates the scope', async () => {
  const validate = await compile('/schemas/media-buy/product-purchase.json');
  const purchase = { product_id: 'creator_series', pricing_option_id: 'flat_usd' };
  assert.equal(validate(purchase), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...purchase, rights: [scope] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...purchase, rights: [] }), false);
  assert.equal(validate({ ...purchase, rights: [{ ...scope, uses: [] }] }), false);
  assert.equal(validate({ ...purchase, rights: [{ ...scope, uses: ['not_a_use'] }] }), false);
  assert.equal(validate({ ...purchase, rights: [{ ...scope, end_date: 'soon' }] }), false);
  assert.equal(validate({ ...purchase, rights: [{ start_date: '2026-11-01' }] }), false);
});

test('commercial terms carry purchase rights, so the terms digest binds them', async () => {
  const commercial = readSchema('/schemas/media-buy/commercial-terms.json');
  assert.equal(commercial.properties.purchases.items.allOf[0].$ref, '/schemas/media-buy/product-purchase.json');
  const validate = await compile('/schemas/media-buy/commercial-terms.json');
  const purchases = (rights) => ({
    purchases: [{
      product_id: 'creator_series',
      pricing_option_id: 'flat_usd',
      pricing: { pricing_option_id: 'flat_usd', pricing_model: 'flat_rate', currency: 'USD', fixed_price: 5000 },
      start_time: '2026-11-01T00:00:00Z',
      end_time: '2027-01-31T23:59:59Z',
      ...(rights ? { rights } : {}),
    }],
  });
  const rightsErrors = (rights) => {
    validate(purchases(rights));
    return (validate.errors || []).filter((error) => error.instancePath.includes('/rights'));
  };
  assert.deepEqual(rightsErrors([scope]), []);
  assert.ok(rightsErrors([{ uses: [] }]).length > 0);
});

test('buy_products purchase input does not accept rights', async () => {
  const validate = await compile('/schemas/media-buy/product-purchase-input.json');
  const purchase = { product_id: 'creator_series', pricing_option_id: 'flat_usd' };
  assert.equal(validate(purchase), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...purchase, rights: [scope] }), false);
});

test('right-use distinguishes creator-handle amplification from brand-handle reuse', () => {
  const rightUse = readSchema('/schemas/enums/right-use.json');
  for (const value of ['paid_amplification', 'content_reuse']) {
    assert.ok(rightUse.enum.includes(value));
    assert.ok(rightUse.enumDescriptions[value]);
  }
});
