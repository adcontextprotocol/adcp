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

const request = (planFields = {}) => ({
  idempotency_key: 'human-override-plan-1',
  plans: [{
    plan_id: 'human_override_campaign',
    brand: { domain: 'acme.example' },
    objectives: 'Reach a broad audience.',
    budget: { total: 1000, currency: 'USD', reallocation_threshold: 0 },
    flight: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    ...planFields,
  }],
});

const planItem = () => readSchema('governance/sync-plans-request.json').properties.plans.items;

// The artifact a buyer sends to lower human_review_required from true to false
// on a re-sync (docs/governance/annex-iii-obligations.mdx: "reason + approver").
test('the plan item declares human_override as an optional object requiring reason and approver', () => {
  const plan = planItem();
  const field = plan.properties.human_override;
  assert.ok(field, 'plans[].human_override is declared');
  assert.equal(field.type, 'object');
  assert.equal(field['x-added-in'], '3.3.0');
  assert.deepEqual(field.required, ['reason', 'approver']);
  assert.deepEqual(Object.keys(field.properties), ['reason', 'approver', 'approved_at']);
  assert.equal(field.additionalProperties, true);
  assert.equal(plan.required.includes('human_override'), false);
  assert.match(field.description, /plan_hash preimage/);
});

test('a plan with a human_override carrying reason and approver validates', async () => {
  const validate = await compile();
  const human_override = { reason: 'Compliance review closed the Annex III finding.', approver: 'compliance@acme.example' };
  assert.equal(validate(request({ human_review_required: false, human_override })), true, errors(validate));
  assert.equal(
    validate(request({ human_review_required: false, human_override: { ...human_override, approved_at: '2026-10-01T09:00:00Z' } })),
    true,
    errors(validate),
  );
});

test('a plan without human_override still validates', async () => {
  const validate = await compile();
  assert.equal(validate(request()), true, errors(validate));
});

test('a human_override missing approver is rejected', async () => {
  const validate = await compile();
  assert.equal(validate(request({ human_override: { reason: 'Compliance review closed the finding.' } })), false);
  assert.ok(
    validate.errors.some(
      (error) => error.keyword === 'required'
        && error.params.missingProperty === 'approver'
        && error.instancePath === '/plans/0/human_override',
    ),
    errors(validate),
  );
});

test('a human_override missing reason is rejected', async () => {
  const validate = await compile();
  assert.equal(validate(request({ human_override: { approver: 'compliance@acme.example' } })), false);
  assert.ok(
    validate.errors.some(
      (error) => error.keyword === 'required'
        && error.params.missingProperty === 'reason'
        && error.instancePath === '/plans/0/human_override',
    ),
    errors(validate),
  );
});
