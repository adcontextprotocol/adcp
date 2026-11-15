const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const readSchema = (relativePath) => readBuiltSchema(`/schemas/${relativePath}`);

async function compile() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => readSchema(uri.replace('/schemas/', '')),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('governance/sync-plans-request.json'));
}

const errors = (validate) => JSON.stringify(validate.errors, null, 2);

// Names reserved for the governance agent's persisted plan state and excluded
// from the plan_hash preimage (docs/governance/campaign/specification.mdx).
const RESERVED = {
  version: 3,
  status: 'active',
  syncedAt: '2026-04-19T12:00:00Z',
  revisionHistory: [],
  committedBudget: 100,
  committedByType: {},
};

const request = (planFields = {}) => ({
  idempotency_key: 'reserved-names-plan-1',
  plans: [{
    plan_id: 'reserved_names_campaign',
    brand: { domain: 'acme.example' },
    objectives: 'Reach a broad audience.',
    budget: { total: 1000, currency: 'USD', reallocation_threshold: 0 },
    flight: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    ...planFields,
  }],
});

test('a plan without reserved names validates, and an unknown key on it validates', async () => {
  const validate = await compile();
  assert.equal(validate(request()), true, errors(validate));
  // Open by default (WG decision of 2026-11-09, DR-0036): an unknown key validates.
  assert.equal(validate(request({ buyer_note: 'x' })), true, errors(validate));
});

for (const [name, value] of Object.entries(RESERVED)) {
  test(`a plan that sends the reserved name ${name} is rejected by the plan's not keyword`, async () => {
    const validate = await compile();
    assert.equal(validate(request({ [name]: value })), false, name);
    assert.ok(
      validate.errors.some((error) => error.keyword === 'not' && error.schemaPath.includes('/plans/items/not')),
      `${name}: ${errors(validate)}`,
    );
  });
}

test('the plan item description names every reserved name and forbids sending them', () => {
  const { description } = readSchema('governance/sync-plans-request.json').properties.plans.items;
  for (const name of Object.keys(RESERVED)) assert.ok(description.includes(`\`${name}\``), name);
  assert.match(description, /MUST NOT send them/);
});
