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

const managedOffering = {
  ...coreOffering,
  offering_id: 'analytics-daily-managed',
  method: {
    pattern: 'file_transfer',
    transport: 's3',
    orchestration: 'consumer_managed',
    destination_modes: ['existing'],
    provider: { domain: 'amazonaws.com' },
    format: 'parquet',
  },
};

const reconciledOffering = {
  ...coreOffering,
  offering_id: 'analytics-daily-reconciled',
  reconciliation_mode: 'consumer_receipt',
  reporting_profile: {
    ...coreOffering.reporting_profile,
    canonicalization_id: 'adcp-reporting-v1',
    canonicalization_contract_version: '1.0',
    canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
    canonicalization_uri: 'https://sales.acme-outdoor.example/reporting/canonicalization/v1.json',
    canonicalization_sha256: 'c'.repeat(64),
  },
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
        issue_id: 'iss_report_overdue_20260827',
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
        issue_id: 'iss_production_failed_20260827',
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

  let validateObligation;
  let validateConfigState;
  let validateStatusChanged;

  before(async () => {
    [validateCapabilities, validateOffering, validateStatus, validateObligation, validateConfigState, validateStatusChanged] = await Promise.all([
      compile('/schemas/core/reporting-delivery-capabilities.json'),
      compile('/schemas/core/reporting-delivery-offering.json'),
      compile('/schemas/media-buy/get-reporting-status-response.json'),
      compile('/schemas/core/reporting-obligation.json'),
      compile('/schemas/core/reporting-delivery-config-state.json'),
      compile('/schemas/core/reporting-status-changed-webhook.json'),
    ]);
  });

  it('gives the managed-delivery pattern a domain-specific codegen name', () => {
    const offering = readSchema('/schemas/core/reporting-delivery-offering.json');
    assert.equal(offering.properties.method.properties.pattern.$ref, '#/definitions/ReportingDeliveryPattern');
    assert.equal(offering.definitions.ReportingDeliveryPattern.title, 'Reporting Delivery Pattern');
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
    }), false, 'reconciled_billing requires a reconciled offering');

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      offerings: [reconciledOffering],
      reconciled_billing: true,
      receipt_task: 'sync_reporting_receipts',
    }), true, JSON.stringify(validateCapabilities.errors));

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      offerings: [reconciledOffering],
    }), false, 'consumer_receipt offerings require reconciled_billing');

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      offerings: [managedOffering],
    }), false, 'managed offerings require managed_delivery');

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      offerings: [managedOffering],
      managed_delivery: true,
      resource_retention_days: 35,
      authorization_revocation_seconds: 300,
    }), true, JSON.stringify(validateCapabilities.errors));

    assert.equal(validateCapabilities({
      ...coreCapabilities,
      readiness_notification: 'reporting.delivery_ready',
    }), false, 'materialization readiness requires managed_delivery');
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

  it('accepts a healthy Core obligation with no destination, materialization, or receipt fields', () => {
    const coreObligation = {
      reporting_obligation_id: 'ob_core_20260827',
      delivery_config_id: 'analytics-daily',
      delivery_config_version: 1,
      report_definition_id: 'rd_analytics_daily_v1',
      feed_purpose: 'analytics',
      reporting_profile: 'media_buy_delivery_v1',
      account_id: 'acc_123',
      media_buy_ids: ['mb_123'],
      scope_resolved_at: '2026-08-27T00:00:00Z',
      coverage: {
        status: 'full',
        evaluated_at: '2026-08-27T00:00:00Z',
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
      },
      period: {
        start: '2026-08-26T00:00:00Z',
        end: '2026-08-27T00:00:00Z',
        source_timezone: 'UTC',
      },
      expected_at: '2026-08-27T04:00:00Z',
      schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      reconciliation_status: 'not_required',
      health: 'healthy',
      production_status: 'published',
      revision_count: 1,
      issues: [],
    };
    assert.equal(validateObligation(coreObligation), true, JSON.stringify(validateObligation.errors));

    const obligationRules = readSchema('/schemas/core/reporting-obligation.json')['x-adcp-validation'];
    assert.match(obligationRules.obligation_availability, /independently of source availability/);
    assert.match(obligationRules.obligation_availability, /before committing any revision/);
    assert.match(obligationRules.obligation_availability, /taking any get_reporting_status ledger snapshot/);
    assert.match(obligationRules.obligation_availability, /periods view whose selected denominator includes that configuration generation and period/);
    assert.match(obligationRules.obligation_availability, /MUST NOT expose an obligation.*at or before period\.end/);
    assert.match(obligationRules.obligation_availability, /Media-buy acceptance alone does not create an obligation/);
    assert.match(obligationRules.obligation_availability, /MUST NOT be prerequisites for obligation creation/);
    assert.match(obligationRules.complete_finality, /For Core/);
    assert.match(obligationRules.complete_finality, /Managed-delivery additionally requires/);
    assert.match(obligationRules.record_counts, /revision records for this obligation/);

    // A managed obligation claiming healthy without successful materializations is invalid.
    assert.equal(validateObligation({
      ...coreObligation,
      destination_ref: 'dest_01K4C6T6Q0A9E6Y3N1FQ1T8YKV',
    }), false, 'managed healthy requires materialization evidence');
  });

  it('reaches configuration ready without any destination for a Core offering', () => {
    assert.equal(validateConfigState({
      configuration: {
        delivery_config_id: 'analytics-daily',
        delivery_config_version: 1,
        offering_id: 'analytics-daily-core',
        active: true,
        feed_purpose: 'analytics',
        report_definition_id: 'rd_analytics_daily_v1',
        reporting_profile: 'media_buy_delivery_v1',
        scope: { all_media_buys: true },
        coverage_requirement: 'full',
        required_finality: 'official',
        reconciliation_mode: 'delivery_only',
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
      },
      state: 'ready',
      validated_at: '2026-08-25T00:00:00Z',
      activated_at: '2026-08-25T00:00:00Z',
      current_coverage: {
        status: 'full',
        evaluated_at: '2026-08-25T00:00:00Z',
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
      },
    }), true, JSON.stringify(validateConfigState.errors));
  });

  it('announces clock-driven unhealth through the tier-independent status_changed doorbell', () => {
    assert.equal(validateStatusChanged({
      idempotency_key: '3d1b9a70-52f4-4b28-a1c9-8f4f2f6d0c11',
      notification_id: 'rst_ob_01K4E2Q0_delayed',
      notification_type: 'reporting.status_changed',
      fired_at: '2026-08-27T05:00:02Z',
      subscriber_id: 'reporting-health',
      account_id: 'acc_123',
      delivery_config_id: 'analytics-daily',
      delivery_config_version: 1,
      feed_purpose: 'analytics',
      reporting_obligation_id: 'ob_core_20260827',
      health: 'delayed',
      previous_health: 'waiting',
      issue_ids: ['iss_report_overdue_20260827'],
    }), true, JSON.stringify(validateStatusChanged.errors));
    assert.doesNotMatch(JSON.stringify(readSchema('/schemas/core/reporting-status-changed-webhook.json').required), /destination|materialization|receipt/);
  });

  it('needs no destination, manifest, canonicalization, digest, receipt, or push knowledge', () => {
    assert.doesNotMatch(coreSeller.toString(), FORBIDDEN_KNOWLEDGE,
      'the Core seller implementation must not reference any managed-delivery or billing concept');
    assert.doesNotMatch(JSON.stringify(coreCapabilities), FORBIDDEN_KNOWLEDGE);
    assert.doesNotMatch(JSON.stringify(coreOffering), FORBIDDEN_KNOWLEDGE);
  });
});
