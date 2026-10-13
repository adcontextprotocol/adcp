// #8176: reporting_webhook and artifact_webhook may omit authentication (the switch selects the
// seller's webhook signing profile), and the descriptions carry the switch rule and the 3.3 gate.
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

test('reporting_webhook validates without authentication, and still accepts it', async () => {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  const validate = await ajv.compileAsync(await loadSchema('/schemas/core/reporting-webhook.json'));
  const base = { url: 'https://buyer.example/reports', reporting_frequency: 'daily' };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...base, authentication: { schemes: ['HMAC-SHA256'], credentials: 'x'.repeat(32) } }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(validate({ reporting_frequency: 'daily' }), false, 'url stays required');
});

test('authentication descriptions carry the switch rule and the 3.3 version gate', async () => {
  const reporting = await loadSchema('/schemas/core/reporting-webhook.json');
  const create = await loadSchema('/schemas/media-buy/create-media-buy-request.json');
  for (const [name, obj] of [['reporting_webhook', reporting], ['artifact_webhook', create.properties.artifact_webhook]]) {
    assert.ok(!obj.required.includes('authentication'), `${name}.authentication must not be required`);
    const d = obj.properties.authentication.description;
    assert.match(d, /Precedence is a switch, not a fallback/, name);
    assert.match(d, /webhook_mode_mismatch/, name);
    assert.match(d, /below 3\.3/, name);
    assert.match(d, /webhook_signing\.supported: true/, name);
    assert.match(d, /INVALID_REQUEST/, name);
  }
});
