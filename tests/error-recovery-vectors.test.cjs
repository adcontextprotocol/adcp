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
const requestSigningErrorCodes = readJson(
  'static/schemas/source/enums/request-signing-error-code.json',
);
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
const securityGuide = fs.readFileSync(
  path.join(ROOT, 'docs/building/by-layer/L1/security.mdx'),
  'utf8',
);
const idempotencyStoryboard = fs.readFileSync(
  path.join(ROOT, 'static/compliance/source/universal/idempotency.yaml'),
  'utf8',
);
const controllerGuide = fs.readFileSync(
  path.join(ROOT, 'docs/building/by-layer/L3/comply-test-controller.mdx'),
  'utf8',
);

function is32(version) {
  return /^3\.2(?:$|[.-])/.test(version);
}

function knownRecovery(code) {
  return errorCodes.enumMetadata[code]?.recovery;
}

test('request-signing prose codes have one machine-readable recovery authority', () => {
  const documentedCodes = new Set(
    [...securityGuide.matchAll(/`(request_(?:signature|body|target)_[a-z_]+)`/g)]
      .map(match => match[1]),
  );
  const schemaCodes = new Set(requestSigningErrorCodes.enum);

  assert.deepEqual([...schemaCodes].sort(), [...documentedCodes].sort());
  for (const code of schemaCodes) {
    const description = requestSigningErrorCodes.enumDescriptions[code];
    const metadata = requestSigningErrorCodes.enumMetadata[code];
    assert.match(code, /^request_(?:signature|body|target)_[a-z_]+$/);
    assert.equal(typeof description, 'string');
    assert.ok(RECOVERY_VALUES.has(metadata?.recovery));
    assert.equal(typeof metadata?.suggestion, 'string');
    assert.equal(
      description.match(/Recovery:\s*(correctable|transient|terminal)\b/i)?.[1].toLowerCase(),
      metadata.recovery,
      `${code} prose and enumMetadata recovery must agree`,
    );
  }

  assert.equal(
    requestSigningErrorCodes.enumMetadata.request_signature_brand_json_malformed.recovery,
    'terminal',
  );
  assert.equal(
    requestSigningErrorCodes.enumMetadata.request_signature_jwks_unavailable.recovery,
    'transient',
  );
  assert.match(
    securityGuide,
    /machine-readable authority is \[`request-signing-error-code\.json`\]/,
  );
});

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

test('committed resource purge is terminal and cannot free the idempotency key', () => {
  assert.ok(errorCodes.enum.includes('COMMITTED_RESOURCE_PURGED'));
  assert.equal(errorCodes.enumMetadata.COMMITTED_RESOURCE_PURGED.recovery, 'terminal');
  assert.match(errorCodes.enumDescriptions.COMMITTED_RESOURCE_PURGED, /write stands/i);
  assert.match(errorCodes.enumDescriptions.COMMITTED_RESOURCE_PURGED, /exact replays MUST return this terminal outcome/i);
  assert.match(errorCodes.enumDescriptions.COMMITTED_RESOURCE_PURGED, /outside that requested mutation/i);
  assert.match(securityGuide, /Resource deletion does not end the replay window/);
  assert.match(securityGuide, /UNIQUE.*idempotency_key.*resource row alone does not satisfy/is);
  assert.match(securityGuide, /unknown outcome is not proof of failure/);
  assert.match(securityGuide, /MUST retain the durable claim/);
  assert.match(securityGuide, /Lease expiry changes the claim to reconciliation-required; it never releases or evicts the claim/);
  assert.doesNotMatch(securityGuide, /MUST release the row.*even if the downstream has not yet responded/);
  assert.match(securityGuide, /MUST NOT use `CONFLICT` for this case/);
  assert.match(idempotencyStoryboard, /scenario: force_media_buy_purge/);
  assert.match(idempotencyStoryboard, /check: field_present\s+path: "previous_state"/);
  assert.match(idempotencyStoryboard, /Replay after purge returns the historical success/);
  assert.ok(
    idempotencyStoryboard.indexOf('id: verify_media_buy_count')
      < idempotencyStoryboard.indexOf('id: replay_after_resource_purge'),
    'resource-count verification must run before the initial MediaBuy is purged',
  );
  assert.match(controllerGuide, /StateTransitionSuccess[^]*previous_state[^]*current_state: "purged"/);
});

test('in-flight recovery includes unresolved reconciliation without releasing the claim', () => {
  assert.match(errorCodes.enumDescriptions.IDEMPOTENCY_IN_FLIGHT, /unresolved outcome under fail-closed reconciliation/);
  assert.match(errorCodes.enumDescriptions.IDEMPOTENCY_IN_FLIGHT, /continue reconciliation/);
  assert.match(securityGuide, /only proven pre-commit failures release their claims/);
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
    'committed-resource-purged-is-never-retried',
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
