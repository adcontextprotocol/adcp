// #8176: reporting_webhook and artifact_webhook may omit authentication. These tests check the
// wire shape with ajv; the rules for an absent block live in the descriptions and security.mdx.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static/schemas/source');
async function loadSchema(uri) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const HMAC = { schemes: ['HMAC-SHA256'], credentials: 'x'.repeat(32) };

test('reporting_webhook accepts an instance without authentication and rejects one without url', async () => {
  const validate = await compile(await loadSchema('/schemas/core/reporting-webhook.json'));
  const base = { url: 'https://buyer.example/reports', reporting_frequency: 'daily' };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, authentication: HMAC }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ reporting_frequency: 'daily' }), false, 'url stays required');
});

test('artifact_webhook accepts {url, delivery_mode} without authentication and rejects one without url', async () => {
  const create = await loadSchema('/schemas/media-buy/create-media-buy-request.json');
  const validate = await compile({
    ...create.properties.artifact_webhook,
    $id: '/schemas/test/artifact-webhook.json',
  });
  const base = { url: 'https://buyer.example/artifacts', delivery_mode: 'realtime' };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, authentication: HMAC }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ delivery_mode: 'realtime' }), false, 'url stays required');
});
