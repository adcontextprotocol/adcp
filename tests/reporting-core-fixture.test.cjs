const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

// The reporting.core tier boundary, stated as code: everything a
// polling-only seller needs is expressible without any of these words.
const FORBIDDEN_KNOWLEDGE = /destination|manifest|canonical|digest|receipt|readiness|webhook/i;

// A complete Core offering: API-delivered (no method), no canonicalization.
const coreOffering = {
  offering_id: 'analytics-daily-core',
  feed_purpose: 'analytics',
  report_definition_id: 'rd_analytics_daily_v1',
  report_definition_uri: 'https://sales.acme-outdoor.example/reporting/definitions/rd_analytics_daily_v1.json',
  report_definition_sha256: 'a'.repeat(64),
  reporting_profile: {
    id: 'media_buy_delivery_v1',
    version: '1.0',
    schema_uri: 'https://sales.acme-outdoor.example/reporting/profiles/media_buy_delivery_v1.json',
    schema_sha256: 'b'.repeat(64),
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    schema_ref_policy: 'local_fragment_only',
    grain: 'one row per media buy per day',
    primary_keys: ['media_buy_id', 'date'],
  },
  schedule: {
    period_duration: 'P1D',
    alignment: 'utc',
    delivery_sla: 'PT4H',
  },
  supported_finality: ['official'],
  reconciliation_mode: 'delivery_only',
};

// The complete Core capability block: no receipt task, no push
// notification, no managed-delivery retention or revocation machinery.
const coreCapabilities = {
  supported: true,
  configuration_task: 'sync_accounts',
  status_task: 'get_reporting_status',
  offerings: [coreOffering],
  automated_recovery_window_seconds: 21600,
  status_retention_days: 35,
};

// A minimal in-memory polling-only seller. Its entire reporting surface is
// an obligation ledger plus get_reporting_status projections; delivery
// happens over the transports the seller already had.
function coreSeller() {
  const scope = {
    period_start: '2026-08-01T00:00:00Z',
    period_end: '2026-08-28T00:00:00Z',
    scope_closed: false,
    all_accessible_media_buys: true,
    delivery_config_generations: [
      { delivery_config_id: 'analytics-daily', delivery_config_version: 1, feed_purpose: 'analytics' },
    ],
    feed_purposes: ['analytics'],
    finality: ['official'],
    ledger_retained_from: '2026-07-29T00:00:00Z',
    coverage_complete: true,
  };
  const coverage = {
    status: 'full',
    evaluated_at: '2026-08-28T00:00:00Z',
    media_buy_ids: ['mb_123'],
    fully_covered_media_buy_ids: ['mb_123'],
    partially_covered_media_buy_ids: [],
    unsupported_media_buy_ids: [],
    unknown_media_buy_ids: [],
    package_ids: ['pkg_123'],
    covered_package_ids: ['pkg_123'],
    unsupported_package_ids: [],
    unknown_package_ids: [],
    limitations: [],
  };
  const base = counts => ({
    status: 'completed',
    view: 'summary',
    ledger_snapshot_id: 'ledger_20260828_001',
    ledger_as_of: '2026-08-28T12:00:00Z',
    account_id: 'acc_123',
    scope: { ...scope },
    coverage,
    data_through: '2026-08-26T00:00:00Z',
    obligation_counts: { total: 27, waiting: 0, healthy: 0, delayed: 0, action_required: 0, complete: 0, ...counts },
    issues: [],
  });

  return {
    healthy() {
      return { ...base({ healthy: 27 }), health: 'healthy', next_expected_at: '2026-08-28T04:00:00Z' };
    },
    waiting() {
      return { ...base({ waiting: 27 }), health: 'waiting', next_expected_at: '2026-08-28T04:00:00Z' };
    },
    delayed() {
      const r = { ...base({ healthy: 26, delayed: 1 }), health: 'delayed', next_expected_at: '2026-08-28T04:00:00Z' };
      r.issues = [{
        code: 'REPORT_OVERDUE',
        severity: 'delayed',
        responsible_party: 'seller',
        recommended_action: 'wait_for_retry',
        media_buy_ids: ['mb_123'],
        period_start: '2026-08-26T00:00:00Z',
        period_end: '2026-08-27T00:00:00Z',
        expected_at: '2026-08-27T04:00:00Z',
      }];
      return r;
    },
    actionRequired() {
      const r = { ...base({ healthy: 26, action_required: 1 }), health: 'action_required', next_expected_at: '2026-08-28T04:00:00Z' };
      r.issues = [{
        code: 'PRODUCTION_FAILED',
        severity: 'action_required',
        responsible_party: 'seller',
        recommended_action: 'contact_seller',
        media_buy_ids: ['mb_123'],
        period_start: '2026-08-26T00:00:00Z',
        period_end: '2026-08-27T00:00:00Z',
      }];
      return r;
    },
    complete() {
      const r = { ...base({ complete: 27 }), health: 'complete' };
      r.scope = { ...scope, scope_closed: true, coverage_complete: true };
      return r;
    },
  };
}

describe('reporting.core fixture: a polling-only seller implements Core', () => {
  let validateCapabilities;
  let validateOffering;
  let validateStatus;

  before(async () => {
    [validateCapabilities, validateOffering, validateStatus] = await Promise.all([
      compile('/schemas/core/reporting-delivery-capabilities.json'),
      compile('/schemas/core/reporting-delivery-offering.json'),
      compile('/schemas/media-buy/get-reporting-status-response.json'),
    ]);
  });

  it('accepts a Core capability block with no receipt, push, or managed-delivery fields', () => {
    assert.equal(validateCapabilities(coreCapabilities), true, JSON.stringify(validateCapabilities.errors));

    for (const forbidden of ['receipt_task', 'readiness_notification', 'managed_delivery', 'reconciled_billing', 'resource_retention_days', 'authorization_revocation_seconds']) {
      assert.equal(forbidden in coreCapabilities, false, `${forbidden} must not be needed for Core`);
    }
  });

  it('rejects tier flags without their tier machinery', () => {
    assert.equal(validateCapabilities({
      ...coreCapabilities,
      managed_delivery: true,
    }), false, 'managed_delivery requires retention and revocation bounds');

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      reconciled_billing: true,
    }), false, 'reconciled_billing requires receipt_task');

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      reconciled_billing: true,
      receipt_task: 'sync_reporting_receipts',
    }), true, JSON.stringify(validateCapabilities.errors));
  });

  it('accepts an API-delivered Core offering with no method and no canonicalization contract', () => {
    assert.equal(validateOffering(coreOffering), true, JSON.stringify(validateOffering.errors));
    assert.equal('method' in coreOffering, false);
    for (const key of Object.keys(coreOffering.reporting_profile)) {
      assert.doesNotMatch(key, /^canonicalization/, `Core profile carries no ${key}`);
    }
  });

  it('serves schema-valid summary responses for all five health states', () => {
    const seller = coreSeller();
    for (const [state, build] of [
      ['healthy', seller.healthy],
      ['waiting', seller.waiting],
      ['delayed', seller.delayed],
      ['action_required', seller.actionRequired],
      ['complete', seller.complete],
    ]) {
      const response = build();
      assert.equal(response.health, state);
      assert.equal(validateStatus(response), true, `${state}: ${JSON.stringify(validateStatus.errors)}`);
    }
  });

  it('needs no destination, manifest, canonicalization, digest, receipt, or push knowledge', () => {
    assert.doesNotMatch(coreSeller.toString(), FORBIDDEN_KNOWLEDGE,
      'the Core seller implementation must not reference any managed-delivery or billing concept');
    assert.doesNotMatch(JSON.stringify(coreCapabilities), FORBIDDEN_KNOWLEDGE);
    assert.doesNotMatch(JSON.stringify(coreOffering), FORBIDDEN_KNOWLEDGE);
  });
});
