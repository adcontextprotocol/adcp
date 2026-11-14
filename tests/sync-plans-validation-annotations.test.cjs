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
  idempotency_key: 'validation-annotations-plan-1',
  plans: [{
    plan_id: 'validation_annotations_campaign',
    brand: { domain: 'acme.example' },
    objectives: 'Reach a broad audience.',
    budget: { total: 1000, currency: 'USD', reallocation_threshold: 0 },
    flight: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    ...planFields,
  }],
});

const CUSTOM_POLICY = { policy_id: 'us_coppa', enforcement: 'must', policy: 'Do not target children under 13.' };
const SPEC = 'docs/governance/campaign/tasks/sync_plans.mdx#error-codes';

const planProperties = () => readSchema('governance/sync-plans-request.json').properties.plans.items.properties;

// The three rules are prose plus x-adcp-validation in 3.x. A governance agent
// rejects these plans with INVALID_REQUEST; the schema does not.
test('the schema still accepts the plans the three annotated rules reject', async () => {
  const validate = await compile();
  assert.equal(
    validate(request({ flight: { start: '2026-11-01T00:00:00Z', end: '2026-10-01T00:00:00Z' } })),
    true,
    errors(validate),
  );
  assert.equal(validate(request({ policy_ids: ['us_coppa', 'us_coppa'] })), true, errors(validate));
  assert.equal(
    validate(request({ policy_ids: ['us_coppa'], custom_policies: [CUSTOM_POLICY] })),
    true,
    errors(validate),
  );
});

test('flight carries the ordering rule and flight.end states it', () => {
  const { flight } = planProperties();
  assert.deepEqual(flight['x-adcp-validation'], {
    verifier_constraints: { flight_order: { end: 'later_than_start', on_violation: 'INVALID_REQUEST' } },
    spec: SPEC,
  });
  assert.match(flight.properties.end.description, /MUST be later than `start`/);
});

test('policy_ids carries the uniqueness rule as an annotation, not as uniqueItems', () => {
  const { policy_ids: policyIds } = planProperties();
  assert.deepEqual(policyIds['x-adcp-validation'], {
    verifier_constraints: { unique_policy_ids: { policy_ids: 'unique', on_violation: 'INVALID_REQUEST' } },
    spec: SPEC,
  });
  assert.equal('uniqueItems' in policyIds, false);
  assert.match(policyIds.description, /Each ID MUST appear at most once/);
});

test('custom_policies carries the registry-id collision rule', () => {
  const { custom_policies: customPolicies } = planProperties();
  assert.deepEqual(customPolicies['x-adcp-validation'], {
    verifier_constraints: { registry_id_collision: { policy_id: 'not_in_policy_ids', on_violation: 'INVALID_REQUEST' } },
    spec: SPEC,
  });
  assert.match(customPolicies.description, /A policy_id MUST NOT equal an ID in policy_ids/);
});
