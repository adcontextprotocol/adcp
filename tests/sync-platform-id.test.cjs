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

for (const [task, collection, identity] of [
  ['sync-event-sources', 'event_sources', 'event_source_id'],
  ['sync-audiences', 'audiences', 'audience_id'],
]) {
  const schema = readSchema(`/schemas/media-buy/${task}-response.json`);
  const item = schema.oneOf[0].properties[collection].items;

  test(`${task} preserves legacy, canonical, dual-field, and unidentified results`, async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
    addFormats(ajv);
    const validate = await ajv.compileAsync(schema);
    for (const identifiers of [
      { seller_id: 'platform_object_123' },
      { platform_id: 'platform_object_123' },
      { platform_id: 'platform_object_123', seller_id: 'platform_object_123' },
      {},
    ]) {
      const body = {
        status: 'completed',
        [collection]: [{ [identity]: 'buyer_object_123', action: 'unchanged', ...identifiers }],
      };
      assert.equal(validate(body), true, JSON.stringify(validate.errors));
    }
  });

  test(`${task} validates both identifier fields as strings`, async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
    addFormats(ajv);
    const validate = await ajv.compileAsync(schema);
    for (const field of ['platform_id', 'seller_id']) {
      for (const value of [123, null, {}, []]) {
        assert.equal(validate({
          status: 'completed',
          [collection]: [{ [identity]: 'buyer_object_123', action: 'unchanged', [field]: value }],
        }), false, `${field}: ${JSON.stringify(value)}`);
      }
    }
  });

  test(`${task} deprecates only the old alias without changing required fields`, () => {
    assert.equal(item.properties.seller_id.deprecated, true);
    assert.notEqual(item.properties.platform_id.deprecated, true);
    assert.deepEqual(item.required, [identity, 'action']);
  });
}
