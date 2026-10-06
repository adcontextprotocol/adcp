const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/building/by-layer/L1/production-security-profile.mdx'), 'utf8');
const PROFILE_ID = 'adcp-prod-security-3.3';

async function loadSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

function capabilities(extra) {
  return {
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    ...extra,
  };
}

test('security_profiles is optional, an open string array, and rejects malformed ids', async () => {
  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  for (const extra of [{}, { security_profiles: [] }, { security_profiles: [PROFILE_ID] }, { security_profiles: [PROFILE_ID, 'adcp-prod-security-3.4'] }]) {
    assert.equal(validate(capabilities(extra)), true, JSON.stringify(validate.errors));
  }
  for (const bad of [PROFILE_ID, [PROFILE_ID, PROFILE_ID], [''], ['UPPER-case-id'], ['x'], [42], [null]]) {
    assert.equal(validate(capabilities({ security_profiles: bad })), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('the profile page names the registered id and the schema description agrees', async () => {
  const schema = await loadSchema('/schemas/protocol/get-adcp-capabilities-response.json');
  const description = schema.properties.security_profiles.description;
  assert.ok(description.includes(PROFILE_ID));
  assert.ok(DOC.includes(PROFILE_ID));
});

test('every spend-committing operation in the closed list has a request schema', () => {
  const section = DOC.split('## Spend-committing operations')[1].split('## Admission preconditions')[0];
  const ops = [...section.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual(ops, [
    'create_media_buy',
    'buy_products',
    'accept_proposal',
    'update_media_buy',
    'control_media_buy',
    'acquire_rights',
    'update_rights',
    'activate_signal',
  ]);
  const dirs = ['media-buy', 'brand', 'signals'].flatMap((dir) =>
    fs.readdirSync(path.join(SCHEMA_ROOT, dir)).map((f) => f)
  );
  for (const op of ops) {
    assert.ok(dirs.includes(`${op.replace(/_/g, '-')}-request.json`), `${op} has no request schema`);
  }
});

test('error codes the profile page cites exist in the published enums', () => {
  const errorCodes = JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'enums/error-code.json'), 'utf8')).enum;
  const signingCodes = JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'enums/request-signing-error-code.json'), 'utf8')).enum;
  const cited = [...DOC.matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]);
  const adcpCodes = cited.filter((c) => /^[A-Z][A-Z_]+$/.test(c) && c.includes('_'));
  const signing = cited.filter((c) => c.startsWith('request_signature_'));
  assert.ok(adcpCodes.length > 0 && signing.length > 0);
  for (const code of adcpCodes) assert.ok(errorCodes.includes(code), `${code} is not an AdCP error code`);
  for (const code of signing) assert.ok(signingCodes.includes(code), `${code} is not a request-signing error code`);
});
