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

function assertSelfContainedReportingSchema(schema) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const seen = new Set();
  const visit = (value, depth = 0) => {
    assert.ok(depth <= 64, 'reporting schema exceeds maximum depth');
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    assert.ok(seen.size <= 10000, 'reporting schema exceeds maximum node count');
    if (typeof value.$ref === 'string') assert.match(value.$ref, /^#/);
    assert.equal(Object.hasOwn(value, '$dynamicRef'), false);
    assert.equal(Object.hasOwn(value, '$recursiveRef'), false);
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(schema);
}

const revision = {
  reporting_revision_id: 'rrv_20260827_a',
  report_definition_id: 'rdef_daily_delivery_v1',
  reporting_profile: 'media_buy_delivery_v1',
  schema_version: '1.0',
  schema_uri: 'https://schemas.example/media-buy-delivery/v1.json',
  schema_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
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
  control_totals: [
    { name: 'impressions', value: '0', value_type: 'integer', unit: 'impressions' },
    { name: 'spend', value: '0.00', value_type: 'decimal', unit: 'USD' },
  ],
  canonical_content_digest: {
    algorithm: 'sha256',
    value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    canonicalization_id: 'adcp-reporting-rows-v1',
    canonicalization_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  },
  created_at: '2026-08-27T04:00:01Z',
};

const materialization = {
  reporting_materialization_id: 'rmat_20260827_a_1',
  reporting_revision_id: revision.reporting_revision_id,
  reporting_obligation_id: 'robl_20260826_daily',
  delivery_config_id: 'daily-share',
  delivery_config_version: 1,
  destination_ref: 'dest_shared_reporting',
  feed_purpose: 'analytics',
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
    immutability: 'native_version',
    expires_at: '2026-09-27T04:00:16Z',
    reader_compatibility: ['delta-sharing-open-client-v1'],
  },
  verification: {
    verified_at: '2026-08-27T04:00:16Z',
    verification_path: 'representative_consumer',
    verification_profile: 'canonical_digest',
    row_count: 0,
    control_totals: revision.control_totals,
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
  control_totals: [
    { name: 'impressions', value: '4200', value_type: 'integer', unit: 'impressions' },
    { name: 'spend', value: '7000.00', value_type: 'decimal', unit: 'USD' },
  ],
  canonical_content_digest: {
    algorithm: 'sha256',
    value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    canonicalization_id: 'adcp-reporting-rows-v1',
    canonicalization_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  },
  created_at: '2026-08-28T04:00:01Z',
};

const officialMaterialization = {
  reporting_materialization_id: 'rmat_20260827_b_1',
  reporting_revision_id: officialRevision.reporting_revision_id,
  reporting_obligation_id: 'robl_20260826_daily',
  delivery_config_id: 'daily-share',
  delivery_config_version: 1,
  destination_ref: 'dest_shared_reporting',
  feed_purpose: 'analytics',
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
    immutability: 'native_version',
    expires_at: '2026-09-28T04:00:16Z',
  },
  verification: {
    verified_at: '2026-08-28T04:00:16Z',
    verification_path: 'representative_consumer',
    verification_profile: 'canonical_digest',
    row_count: 2,
    control_totals: officialRevision.control_totals,
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
  let validateObligation;
  let validateMaterialization;
  let validateVerification;
  let validateSchedule;
  let validateRevision;
  let validateManifest;
  let validateResource;
  let validateReceiptRequest;
  let validateReceiptResponse;

  before(async () => {
    [validateConfig, validateRequest, validateResponse, validateWebhook, validateNotificationConfig, validateCapabilities, validateSyncAccounts, validateConfigState, validateObligation, validateMaterialization, validateVerification, validateSchedule, validateRevision, validateManifest, validateResource, validateReceiptRequest, validateReceiptResponse] = await Promise.all([
      compile('/schemas/core/reporting-delivery-config.json'),
      compile('/schemas/media-buy/get-reporting-status-request.json'),
      compile('/schemas/media-buy/get-reporting-status-response.json'),
      compile('/schemas/core/reporting-delivery-ready-webhook.json'),
      compile('/schemas/core/notification-config.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
      compile('/schemas/account/sync-accounts-request.json'),
      compile('/schemas/core/reporting-delivery-config-state.json'),
      compile('/schemas/core/reporting-obligation.json'),
      compile('/schemas/core/reporting-materialization.json'),
      compile('/schemas/core/reporting-verification.json'),
      compile('/schemas/core/reporting-schedule.json'),
      compile('/schemas/core/reporting-revision.json'),
      compile('/schemas/core/reporting-file-manifest.json'),
      compile('/schemas/core/reporting-resource.json'),
      compile('/schemas/media-buy/sync-reporting-receipts-request.json'),
      compile('/schemas/media-buy/sync-reporting-receipts-response.json'),
    ]);
  });

  it('keeps canonical revisions destination-independent for multi-destination fan-out', () => {
    assert.equal(validateRevision(revision), true, JSON.stringify(validateRevision.errors));
    assert.equal(validateRevision({ ...revision, destination_ref: 'dest_should_not_be_here' }), false);

    for (const [suffix, destinationRef] of [['s3', 'dest_s3'], ['bq', 'dest_bq'], ['dbx', 'dest_databricks']]) {
      const attempt = structuredClone(materialization);
      attempt.reporting_materialization_id = `rmat_fanout_${suffix}`;
      attempt.reporting_obligation_id = `robl_fanout_${suffix}`;
      attempt.delivery_config_id = `cfg-${suffix}`;
      attempt.destination_ref = destinationRef;
      assert.equal(validateMaterialization(attempt), true, JSON.stringify(validateMaterialization.errors));
      assert.equal(attempt.reporting_revision_id, revision.reporting_revision_id);
    }
  });

  it('defines a manifest-last file commit with checksums, counts, and control totals', () => {
    const manifest = {
      manifest_version: '1.0',
      complete: true,
      reporting_revision_id: revision.reporting_revision_id,
      reporting_obligation_id: 'robl_s3_daily',
      reporting_materialization_id: 'rmat_s3_daily_1',
      period: revision.period,
      format: 'parquet',
      compression: 'snappy',
      files: [{
        object_ref: '2026/08/26/part-000.parquet',
        size_bytes: 128,
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        row_count: 0,
        partition: { report_date: '2026-08-26' },
      }],
      total_size_bytes: 128,
      row_count: 0,
      control_totals: revision.control_totals,
      created_at: '2026-08-27T04:00:02Z',
    };
    assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
    delete manifest.files[0].sha256;
    assert.equal(validateManifest(manifest), false);

    const resource = {
      resource_ref: 'resource-manifest-20260827',
      kind: 'manifest',
      location: 'reports/2026-08-27/manifest.json',
      immutability: 'immutable_location',
      expires_at: '2026-09-28T04:00:16Z',
    };
    assert.equal(validateResource(resource), false);
    resource.manifest_version = '1.0';
    resource.manifest_sha256 = 'd'.repeat(64);
    assert.equal(validateResource(resource), true, JSON.stringify(validateResource.errors));
  });

  it('records an authenticated consumer receipt instead of treating availability as agreement', () => {
    const receipt = {
      reporting_receipt_id: 'receipt-buyer-20260827-0001',
      reporting_obligation_id: materialization.reporting_obligation_id,
      reporting_revision_id: revision.reporting_revision_id,
      reporting_materialization_id: materialization.reporting_materialization_id,
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: revision.row_count,
      observed_control_totals: revision.control_totals,
      observed_canonical_content_digest: revision.canonical_content_digest,
      consumer_commit_ref: 'buyer-ledger:20260827:42',
      observed_at: '2026-08-27T04:01:00Z',
    };
    assert.equal(validateReceiptRequest({
      account: { account_id: 'acc_123' },
      idempotency_key: 'receipt-batch-20260827-0001',
      receipts: [receipt],
    }), true, JSON.stringify(validateReceiptRequest.errors));
    assert.equal(validateReceiptResponse({
      status: 'completed',
      results: [{ result: 'recorded', receipt: { ...receipt, received_at: '2026-08-27T04:01:01Z' } }],
    }), true, JSON.stringify(validateReceiptResponse.errors));

    delete receipt.observed_canonical_content_digest;
    assert.equal(validateReceiptRequest({
      account: { account_id: 'acc_123' },
      idempotency_key: 'receipt-batch-20260827-0002',
      receipts: [receipt],
    }), false);
  });

  it('supports file transfer, dataset share, and warehouse materialization without vendor enums', () => {
    for (const method of [
      { pattern: 'file_transfer', transport: 's3', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_s3' }, format: 'parquet' },
      { pattern: 'dataset_share', transport: 'snowflake_secure_sharing', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_sf' } },
      { pattern: 'warehouse_materialization', transport: 'gam_bigquery_transfer', orchestration: 'consumer_managed', destination: { mode: 'existing', destination_ref: 'dest_bq' } },
    ]) {
      assert.equal(validateConfig({
        delivery_config_id: `cfg-${method.pattern}`,
        delivery_config_version: 1,
        offering_id: `analytics-${method.pattern}`,
        active: true,
        feed_purpose: 'analytics',
        reporting_profile: 'media_buy_delivery_v1',
        scope: { all_media_buys: true },
        required_finality: 'official',
        reconciliation_mode: 'delivery_only',
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
          delivery_config_version: 1,
          offering_id: 'analytics-daily-delta',
          active: true,
          feed_purpose: 'analytics',
          reporting_profile: 'media_buy_delivery_v1',
          scope: { all_media_buys: true },
          required_finality: 'official',
          reconciliation_mode: 'consumer_receipt',
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
      delivery_config_version: 1,
      offering_id: 'shared-reporting',
      reporting_profile: 'media_buy_delivery_v1',
      scope: { all_media_buys: true },
      reconciliation_mode: 'delivery_only',
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
      { ...base, delivery_config_id: 'billing-cycle', feed_purpose: 'billing', required_finality: 'official', reconciliation_mode: 'consumer_receipt', schedule: { period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' } },
    ]) assert.equal(validateConfig(configuration), true, JSON.stringify(validateConfig.errors));

    assert.equal(validateConfig({
      ...base,
      delivery_config_id: 'invalid-billing-snapshot',
      feed_purpose: 'billing',
      required_finality: 'snapshot',
      schedule: { period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' },
    }), false);
    assert.equal(validateConfig({
      ...base,
      delivery_config_id: 'invalid-billing-without-receipt',
      feed_purpose: 'billing',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      schedule: { period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' },
    }), false);
  });

  it('returns seller-resolved destination setup without accepting credential material', () => {
    const configuration = {
      delivery_config_id: 'daily-share',
      delivery_config_version: 1,
      offering_id: 'analytics-daily-delta',
      active: true,
      feed_purpose: 'analytics',
      reporting_profile: 'media_buy_delivery_v1',
      scope: { all_media_buys: true },
      required_finality: 'official',
      reconciliation_mode: 'consumer_receipt',
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
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'revision', reporting_revision_id: revision.reporting_revision_id, pagination: { max_results: 10 } }), true, JSON.stringify(validateRequest.errors));
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'summary', health: ['delayed'] }), false);
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'periods', delivery_config_ids: ['billing-cycle'], feed_purposes: ['billing'] }), true, JSON.stringify(validateRequest.errors));
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'summary', ext: 'not-an-object' }), false);
  });

  it('rejects zero schedules and mutable configuration-generation reuse', () => {
    for (const value of ['P0D', 'PT0S', 'PT']) {
      assert.equal(validateSchedule({ period_duration: value, alignment: 'utc', delivery_sla: 'PT5M' }), false);
    }
    assert.equal(validateSchedule({ period_duration: 'PT5M', alignment: 'utc', delivery_sla: 'PT0S' }), true, JSON.stringify(validateSchedule.errors));
    assert.equal(validateSchedule({ period_duration: 'PT5M', alignment: 'utc', delivery_sla: 'PT' }), false);
    const field = readSchema('/schemas/account/sync-accounts-request.json')
      .properties.accounts.items.properties.reporting_delivery_configs;
    assert.match(field['x-adcp-validation'].unique_config_generation, /Reject/);
    assert.match(field['x-adcp-validation'].immutable_generation, /identical feed\/profile\/scope/);
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
        delivery_config_generations: [{ delivery_config_id: 'daily-share', delivery_config_version: 1, feed_purpose: 'analytics' }],
        feed_purposes: ['analytics'],
        finality: ['snapshot', 'official'],
        ledger_retained_from: '2026-07-29T00:00:00Z',
        coverage_complete: true,
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
    response.health = 'healthy';
    response.scope.coverage_complete = false;
    assert.equal(validateResponse(response), false);
    response.health = 'action_required';
    response.issues = [{
      code: 'HISTORY_UNAVAILABLE',
      severity: 'action_required',
      responsible_party: 'seller',
      recommended_action: 'contact_seller',
      delivery_config_id: 'daily-share',
      delivery_config_version: 1,
      feed_purpose: 'analytics',
    }];
    assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
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
      receipts: [],
      pagination: { has_more: false, total_count: 1 },
    }), true, JSON.stringify(validateResponse.errors));
  });

  it('rejects unverified, mutable, and method-mismatched ready materializations while allowing native controls', () => {
    assert.equal(validateVerification({
      verified_at: '2026-08-27T04:00:16Z',
      verification_path: 'representative_consumer',
      row_count: 0,
    }), false);

    const withoutVersion = structuredClone(materialization);
    delete withoutVersion.resource.native_version_ref;
    assert.equal(validateMaterialization(withoutVersion), false);

    const wrongKind = structuredClone(materialization);
    wrongKind.resource.kind = 'warehouse_relation';
    assert.equal(validateMaterialization(wrongKind), false);

    const fileWithDatasetKind = structuredClone(materialization);
    fileWithDatasetKind.method = 'file_transfer';
    fileWithDatasetKind.transport = 's3';
    fileWithDatasetKind.resource.immutability = 'immutable_location';
    delete fileWithDatasetKind.resource.native_version_ref;
    fileWithDatasetKind.verification.physical_checksums = [{
      object_ref: 'reports/2026-08-26/manifest.json',
      algorithm: 'sha256',
      value: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    }];
    assert.equal(validateMaterialization(fileWithDatasetKind), false);

    const analyticsWithOpaqueNativeEvidence = structuredClone(materialization);
    delete analyticsWithOpaqueNativeEvidence.verification.canonical_content_digest;
    analyticsWithOpaqueNativeEvidence.verification.verification_profile = 'native_commit';
    analyticsWithOpaqueNativeEvidence.verification.native_commit_evidence = {
      native_version_ref: 'delta-table-version:1',
      observed_through: 'representative_consumer',
    };
    assert.equal(validateMaterialization(analyticsWithOpaqueNativeEvidence), true, JSON.stringify(validateMaterialization.errors));
  });

  it('rejects contradictory complete obligations', () => {
    const obligation = {
      reporting_obligation_id: 'robl_complete',
      delivery_config_id: 'daily-share',
      delivery_config_version: 1,
      report_definition_id: revision.report_definition_id,
      feed_purpose: 'analytics',
      reporting_profile: revision.reporting_profile,
      account_id: 'acc_123',
      media_buy_ids: ['mb_123'],
      period: revision.period,
      expected_at: '2026-08-27T04:00:00Z',
      schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
      destination_ref: 'dest_shared_reporting',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      reconciliation_status: 'not_required',
      health: 'complete',
      production_status: 'published',
      revision_count: 1,
      materialization_count: 1,
      successful_materialization_count: 1,
      receipt_count: 0,
      accepted_receipt_count: 0,
      issues: [],
      resource_retained_until: '2026-09-28T04:00:16Z',
    };
    assert.equal(validateObligation(obligation), true, JSON.stringify(validateObligation.errors));
    obligation.production_status = 'failed';
    assert.equal(validateObligation(obligation), false);
    obligation.production_status = 'published';
    obligation.materialization_count = 0;
    obligation.successful_materialization_count = 0;
    assert.equal(validateObligation(obligation), false);
    obligation.materialization_count = 1;
    obligation.successful_materialization_count = 1;
    obligation.reconciliation_mode = 'consumer_receipt';
    obligation.reconciliation_status = 'pending';
    assert.equal(validateObligation(obligation), false);
    obligation.reconciliation_status = 'accepted';
    obligation.receipt_count = 1;
    obligation.accepted_receipt_count = 1;
    assert.equal(validateObligation(obligation), true, JSON.stringify(validateObligation.errors));
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
        delivery_config_generations: [{ delivery_config_id: 'daily-share', delivery_config_version: 1, feed_purpose: 'analytics' }],
        feed_purposes: ['analytics'],
        finality: ['snapshot', 'official'],
        ledger_retained_from: '2026-07-29T00:00:00Z',
        coverage_complete: true,
      },
      periods: [{
        reporting_obligation_id: 'robl_20260826_daily',
        delivery_config_id: 'daily-share',
        delivery_config_version: 1,
        report_definition_id: revision.report_definition_id,
        feed_purpose: 'analytics',
        reporting_profile: revision.reporting_profile,
        account_id: 'acc_123',
        media_buy_ids: ['mb_123'],
        period: revision.period,
        expected_at: '2026-08-27T04:00:00Z',
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
        destination_ref: 'dest_shared_reporting',
        required_finality: 'official',
        reconciliation_mode: 'delivery_only',
        reconciliation_status: 'not_required',
        health: 'complete',
        production_status: 'published',
        revision_count: 2,
        materialization_count: 2,
        successful_materialization_count: 2,
        receipt_count: 0,
        accepted_receipt_count: 0,
        issues: [],
        resource_retained_until: '2026-09-28T04:00:16Z',
      }],
      revisions: [revision, officialRevision],
      materializations: [materialization, officialMaterialization],
      receipts: [],
      pagination: { has_more: false, total_count: 5 },
    };
    assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
    delete response.pagination.total_count;
    assert.equal(validateResponse(response), false);
    response.pagination.total_count = 5;
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
      delivery_config_version: 1,
      feed_purpose: 'analytics',
      reporting_revision_id: revision.reporting_revision_id,
      reporting_materialization_id: materialization.reporting_materialization_id,
      readiness: 'available',
      finality: 'snapshot',
      data_through: '2026-08-27T00:00:00Z',
    };
    assert.equal(validateWebhook(webhook), true, JSON.stringify(validateWebhook.errors));
    assert.equal(validateWebhook({ ...webhook, access_token: 'secret' }), false);
  });

  it('represents fatal reads without pretending a ledger result exists', () => {
    assert.equal(validateResponse({
      status: 'failed',
      view: 'revision',
      failure_kind: 'lookup_unavailable',
      errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
    }), true, JSON.stringify(validateResponse.errors));
    assert.equal(validateResponse({
      status: 'failed',
      view: 'revision',
      failure_kind: 'lookup_unavailable',
      account_id: 'acc_123',
      errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
    }), false);
    assert.equal(validateResponse({
      status: 'failed',
      view: 'summary',
      failure_kind: 'operational',
      message: 'Reporting service is temporarily unavailable.',
      adcp_error: { code: 'SERVICE_UNAVAILABLE', message: 'Retry later.', recovery: 'transient' },
      errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Retry later.', recovery: 'transient' }],
    }), true, JSON.stringify(validateResponse.errors));
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
          receipt_task: 'sync_reporting_receipts',
          readiness_notification: 'reporting.delivery_ready',
          offerings: [{
            offering_id: 'analytics-daily-delta',
            feed_purpose: 'analytics',
            reporting_profile: {
              id: 'media_buy_delivery_v1',
              version: '1.0',
              schema_uri: 'https://schemas.example/media-buy-delivery/v1.json',
              schema_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
              schema_ref_policy: 'local_fragment_only',
              grain: 'media_buy-day',
              primary_keys: ['account_id', 'media_buy_id', 'period_start'],
              canonicalization_id: 'adcp-reporting-rows-v1',
              canonicalization_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            },
            schedule: { period_duration: 'P1D', alignment: 'account_timezone', delivery_sla: 'PT4H' },
            supported_finality: ['snapshot', 'official'],
            reconciliation_mode: 'delivery_only',
            method: {
              pattern: 'dataset_share',
              transport: 'delta_sharing',
              orchestration: 'producer_managed',
              destination_modes: ['provision', 'existing'],
              provider: { domain: 'data-cloud.example' },
              access_mode: 'databricks_to_databricks',
            },
          }],
          automated_recovery_window_seconds: 3600,
          status_retention_days: 30,
          resource_retention_days: 30,
          authorization_revocation_seconds: 300,
        },
      },
      webhook_signing: {
        supported: true,
        profile: 'adcp/webhook-signing/v1',
        algorithms: ['ed25519'],
        legacy_hmac_fallback: false,
      },
      experimental_features: ['media_buy.reporting_delivery'],
    };
    assert.equal(validateCapabilities(capabilities), true, JSON.stringify(validateCapabilities.errors));
    capabilities.media_buy.reporting_delivery.offerings[0].reporting_profile.schema_uri = 'https://127.0.0.1/admin';
    assert.equal(validateCapabilities(capabilities), false);
    capabilities.media_buy.reporting_delivery.offerings[0].reporting_profile.schema_uri = 'https://schemas.example/media-buy-delivery/v1.json';
    assert.match(readSchema('/schemas/core/reporting-delivery-capabilities.json')['x-adcp-validation'].unique_offerings, /provider, access_mode, format/);
    delete capabilities.webhook_signing;
    assert.equal(validateCapabilities(capabilities), false);
    capabilities.webhook_signing = {
      supported: true,
      profile: 'adcp/webhook-signing/v1',
      algorithms: ['ed25519'],
      legacy_hmac_fallback: false,
    };
    capabilities.experimental_features = [];
    assert.equal(validateCapabilities(capabilities), false);
  });

  it('makes caller isolation, revocation, and safe setup handling normative', () => {
    const requestDescription = readSchema('/schemas/media-buy/get-reporting-status-request.json').description;
    assert.match(requestDescription, /authenticated caller identity comes only from transport authentication/);
    assert.match(requestDescription, /indistinguishable/);
    const stateSchema = readSchema('/schemas/core/reporting-delivery-config-state.json');
    assert.match(stateSchema['x-adcp-validation'].binding_authorization, /authenticated caller/);
    assert.match(stateSchema['x-adcp-validation'].revocation, /new obligations\/publication/);
    assert.match(stateSchema['x-adcp-validation'].safe_setup_url, /must surface the URL for explicit human action/);

    const ready = {
      configuration: {
        delivery_config_id: 'daily-share',
        delivery_config_version: 1,
        offering_id: 'analytics-daily-delta',
        active: true,
        feed_purpose: 'analytics',
        reporting_profile: 'media_buy_delivery_v1',
        scope: { all_media_buys: true },
        required_finality: 'official',
        reconciliation_mode: 'delivery_only',
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
        method: { pattern: 'dataset_share', transport: 'delta_sharing', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_shared_reporting' } },
      },
      state: 'ready',
      destination_ref: 'dest_shared_reporting',
      validated_at: '2026-08-27T03:00:00Z',
      activated_at: '2026-08-27T03:00:01Z',
    };
    assert.equal(validateConfigState(ready), true, JSON.stringify(validateConfigState.errors));
    ready.configuration.active = false;
    assert.equal(validateConfigState(ready), false);
    ready.configuration.active = true;
    ready.issues = [{ code: 'ACCESS_REQUIRED', severity: 'action_required', responsible_party: 'buyer', recommended_action: 'repair_access', message: 'Repair access.' }];
    assert.equal(validateConfigState(ready), false);
  });

  it('rejects transitive remote schema dependencies before compilation', () => {
    assert.doesNotThrow(() => assertSelfContainedReportingSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { row: { type: 'object' } },
      $ref: '#/$defs/row',
    }));
    assert.throws(() => assertSelfContainedReportingSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: 'https://127.0.0.1/admin-schema.json',
    }));
    assert.throws(() => assertSelfContainedReportingSchema({
      $schema: 'https://internal.example/unknown-metaschema',
      type: 'object',
    }));
    assert.throws(() => assertSelfContainedReportingSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { nested: { $dynamicRef: 'https://127.0.0.1/dynamic' } },
    }));
    assert.throws(() => assertSelfContainedReportingSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $recursiveRef: 'https://127.0.0.1/recursive',
    }));
    const policy = readSchema('/schemas/core/reporting-delivery-offering.json')['x-adcp-validation'].safe_schema_fetch;
    assert.match(policy, /reject every \$ref not beginning with #/);
    assert.match(policy, /excessive depth\/node count/);
  });
});
