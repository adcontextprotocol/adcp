const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'static/schemas/source');

function schema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));
}

const base = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'Downstream ad server timed out',
  recovery: 'transient',
};

test('core error accepts documented and unrecognized mutation_outcome values', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema('core/error.json'));

  assert.equal(validate(base), true, 'field is optional');
  for (const value of ['not_applied', 'unknown', 'applied', 'x_future_value']) {
    assert.equal(
      validate({ ...base, mutation_outcome: value }),
      true,
      `${value}: ${JSON.stringify(validate.errors)}`
    );
  }
});

test('core error rejects a non-string or empty mutation_outcome', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema('core/error.json'));

  assert.equal(validate({ ...base, mutation_outcome: '' }), false);
  assert.equal(validate({ ...base, mutation_outcome: true }), false);
  assert.equal(validate({ ...base, mutation_outcome: { state: 'unknown' } }), false);
});

test('mutation_outcome stays independent of code and recovery', () => {
  const error = schema('core/error.json');
  assert.equal(error.required.includes('mutation_outcome'), false);
  assert.equal(error.dependencies?.mutation_outcome, undefined);
  assert.equal(error.properties.recovery.enum.includes('reconcile'), false);
});

test('COMMITTED_RESOURCE_PURGED guidance agrees with mutation_outcome', () => {
  const vocabulary = schema('enums/error-code.json');
  const description = vocabulary.enumDescriptions.COMMITTED_RESOURCE_PURGED;
  assert.match(description, /mutation_outcome to applied/);
  assert.match(description, /MUST NOT set not_applied/);
});

// Reference buyer decision for a failed state-changing request. Mirrors the
// obligations in error-handling.mdx#mutation-outcome so the prose stays testable.
function buyerDecision(error) {
  const outcome = error.mutation_outcome;
  const known = ['not_applied', 'unknown', 'applied'];
  const effective = outcome === undefined ? 'absent' : known.includes(outcome) ? outcome : 'unknown';
  const uncertain = effective === 'unknown' || effective === 'applied';
  return {
    effective,
    may_report_failed: !uncertain && effective !== 'absent',
    may_new_key_or_changed_payload: effective === 'not_applied' || (effective === 'absent' && error.recovery !== 'transient'),
    same_key_resend_allowed: error.recovery === 'transient' && effective !== 'applied',
    read_state_first: uncertain || (effective === 'absent' && error.recovery === 'transient'),
  };
}

test('buyer decision vectors', () => {
  const t = { code: 'SERVICE_UNAVAILABLE', message: 'x', recovery: 'transient' };
  const cases = [
    [{ ...t, mutation_outcome: 'not_applied' }, 'not_applied', true, true, true, false],
    [{ ...t, mutation_outcome: 'unknown' }, 'unknown', false, false, true, true],
    [{ ...t, mutation_outcome: 'x_future_value' }, 'unknown', false, false, true, true],
    [{ ...t, mutation_outcome: '' }, 'unknown', false, false, true, true],
    [{ ...t, mutation_outcome: 'applied' }, 'applied', false, false, false, true],
    [t, 'absent', false, false, true, true],
  ];
  for (const [error, effective, report, replan, resend, read] of cases) {
    assert.deepEqual(
      buyerDecision(error),
      {
        effective,
        may_report_failed: report,
        may_new_key_or_changed_payload: replan,
        same_key_resend_allowed: resend,
        read_state_first: read,
      },
      JSON.stringify(error)
    );
  }
});

test('REFERENCE_DEFINITION_CHANGED is documented as a pre-commit rejection', () => {
  const description = schema('enums/error-code.json').enumDescriptions.REFERENCE_DEFINITION_CHANGED;
  assert.match(description, /mutation_outcome to not_applied/);
});

test('normative docs define pre-commit evidence and the async no-re-plan rule', () => {
  const errorHandling = fs.readFileSync(
    path.join(ROOT, 'docs/building/by-layer/L3/error-handling.mdx'),
    'utf8'
  );
  const security = fs.readFileSync(path.join(ROOT, 'docs/building/by-layer/L1/security.mdx'), 'utf8');

  assert.match(errorHandling, /### Mutation outcome/);
  assert.match(errorHandling, /in-flight database write/);
  assert.match(errorHandling, /whole request envelope/);
  assert.match(errorHandling, /async task that ends in `failed`/);
  assert.match(errorHandling, /MUST NOT emit `unknown` or `applied` unless the claim is fenced/);
  assert.match(errorHandling, /SHOULD in 3\.3 and becomes a MUST in 3\.4/);
  assert.match(errorHandling, /REFERENCE_DEFINITION_CHANGED/);
  assert.match(security, /mutation_outcome/);
  assert.match(security, /async task that ends in `failed`/);
});
