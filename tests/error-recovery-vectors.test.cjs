const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const ROOT = path.resolve(__dirname, '..');
const RECOVERY_VALUES = new Set(['transient', 'correctable', 'terminal']);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

const errorSchema = readJson('static/schemas/source/core/error.json');
const errorCodes = readJson('static/schemas/source/enums/error-code.json');
const fixture = readJson('static/compliance/source/test-vectors/error-recovery/vectors.json');
const validateError = new Ajv({ allErrors: true, strict: false }).compile(errorSchema);
const errorGuide = fs.readFileSync(
  path.join(ROOT, 'docs/building/by-layer/L3/error-handling.mdx'),
  'utf8',
);
const releaseNotes = fs.readFileSync(path.join(ROOT, 'docs/reference/release-notes.mdx'), 'utf8');
const complianceStoryboards = [
  'static/compliance/source/universal/error-compliance.yaml',
  'static/compliance/source/universal/error-compliance-signals.yaml',
].map(relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));

function is32(version) {
  return /^3\.2(?:$|[.-])/.test(version);
}

function knownRecovery(code) {
  return errorCodes.enumMetadata[code]?.recovery;
}

function effectiveRecovery(error) {
  if (error.recovery !== undefined) {
    return RECOVERY_VALUES.has(error.recovery) ? error.recovery : 'terminal';
  }
  return knownRecovery(error.code) ?? 'transient';
}

function producerConformant(vector, schemaValid) {
  const { error } = vector;
  if (!schemaValid || (is32(vector.negotiated_protocol_version) && error.recovery === undefined)) {
    return false;
  }

  if (error.buyer_reason) {
    const topLevel = knownRecovery(error.code);
    const buyerReason = knownRecovery(error.buyer_reason.code);
    if (buyerReason && buyerReason !== error.recovery) {
      return false;
    }
    if (topLevel && buyerReason && topLevel !== buyerReason) {
      return false;
    }
  }

  return true;
}

function evaluate(vector) {
  const { error, retry_state: retryState } = vector;
  const schemaValid = validateError(error);
  const recovery = effectiveRecovery(error);
  const retryBudgetAvailable = retryState.retries_attempted < retryState.max_retries;

  let action;
  if (recovery === 'correctable') action = 'correct_request';
  else if (recovery === 'terminal') action = 'escalate';
  else if (!retryBudgetAvailable) action = 'stop_retrying';
  else action = 'retry';

  const automaticRetry = action === 'retry';
  let schedule = null;
  if (automaticRetry && Number.isFinite(error.retry_after)) {
    schedule = {
      kind: 'retry_after',
      minimum_delay_seconds: Math.min(3600, Math.max(1, Math.ceil(error.retry_after))),
    };
  } else if (automaticRetry) {
    schedule = { kind: 'bounded_exponential_backoff' };
  }

  return {
    schema_valid: schemaValid,
    producer_conformant: producerConformant(vector, schemaValid),
    code_known: Boolean(knownRecovery(error.code)),
    effective_recovery: recovery,
    action,
    automatic_retry: automaticRetry,
    schedule,
    retry_budget: {
      consumed: automaticRetry,
      next_retries_attempted: retryState.retries_attempted + (automaticRetry ? 1 : 0),
    },
  };
}

test('shared 3.x schema keeps recovery optional while documenting the version gate', () => {
  assert.deepEqual(errorSchema.required, ['code', 'message']);
  assert.match(errorSchema.properties.recovery.description, /3\.2 producers MUST populate/i);
  assert.match(errorSchema.properties.recovery.description, /3\.1 producers SHOULD populate/i);
  assert.match(errorSchema.properties.recovery.description, /shared 3\.x schema intentionally does not add/i);
});

test('field table, normative guide, and release notes publish the same version gate', () => {
  assert.match(errorGuide, /\| `recovery` \| string \| 3\.2: Yes; ≤3\.1: No \|/);
  assert.match(errorGuide, /3\.2 producers \*\*MUST\*\* populate `error\.recovery` on every error/);
  assert.match(errorGuide, /3\.1 producers \*\*SHOULD\*\* populate it/);
  assert.match(releaseNotes, /3\.2 producers populate `error\.recovery` on every error/);
  assert.match(releaseNotes, /error-recovery reference vectors/);
});

test('current 3.2 error-compliance storyboards require the canonical recovery vocabulary', () => {
  for (const storyboard of complianceStoryboards) {
    assert.match(storyboard, /recovery: transient, correctable, or terminal \(required for a 3\.2 producer\)/);
    assert.doesNotMatch(storyboard, /recovery:.*\b(?:fatal|optional)\b/);
  }
});

test('error recovery reference vectors match the normative consumer decision table', () => {
  assert.equal(fixture.contract_version, '3.2');
  assert.ok(fixture.vectors.length >= 10);

  for (const vector of fixture.vectors) {
    assert.deepEqual(evaluate(vector), vector.expected, vector.id);
  }
});

test('vectors cover compatibility and scheduling boundaries required for 3.2 adoption', () => {
  const ids = new Set(fixture.vectors.map(vector => vector.id));
  for (const id of [
    'known-code-with-recovery',
    'known-code-without-recovery-legacy',
    'unknown-code-with-recovery',
    'unknown-code-without-recovery-legacy',
    'missing-recovery-is-3-2-producer-violation-not-decoding-failure',
    'legacy-fractional-retry-after-rounds-up',
    'correctable-delay-does-not-authorize-retry',
    'terminal-delay-does-not-authorize-retry',
    'unknown-legacy-fallback-stops-at-budget',
    'buyer-reason-classifications-agree',
    'buyer-reason-classification-conflict',
    'known-buyer-reason-must-match-with-unknown-top-level-code',
    'buyer-reason-requires-recovery',
    'unknown-recovery-value-fails-closed',
  ]) {
    assert.ok(ids.has(id), `missing vector ${id}`);
  }
});
