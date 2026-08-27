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
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const revision = {
  reporting_revision_id: 'rrv_20260827_a',
  delivery_config_id: 'daily-share',
  report_definition_id: 'rdef_daily_delivery_v1',
  feed_purpose: 'analytics',
  reporting_profile: 'media_buy_delivery_v1',
  schema_version: '1.0',
  account_id: 'acc_123',
  media_buy_ids: ['mb_123'],
  period: {
    start: '2026-08-26T00:00:00Z',
    end: '2026-08-27T00:00:00Z',
    source_timezone: 'UTC',
  },
  finality: 'snapshot',
  observed_at: '2026-08-27T04:00:00Z',
  data_through: '2026-08-27T00:00:00Z',
  data_through_precision: 'exact',
  row_count: 0,
  canonical_content_digest: {
    algorithm: 'sha256',
    value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    canonicalization_id: 'adcp-reporting-rows-v1',
  },
  created_at: '2026-08-27T04:00:01Z',
};

const materialization = {
  reporting_materialization_id: 'rmat_20260827_a_1',
  reporting_revision_id: revision.reporting_revision_id,
  delivery_config_id: 'daily-share',
  method: 'dataset_share',
  transport: 'delta_sharing',
  attempt: 1,
  status: 'available',
  ready_at: '2026-08-27T04:00:16Z',
  resource: {
    resource_ref: 'rptres_20260827_a',
    kind: 'dataset',
    location: 'share.daily_reporting',
    native_version_ref: 'delta-table-version:1',
    reader_compatibility: ['delta-sharing-open-client-v1'],
  },
  verification: {
    verified_at: '2026-08-27T04:00:16Z',
    verification_path: 'representative_consumer',
    row_count: 0,
    canonical_content_digest: revision.canonical_content_digest,
  },
  created_at: '2026-08-27T04:00:02Z',
};

const officialRevision = {
  ...revision,
  reporting_revision_id: 'rrv_20260827_b',
  finality: 'official',
  observed_at: '2026-08-28T04:00:00Z',
  supersedes_reporting_revision_id: revision.reporting_revision_id,
  row_count: 2,
  canonical_content_digest: {
    algorithm: 'sha256',
    value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    canonicalization_id: 'adcp-reporting-rows-v1',
  },
  created_at: '2026-08-28T04:00:01Z',
};

const officialMaterialization = {
  reporting_materialization_id: 'rmat_20260827_b_1',
  reporting_revision_id: officialRevision.reporting_revision_id,
  delivery_config_id: 'daily-share',
  method: 'dataset_share',
  transport: 'delta_sharing',
  attempt: 1,
  status: 'available',
  ready_at: '2026-08-28T04:00:16Z',
  resource: {
    resource_ref: 'rptres_20260827_b',
    kind: 'dataset',
    location: 'share.daily_reporting',
    native_version_ref: 'delta-table-version:2',
  },
  verification: {
    verified_at: '2026-08-28T04:00:16Z',
    verification_path: 'representative_consumer',
    row_count: 2,
    canonical_content_digest: officialRevision.canonical_content_digest,
  },
  created_at: '2026-08-28T04:00:02Z',
};

describe('managed reporting status contract', () => {
  let validateConfig;
  let validateRequest;
  let validateResponse;
  let validateWebhook;
  let validateNotificationConfig;
  let validateCapabilities;
  let validateSyncAccounts;
  let validateConfigState;

  before(async () => {
    [validateConfig, validateRequest, validateResponse, validateWebhook, validateNotificationConfig, validateCapabilities, validateSyncAccounts, validateConfigState] = await Promise.all([
      compile('/schemas/core/reporting-delivery-config.json'),
      compile('/schemas/media-buy/get-reporting-status-request.json'),
      compile('/schemas/media-buy/get-reporting-status-response.json'),
      compile('/schemas/core/reporting-delivery-ready-webhook.json'),
      compile('/schemas/core/notification-config.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
      compile('/schemas/account/sync-accounts-request.json'),
      compile('/schemas/core/reporting-delivery-config-state.json'),
    ]);
  });

  it('supports file transfer, dataset share, and warehouse materialization without vendor enums', () => {
    for (const method of [
      { pattern: 'file_transfer', transport: 's3', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_s3' }, format: 'parquet' },
      { pattern: 'dataset_share', transport: 'snowflake_secure_sharing', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_sf' } },
      { pattern: 'warehouse_materialization', transport: 'gam_bigquery_transfer', orchestration: 'consumer_managed', destination: { mode: 'existing', destination_ref: 'dest_bq' } },
    ]) {
      assert.equal(validateConfig({
        delivery_config_id: `cfg-${method.pattern}`,
        active: true,
        feed_purpose: 'analytics',
        reporting_profile: 'media_buy_delivery_v1',
        scope: { all_media_buys: true },
        required_finality: 'official',
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
        method,
      }), true, JSON.stringify(validateConfig.errors));
    }
  });

  it('configures caller-owned desired state through sync_accounts', () => {
    assert.equal(validateSyncAccounts({
      idempotency_key: 'sync-reporting-config-0001',
      accounts: [{
        account: { account_id: 'acc_123' },
        reporting_delivery_configs: [{
          delivery_config_id: 'daily-share',
          active: true,
          feed_purpose: 'analytics',
          reporting_profile: 'media_buy_delivery_v1',
          scope: { all_media_buys: true },
          required_finality: 'official',
          schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
          method: {
            pattern: 'dataset_share',
            transport: 'delta_sharing',
            orchestration: 'producer_managed',
            destination: {
              mode: 'provision',
              provider: { domain: 'data-cloud.example' },
              access_mode: 'databricks_to_databricks',
              recipient: { cloud: 'aws', region: 'us-east-1', identity: 'recipient-sharing-id' },
            },
          },
        }],
        notification_configs: [{
          subscriber_id: 'reporting-ingest',
          url: 'https://buyer.example/webhooks/reporting',
          event_types: ['reporting.delivery_ready'],
          active: true,
        }],
      }],
    }), true, JSON.stringify(validateSyncAccounts.errors));

    const field = readSchema('/schemas/account/sync-accounts-request.json')
      .properties.accounts.items.properties.reporting_delivery_configs;
    assert.match(field.description, /authenticated caller, resolved account/);
    assert.match(field.description, /another caller's entries MUST NOT be read, replaced, or deleted/);
  });

  it('models pacing, analytics, and billing as independent scheduled feeds', () => {
    const base = {
      active: true,
      reporting_profile: 'media_buy_delivery_v1',
      scope: { all_media_buys: true },
      method: {
        pattern: 'dataset_share',
        transport: 'delta_sharing',
        orchestration: 'producer_managed',
        destination: { mode: 'existing', destination_ref: 'dest_shared_reporting' },
      },
    };
    for (const configuration of [
      { ...base, delivery_config_id: 'pacing-15m', feed_purpose: 'pacing', required_finality: 'snapshot', schedule: { period_duration: 'PT15M', alignment: 'utc', delivery_sla: 'PT5M' } },
      { ...base, delivery_config_id: 'analytics-daily', feed_purpose: 'analytics', required_finality: 'official', schedule: { period_duration: 'P1D', alignment: 'account_timezone', delivery_sla: 'PT4H' } },
      { ...base, delivery_config_id: 'billing-cycle', feed_purpose: 'billing', required_finality: 'official', schedule: { period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' } },
    ]) assert.equal(validateConfig(configuration), true, JSON.stringify(validateConfig.errors));

    assert.equal(validateConfig({
      ...base,
      delivery_config_id: 'invalid-billing-snapshot',
      feed_purpose: 'billing',
      required_finality: 'snapshot',
      schedule: { period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' },
    }), false);
  });

  it('returns seller-resolved destination setup without accepting credential material', () => {
    const configuration = {
      delivery_config_id: 'daily-share',
      active: true,
      feed_purpose: 'analytics',
      reporting_profile: 'media_buy_delivery_v1',
      scope: { all_media_buys: true },
      required_finality: 'official',
      schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
      method: {
        pattern: 'dataset_share',
        transport: 'delta_sharing',
        orchestration: 'producer_managed',
        destination: {
          mode: 'provision',
          provider: { domain: 'data-cloud.example' },
          access_mode: 'open_sharing',
          recipient: { identity: 'reporting-team@buyer.example' },
        },
      },
    };
    assert.equal(validateConfigState({
      configuration,
      state: 'pending_setup',
      destination_ref: 'dest_share_123',
      setup: {
        action: 'activate_recipient',
        message: 'Sign in to the data platform to activate this recipient.',
        url: 'https://seller.example/setup/reporting/dest_share_123',
      },
    }), true, JSON.stringify(validateConfigState.errors));

    configuration.method.destination.recipient.token = 'not-allowed';
    assert.equal(validateConfig(configuration), false);
  });

  it('requires an explicit view and confines exact revision lookup to revision view', () => {
    assert.equal(validateRequest({ account: { account_id: 'acc_123' } }), false);
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'summary' }), true, JSON.stringify(validateRequest.errors));
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'revision' }), false);
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'revision', reporting_revision_id: revision.reporting_revision_id }), true, JSON.stringify(validateRequest.errors));
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'revision', reporting_revision_id: revision.reporting_revision_id, pagination: { max_results: 10 } }), false);
  });

  it('returns auditable summary scope and does not allow complete on an open scope', () => {
    const response = {
      status: 'completed',
      view: 'summary',
      ledger_snapshot_id: 'ledger_20260828_001',
      ledger_as_of: '2026-08-28T12:00:00Z',
      account_id: 'acc_123',
      scope: {
        period_start: '2026-08-01T00:00:00Z',
        period_end: '2026-08-28T00:00:00Z',
        scope_closed: false,
        all_accessible_media_buys: true,
      },
      health: 'healthy',
      data_through: '2026-08-27T00:00:00Z',
      next_expected_at: '2026-08-28T04:00:00Z',
      obligation_counts: { total: 27, waiting: 1, healthy: 26, delayed: 0, action_required: 0, complete: 0 },
      issues: [],
    };
    assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
    response.health = 'complete';
    assert.equal(validateResponse(response), false);
  });

  it('retains a zero-row revision and consumer-verified native resource evidence', () => {
    assert.equal(validateResponse({
      status: 'completed',
      view: 'revision',
      ledger_snapshot_id: 'ledger_20260828_002',
      ledger_as_of: '2026-08-28T12:00:00Z',
      account_id: 'acc_123',
      revision,
      materializations: [materialization],
    }), true, JSON.stringify(validateResponse.errors));
  });

  it('returns every retained restatement in the paginated obligation ledger', () => {
    const response = {
      status: 'completed',
      view: 'periods',
      ledger_snapshot_id: 'ledger_20260829_001',
      ledger_as_of: '2026-08-29T12:00:00Z',
      account_id: 'acc_123',
      scope: {
        period_start: '2026-08-26T00:00:00Z',
        period_end: '2026-08-27T00:00:00Z',
        scope_closed: true,
        all_accessible_media_buys: false,
        media_buy_ids: ['mb_123'],
        finality: ['snapshot', 'official'],
      },
      periods: [{
        reporting_obligation_id: 'robl_20260826_daily',
        delivery_config_id: 'daily-share',
        report_definition_id: revision.report_definition_id,
        feed_purpose: revision.feed_purpose,
        reporting_profile: revision.reporting_profile,
        account_id: 'acc_123',
        media_buy_ids: ['mb_123'],
        period: revision.period,
        expected_at: '2026-08-27T04:00:00Z',
        required_finality: 'official',
        health: 'complete',
        production_status: 'published',
        revisions: [revision, officialRevision],
        materializations: [materialization, officialMaterialization],
        issues: [],
      }],
      pagination: { has_more: false, total_count: 1 },
    };
    assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
    delete response.pagination.total_count;
    assert.equal(validateResponse(response), false);
    response.pagination.total_count = 1;
    delete response.ledger_snapshot_id;
    assert.equal(validateResponse(response), false);
  });

  it('uses readiness as a secret-free account doorbell repaired through status', () => {
    assert.equal(validateNotificationConfig({
      subscriber_id: 'reporting-ingest',
      url: 'https://buyer.example/webhooks/reporting',
      event_types: ['reporting.delivery_ready'],
      active: true,
    }), true, JSON.stringify(validateNotificationConfig.errors));

    const webhook = {
      idempotency_key: 'whk_20260827_reporting_0001',
      notification_id: 'ready_rmat_20260827_a_1',
      notification_type: 'reporting.delivery_ready',
      fired_at: '2026-08-27T04:00:17Z',
      subscriber_id: 'reporting-ingest',
      account_id: 'acc_123',
      delivery_config_id: 'daily-share',
      reporting_revision_id: revision.reporting_revision_id,
      reporting_materialization_id: materialization.reporting_materialization_id,
      readiness: 'available',
      finality: 'snapshot',
      data_through: '2026-08-27T00:00:00Z',
    };
    assert.equal(validateWebhook(webhook), true, JSON.stringify(validateWebhook.errors));
    assert.equal(validateWebhook({ ...webhook, access_token: 'secret' }), false);
  });

  it('requires the experimental feature declaration when managed reporting is advertised', () => {
    const capabilities = {
      status: 'completed',
      adcp: {
        supported_versions: ['3.2'],
        major_versions: [3],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      supported_protocols: ['media_buy'],
      media_buy: {
        reporting_delivery: {
          supported: true,
          configuration_task: 'sync_accounts',
          status_task: 'get_reporting_status',
          readiness_notification: 'reporting.delivery_ready',
          methods: [{
            pattern: 'dataset_share',
            transports: ['delta_sharing'],
            orchestration: ['producer_managed'],
            destination_modes: ['provision', 'existing'],
            providers: [{ domain: 'data-cloud.example' }],
            access_modes: ['databricks_to_databricks', 'open_sharing'],
          }],
          reporting_profiles: ['media_buy_delivery_v1'],
          feed_purposes: ['pacing', 'analytics', 'billing'],
          schedules: [
            { period_duration: 'PT15M', alignment: 'utc', delivery_sla: 'PT5M' },
            { period_duration: 'P1D', alignment: 'account_timezone', delivery_sla: 'PT4H' },
          ],
          supported_finality: ['snapshot', 'official'],
          automated_recovery_window_seconds: 3600,
          status_retention_days: 30,
        },
      },
      experimental_features: ['media_buy.reporting_delivery'],
    };
    assert.equal(validateCapabilities(capabilities), true, JSON.stringify(validateCapabilities.errors));
    capabilities.experimental_features = [];
    assert.equal(validateCapabilities(capabilities), false);
  });
});
