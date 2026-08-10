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

test('list_creative_formats does not advertise the retired pricing surface', () => {
  assert.equal(requestSchema.properties.include_pricing, undefined);
  assert.equal(requestSchema.properties.account, undefined);
  assert.doesNotMatch(JSON.stringify(requestSchema.allOf), /include_pricing|account/);
});
