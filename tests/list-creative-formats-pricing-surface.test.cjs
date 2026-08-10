const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const requestSchema = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      '../static/schemas/source/creative/list-creative-formats-request.json'
    ),
    'utf8'
  )
);

const formatSchema = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../static/schemas/source/core/format.json'),
    'utf8'
  )
);

test('list_creative_formats retains deprecated pricing compatibility through 3.x', () => {
  assert.equal(requestSchema.properties.include_pricing.deprecated, true);
  assert.equal(requestSchema.properties.account.deprecated, true);
  assert.match(requestSchema.properties.include_pricing.description, /Removed at 4\.0/);
  assert.match(requestSchema.properties.include_pricing.description, /list_transformers/);
  assert.match(JSON.stringify(requestSchema.allOf), /include_pricing/);
  assert.match(JSON.stringify(requestSchema.allOf), /account/);
  assert.equal(formatSchema.properties.pricing_options.deprecated, true);
});
