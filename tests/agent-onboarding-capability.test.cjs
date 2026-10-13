// account.agent_onboarding (experimental): shape, experimental gating, and closed modes / billing keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static/schemas/source');

async function loadSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema('/schemas/protocol/get-adcp-capabilities-response.json'));
}

const base = {
  status: 'completed',
  adcp: { major_versions: [3], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
};

const posture = {
  sandbox: { mode: 'open', url: 'https://streamhaus.example/sandbox' },
  billing: {
    operator: { mode: 'open', requirements: [{ kind: 'grant' }] },
    agent: { mode: 'application', requirements: [{ kind: 'billing_entity' }, { kind: 'contract' }] },
  },
  url: 'https://streamhaus.example/partners/buyer-agents',
  message: 'Sandbox is open to any verified buying agent.',
};

test('a declared posture validates when the experimental feature is listed', async () => {
  const validate = await compile();
  const ok = validate({
    ...base,
    account: { supported_billing: ['operator', 'agent'], sandbox: true, agent_onboarding: posture },
    experimental_features: ['account.agent_onboarding'],
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('declaring agent_onboarding requires account.agent_onboarding in experimental_features', async () => {
  const validate = await compile();
  assert.equal(validate({ ...base, account: { supported_billing: ['operator', 'agent'], sandbox: true, agent_onboarding: posture } }), false);
  assert.equal(validate({ ...base, account: { supported_billing: ['operator', 'agent'], sandbox: true, agent_onboarding: posture }, experimental_features: ['account.agent_onboarding'] }), true, JSON.stringify(validate.errors));
});

test('modes and billing keys are closed; requirement kinds use the registered enum', async () => {
  const validate = await compile();
  const withFeature = (agent_onboarding) => ({ ...base, account: { supported_billing: ['operator', 'agent', 'advertiser'], sandbox: true, agent_onboarding }, experimental_features: ['account.agent_onboarding'] });
  assert.equal(validate(withFeature({ sandbox: { mode: 'maybe' } })), false);
  assert.equal(validate(withFeature({ billing: { reseller: { mode: 'open' } } })), false);
  assert.equal(validate(withFeature({ billing: { operator: { mode: 'open', requirements: [{ kind: 'not_a_kind' }] } } })), false);
  assert.equal(validate(withFeature({ billing: { advertiser: { mode: 'invite_only' } } })), true, JSON.stringify(validate.errors));
});

test('every requirement kind states its direction', async () => {
  const kinds = await loadSchema('/schemas/enums/agent-onboarding-requirement-kind.json');
  assert.equal(kinds['x-extensible'], true);
  for (const kind of kinds.enum) {
    assert.match(kinds.enumDescriptions[kind], /^(Seller gating a buyer|Buyer gating a seller)\./, `${kind} has no direction`);
  }
});
