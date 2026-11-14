const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const readSchema = (relativePath) => readBuiltSchema(`/schemas/${relativePath}`);

async function compile(options = {}) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => readSchema(uri.replace('/schemas/', '')),
    ...options,
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('governance/sync-plans-request.json'));
}

const errors = (validate) => JSON.stringify(validate.errors, null, 2);

const request = (planFields = {}) => ({
  idempotency_key: 'human-review-plan-1',
  plans: [{
    plan_id: 'human_review_campaign',
    brand: { domain: 'acme.example' },
    objectives: 'Reach a broad audience.',
    budget: { total: 1000, currency: 'USD', reallocation_threshold: 0 },
    flight: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    ...planFields,
  }],
});

// Every input the schema's two if/then branches recognise as requiring human
// review (docs/governance/campaign/specification.mdx#human-review-required).
const TRIGGERS = {
  'policy_categories fair_housing': { policy_categories: ['fair_housing'] },
  'policy_categories fair_lending': { policy_categories: ['fair_lending'] },
  'policy_categories fair_employment': { policy_categories: ['fair_employment'] },
  'policy_categories pharmaceutical_advertising': { policy_categories: ['pharmaceutical_advertising'] },
  'policy_ids eu_ai_act_annex_iii': { policy_ids: ['eu_ai_act_annex_iii'] },
};

const planItem = () => readSchema('governance/sync-plans-request.json').properties.plans.items;

for (const [name, trigger] of Object.entries(TRIGGERS)) {
  test(`a plan with ${name} that omits human_review_required validates`, async () => {
    const validate = await compile();
    assert.equal(validate(request(trigger)), true, errors(validate));
  });

  test(`a plan with ${name} and human_review_required true validates`, async () => {
    const validate = await compile();
    assert.equal(validate(request({ ...trigger, human_review_required: true })), true, errors(validate));
  });

  test(`a plan with ${name} and human_review_required false is rejected by const`, async () => {
    const validate = await compile();
    assert.equal(validate(request({ ...trigger, human_review_required: false })), false, name);
    assert.ok(
      validate.errors.some(
        (error) => error.keyword === 'const' && error.schemaPath.includes('/then/properties/human_review_required'),
      ),
      `${name}: ${errors(validate)}`,
    );
  });
}

test('a plan with no trigger validates with the flag omitted, false or true', async () => {
  const validate = await compile();
  assert.equal(validate(request()), true, errors(validate));
  assert.equal(validate(request({ human_review_required: false })), true, errors(validate));
  assert.equal(validate(request({ human_review_required: true })), true, errors(validate));
  assert.equal(
    validate(request({ policy_categories: ['children_directed'], human_review_required: false })),
    true,
    errors(validate),
  );
});

test('human_review_required carries no default and says an omitted flag is derived', () => {
  const field = planItem().properties.human_review_required;
  assert.equal(field.type, 'boolean');
  assert.equal('default' in field, false, 'an omitted flag is derived by the governance agent, not defaulted');
  assert.match(field.description, /When a plan omits this field, the governance agent derives it/);
  assert.match(field.description, /caller-supplied false is rejected/);
});

test('neither then branch requires the flag; both keep const true', () => {
  const branches = planItem().allOf.filter((branch) => branch.then?.properties?.human_review_required);
  assert.equal(branches.length, 2);
  for (const branch of branches) {
    assert.equal('required' in branch.then, false);
    assert.equal(branch.then.properties.human_review_required.const, true);
  }
});

// adcontextprotocol/adcp-client-python#1852: a consumer that applies schema
// defaults must not turn a valid omitted flag into a rejected explicit false.
test('a default-materializing consumer leaves an omitted flag omitted on a regulated plan', async () => {
  const fillDefaults = await compile({ useDefaults: true });
  for (const [name, trigger] of Object.entries(TRIGGERS)) {
    const instance = request(trigger);
    assert.equal(fillDefaults(instance), true, `${name}: ${errors(fillDefaults)}`);
    assert.equal('human_review_required' in instance.plans[0], false, name);
  }
});
