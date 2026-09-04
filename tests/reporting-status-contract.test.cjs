const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function validateGoldenVectorSemantics(contract, canonicalize) {
  const vectors = [
    contract.golden_vectors.empty_report,
    contract.golden_vectors.ordering_encoding,
    ...(contract.golden_vectors.additional ?? []),
  ];
  const names = vectors.map(vector => vector.name);
  assert.equal(new Set(names).size, names.length, 'golden-vector names must be unique');

  for (const purpose of ['empty_report', 'ordering_encoding']) {
    assert.equal(
      vectors.filter(vector => vector.purpose === purpose).length,
      1,
      `${purpose} must occur exactly once`,
    );
  }

  assert.equal(contract.golden_vectors.empty_report.purpose, 'empty_report');
  assert.equal(contract.golden_vectors.ordering_encoding.purpose, 'ordering_encoding');
  assert.ok(
    (contract.golden_vectors.additional ?? []).every(vector => vector.purpose === 'additional'),
    'only additional vectors may appear in the additional collection',
  );

  const orderingVector = contract.golden_vectors.ordering_encoding;
  const sortedOrderingRows = [...orderingVector.input_rows].sort((left, right) => {
    const leftKey = Buffer.from(canonicalize(contract.primary_keys.map(key => left[key])));
    const rightKey = Buffer.from(canonicalize(contract.primary_keys.map(key => right[key])));
    return Buffer.compare(leftKey, rightKey);
  });
  assert.notDeepEqual(
    orderingVector.input_rows,
    sortedOrderingRows,
    'ordering_encoding input rows must not already be in canonical primary-key order',
  );
  assert.ok(
    orderingVector.input_rows.some(row => JSON.stringify(row) !== canonicalize(row)),
    'ordering_encoding must include an object whose member order differs from JCS order',
  );

  for (const vector of vectors) {
    const bytes = Buffer.from(vector.canonical_utf8_base64, 'base64');
    assert.equal(bytes.toString('base64'), vector.canonical_utf8_base64, `${vector.name} base64 must be canonical`);
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      vector.sha256,
      `${vector.name} SHA-256 must match its declared bytes`,
    );

    const sortedRows = [...vector.input_rows].sort((left, right) => {
      const leftKey = Buffer.from(canonicalize(contract.primary_keys.map(key => left[key])));
      const rightKey = Buffer.from(canonicalize(contract.primary_keys.map(key => right[key])));
      return Buffer.compare(leftKey, rightKey);
    });
    const canonicalBytes = Buffer.from(`[${sortedRows.map(row => canonicalize(row)).join(',')}]`);
    assert.deepEqual(canonicalBytes, bytes, `${vector.name} canonical bytes must match its input rows`);
  }
}

function isRecognizedIanaTimezone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return !/^[+-]\d{2}:?\d{2}$/.test(value);
  } catch {
    return false;
  }
}

const fullCoverage = {
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
};

const revision = {
  reporting_revision_id: 'rrv_20260827_a',
  report_definition_id: 'rdef_daily_delivery_v1',
  report_definition_uri: 'https://schemas.example/reporting-definitions/daily-delivery-v1.json',
  report_definition_sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  reporting_profile: 'media_buy_delivery_v1',
  schema_version: '1.0',
  schema_uri: 'https://schemas.example/media-buy-delivery/v1.json',
  schema_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  account_id: 'acc_123',
  media_buy_ids: ['mb_123'],
  coverage: fullCoverage,
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
    value: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    canonicalization_id: 'adcp-reporting-rows-v1',
    canonicalization_uri: 'https://schemas.example/reporting-canonicalization/v1.json',
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
  finality_basis: 'contractual_cutoff',
  finality_policy_id: 'analytics-daily-finality-v1',
  finalized_at: '2026-08-29T04:00:00Z',
  observed_at: '2026-08-29T04:00:00Z',
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
    canonicalization_uri: 'https://schemas.example/reporting-canonicalization/v1.json',
    canonicalization_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  },
  created_at: '2026-08-29T04:00:01Z',
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
  let validateCanonicalizationContract;
  let validateScheduleOffering;
  let validateReportDefinition;
  let validateCoverage;
  let validateProductReportingCapabilities;
  let validateControlTotal;
  let validateAdjustment;
  let validateAdjustmentReceipt;
  let validateReliabilityStatistics;
  let validateLedgerWebhook;
  let canonicalize;

  before(async () => {
    [validateConfig, validateRequest, validateResponse, validateWebhook, validateNotificationConfig, validateCapabilities, validateSyncAccounts, validateConfigState, validateObligation, validateMaterialization, validateVerification, validateSchedule, validateRevision, validateManifest, validateResource, validateReceiptRequest, validateReceiptResponse, validateCanonicalizationContract, validateScheduleOffering, validateReportDefinition, validateCoverage, validateProductReportingCapabilities, validateControlTotal, validateAdjustment, validateAdjustmentReceipt, validateReliabilityStatistics, validateLedgerWebhook] = await Promise.all([
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
      compile('/schemas/core/reporting-canonicalization-contract.json'),
      compile('/schemas/core/reporting-schedule-offering.json'),
      compile('/schemas/core/reporting-report-definition.json'),
      compile('/schemas/core/reporting-coverage.json'),
      compile('/schemas/core/reporting-capabilities.json'),
      compile('/schemas/core/reporting-control-total.json'),
      compile('/schemas/core/reporting-adjustment.json'),
      compile('/schemas/core/reporting-adjustment-receipt.json'),
      compile('/schemas/core/reporting-reliability-statistics.json'),
      compile('/schemas/core/reporting-ledger-changed-webhook.json'),
    ]);
    canonicalize = (await import('canonicalize')).default;
  });

  it('declares product-scoped offerings and preserves partial snapshot coverage', () => {
    assert.equal(validateProductReportingCapabilities({
      available_reporting_frequencies: ['hourly', 'daily'],
      expected_delay_minutes: 15,
      timezone: 'UTC',
      supports_webhooks: true,
      reporting_delivery_offering_ids: ['pacing-hourly-s3', 'billing-daily-s3'],
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    }), true, JSON.stringify(validateProductReportingCapabilities.errors));

    const partialCoverage = {
      status: 'partial',
      evaluated_at: '2026-08-27T00:00:00Z',
      media_buy_ids: ['mb_123'],
      fully_covered_media_buy_ids: [],
      partially_covered_media_buy_ids: ['mb_123'],
      unsupported_media_buy_ids: [],
      unknown_media_buy_ids: [],
      package_ids: ['pkg_covered', 'pkg_unsupported'],
      covered_package_ids: ['pkg_covered'],
      unsupported_package_ids: ['pkg_unsupported'],
      unknown_package_ids: [],
      limitations: [{
        reason: 'offering_unsupported',
        media_buy_id: 'mb_123',
        package_ids: ['pkg_unsupported'],
      }],
    };
    assert.equal(validateCoverage(partialCoverage), true, JSON.stringify(validateCoverage.errors));

    const configuration = {
      delivery_config_id: 'pacing-hourly-s3',
      delivery_config_version: 1,
      offering_id: 'pacing-hourly-s3',
      active: true,
      feed_purpose: 'pacing',
      report_definition_id: revision.report_definition_id,
      reporting_profile: 'media_buy_delivery_v1',
      scope: { media_buy_ids: ['mb_123'] },
      coverage_requirement: 'allow_partial',
      required_finality: 'snapshot',
      reconciliation_mode: 'delivery_only',
      schedule: { period_duration: 'PT1H', alignment: 'utc', delivery_sla: 'PT15M' },
      method: { pattern: 'file_transfer', transport: 's3', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_s3' }, format: 'parquet' },
    };
    assert.equal(validateConfig(configuration), true, JSON.stringify(validateConfig.errors));
    delete configuration.coverage_requirement;
    assert.equal(validateConfig(configuration), false);
  });

  it('keeps canonical revisions destination-independent for multi-destination fan-out', () => {
    assert.equal(validateRevision(revision), true, JSON.stringify(validateRevision.errors));
    assert.equal(validateRevision({ ...revision, destination_ref: 'dest_should_not_be_here' }), false);
    assert.equal(validateRevision({ ...revision, media_buy_ids: [] }), true, JSON.stringify(validateRevision.errors));
    const denominatorUnknown = structuredClone(revision);
    delete denominatorUnknown.media_buy_ids;
    assert.equal(validateRevision(denominatorUnknown), false);

    assert.equal(validateRevision(officialRevision), true, JSON.stringify(validateRevision.errors));
    const unexplainedOfficial = structuredClone(officialRevision);
    delete unexplainedOfficial.finality_basis;
    assert.equal(validateRevision(unexplainedOfficial), false);
    assert.equal(validateRevision({ ...revision, finality_basis: 'stabilized' }), false);

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
      adcp_version: '3.2-beta.8',
      adcp_major_version: 3,
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
      const configuration = {
        delivery_config_id: `cfg-${method.pattern}`,
        delivery_config_version: 1,
        offering_id: `analytics-${method.pattern}`,
        active: true,
        feed_purpose: 'analytics',
        report_definition_id: revision.report_definition_id,
        reporting_profile: 'media_buy_delivery_v1',
        scope: { all_media_buys: true },
        coverage_requirement: 'full',
        required_finality: 'official',
        reconciliation_mode: 'delivery_only',
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
        method,
      };
      assert.equal(validateConfig(configuration), true, JSON.stringify(validateConfig.errors));
      delete configuration.report_definition_id;
      assert.equal(validateConfig(configuration), false);
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
          report_definition_id: revision.report_definition_id,
          reporting_profile: 'media_buy_delivery_v1',
          scope: { all_media_buys: true },
          coverage_requirement: 'full',
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
      report_definition_id: revision.report_definition_id,
      reporting_profile: 'media_buy_delivery_v1',
      scope: { all_media_buys: true },
      coverage_requirement: 'full',
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
      { ...base, delivery_config_id: 'billing-cycle', feed_purpose: 'billing', required_finality: 'official', reconciliation_mode: 'consumer_receipt', schedule: { period_duration: 'P1M', alignment: 'billing_cycle', period_anchor: '2026-01-15T05:00:00Z', period_timezone: 'America/New_York', delivery_sla: 'P1D' } },
    ]) assert.equal(validateConfig(configuration), true, JSON.stringify(validateConfig.errors));

    assert.equal(validateConfig({
      ...base,
      delivery_config_id: 'invalid-billing-snapshot',
      feed_purpose: 'billing',
      required_finality: 'snapshot',
      schedule: { period_duration: 'P1M', alignment: 'billing_cycle', period_anchor: '2026-01-15T05:00:00Z', period_timezone: 'America/New_York', delivery_sla: 'P1D' },
    }), false);
    assert.equal(validateConfig({
      ...base,
      delivery_config_id: 'invalid-billing-without-receipt',
      feed_purpose: 'billing',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      schedule: { period_duration: 'P1M', alignment: 'billing_cycle', period_anchor: '2026-01-15T05:00:00Z', period_timezone: 'America/New_York', delivery_sla: 'P1D' },
    }), false);
  });

  it('returns seller-resolved destination setup without accepting credential material', () => {
    const configuration = {
      delivery_config_id: 'daily-share',
      delivery_config_version: 1,
      offering_id: 'analytics-daily-delta',
      active: true,
      feed_purpose: 'analytics',
      report_definition_id: revision.report_definition_id,
      reporting_profile: 'media_buy_delivery_v1',
      scope: { all_media_buys: true },
      coverage_requirement: 'full',
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
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'periods', changes_after: 'checkpoint_0001' }), true, JSON.stringify(validateRequest.errors));
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'summary', changes_after: 'checkpoint_0001' }), false);
    assert.equal(validateRequest({ account: { account_id: 'acc_123' }, view: 'summary', ext: 'not-an-object' }), false);
  });

  it('rejects zero schedules and mutable configuration-generation reuse', () => {
    for (const value of ['P0D', 'PT0S', 'PT']) {
      assert.equal(validateSchedule({ period_duration: value, alignment: 'utc', delivery_sla: 'PT5M' }), false);
    }
    assert.equal(validateSchedule({ period_duration: 'PT5M', alignment: 'utc', delivery_sla: 'PT0S' }), true, JSON.stringify(validateSchedule.errors));
    assert.equal(validateSchedule({ period_duration: 'PT5M', alignment: 'utc', delivery_sla: 'PT' }), false);
    assert.equal(validateSchedule({ period_duration: 'P1M', alignment: 'billing_cycle', delivery_sla: 'P1D' }), false);
    assert.equal(validateSchedule({ period_duration: 'P1M', alignment: 'billing_cycle', period_anchor: '2026-01-15T05:00:00Z', delivery_sla: 'P1D' }), false);
    assert.equal(validateSchedule({ period_duration: 'P1M', alignment: 'billing_cycle', period_anchor: '2026-01-15T05:00:00Z', period_timezone: 'America/New_York', delivery_sla: 'P1D' }), true, JSON.stringify(validateSchedule.errors));
    assert.equal(validateSchedule({ period_duration: 'P1D', alignment: 'utc', period_anchor: '2026-01-15T05:00:00Z', delivery_sla: 'PT4H' }), false);
    assert.equal(validateSchedule({ period_duration: 'P1D', alignment: 'utc', period_timezone: 'America/New_York', delivery_sla: 'PT4H' }), false);
    assert.equal(validateSchedule({ period_duration: 'P1D', alignment: 'source_timezone', period_timezone: 'America/New_York', delivery_sla: 'PT8H' }), true, JSON.stringify(validateSchedule.errors));
    assert.equal(validateSchedule({ period_duration: 'P1D', alignment: 'source_timezone', delivery_sla: 'PT8H' }), false);
    assert.equal(validateSchedule({ period_duration: 'P1D', alignment: 'source_timezone', period_anchor: '2026-01-15T05:00:00Z', period_timezone: 'America/New_York', delivery_sla: 'PT8H' }), false);
    assert.equal(isRecognizedIanaTimezone('America/New_York'), true);
    assert.equal(isRecognizedIanaTimezone('UTC'), true);
    assert.equal(isRecognizedIanaTimezone('Not/A_Timezone'), false);
    assert.match(readSchema('/schemas/core/reporting-schedule.json')['x-adcp-validation'].iana_timezone, /Reject unknown identifiers/);
    const field = readSchema('/schemas/account/sync-accounts-request.json')
      .properties.accounts.items.properties.reporting_delivery_configs;
    assert.match(field['x-adcp-validation'].unique_config_generation, /Reject/);
    assert.match(field['x-adcp-validation'].immutable_generation, /identical feed\/profile\/scope/);
  });

  it('defines an executable canonicalization contract with cross-language vectors', () => {
    const contract = {
      contract_version: '1.0',
      media_type: 'application/vnd.adcp.reporting-canonicalization+json',
      algorithm: 'adcp_jcs_rows_v1',
      schema_sha256: revision.schema_sha256,
      primary_keys: ['media_buy_id', 'date'],
      golden_vectors: {
        empty_report: { name: 'empty', purpose: 'empty_report', input_rows: [], canonical_utf8_base64: 'W10=', sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' },
        ordering_encoding: { name: 'ordering', purpose: 'ordering_encoding', input_rows: [{ media_buy_id: 'b', date: '2026-08-26' }, { media_buy_id: 'a', date: '2026-08-26' }], canonical_utf8_base64: 'W3siZGF0ZSI6IjIwMjYtMDgtMjYiLCJtZWRpYV9idXlfaWQiOiJhIn0seyJkYXRlIjoiMjAyNi0wOC0yNiIsIm1lZGlhX2J1eV9pZCI6ImIifV0=', sha256: '54a318008a022606fdf2ad2a717bb9c6665825f717d15dc61369fb17bd5ab1d2' },
      },
    };
    assert.equal(validateCanonicalizationContract(contract), true, JSON.stringify(validateCanonicalizationContract.errors));
    validateGoldenVectorSemantics(contract, canonicalize);

    const ordinaryOnly = structuredClone(contract);
    ordinaryOnly.golden_vectors = { additional: [
      { ...ordinaryOnly.golden_vectors.empty_report, purpose: 'additional' },
      { ...ordinaryOnly.golden_vectors.ordering_encoding, purpose: 'additional' },
    ] };
    assert.equal(validateCanonicalizationContract(ordinaryOnly), false);

    const nonEmptyRequiredCase = structuredClone(contract);
    nonEmptyRequiredCase.golden_vectors.empty_report.input_rows = [{ media_buy_id: 'a', date: '2026-08-26' }];
    assert.equal(validateCanonicalizationContract(nonEmptyRequiredCase), false);

    const trivialOrderingCase = structuredClone(contract);
    trivialOrderingCase.golden_vectors.ordering_encoding = {
      name: 'trivial-ordering',
      purpose: 'ordering_encoding',
      input_rows: [],
      canonical_utf8_base64: 'W10=',
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    };
    assert.equal(validateCanonicalizationContract(trivialOrderingCase), false);

    const alreadyOrderedCase = structuredClone(contract);
    alreadyOrderedCase.golden_vectors.ordering_encoding.input_rows.reverse();
    assert.throws(
      () => validateGoldenVectorSemantics(alreadyOrderedCase, canonicalize),
      /must not already be in canonical primary-key order/,
    );

    const duplicateRequiredPurpose = structuredClone(contract);
    duplicateRequiredPurpose.golden_vectors.additional = [{
      ...duplicateRequiredPurpose.golden_vectors.empty_report,
      name: 'empty-duplicate',
    }];
    assert.throws(
      () => validateGoldenVectorSemantics(duplicateRequiredPurpose, canonicalize),
      /empty_report must occur exactly once/,
    );

    const mismatchedDigest = structuredClone(contract);
    mismatchedDigest.golden_vectors.empty_report.sha256 = '0'.repeat(64);
    assert.throws(
      () => validateGoldenVectorSemantics(mismatchedDigest, canonicalize),
      /SHA-256 must match/,
    );
    assert.match(readSchema('/schemas/core/reporting-canonicalization-contract.json')['x-adcp-validation'].algorithm, /RFC 8785-encode/);
    assert.match(readSchema('/schemas/core/reporting-canonicalization-contract.json')['x-adcp-validation'].binding, /reproduce every golden vector/);
  });

  it('enforces control-value types and physical checksum lengths in JSON Schema', () => {
    assert.equal(validateControlTotal({ name: 'impressions', value: '42', value_type: 'integer' }), true);
    assert.equal(validateControlTotal({ name: 'spend', value: '42.50', value_type: 'decimal' }), true);
    assert.equal(validateControlTotal({ name: 'impressions', value: '1.5', value_type: 'integer' }), false);

    const verification = {
      verified_at: '2026-08-27T04:00:16Z',
      verification_path: 'producer',
      verification_profile: 'manifest_checksums',
      row_count: 2,
      control_totals: [],
      physical_checksums: [
        { object_ref: 'part-000.jsonl', algorithm: 'sha256', value: 'a'.repeat(64) },
        { object_ref: 'part-000.jsonl', algorithm: 'sha512', value: 'b'.repeat(128) },
      ],
    };
    assert.equal(validateVerification(verification), true, JSON.stringify(validateVerification.errors));

    verification.physical_checksums[0].value = 'a'.repeat(128);
    assert.equal(validateVerification(verification), false);
    verification.physical_checksums[0].value = 'a'.repeat(64);
    verification.physical_checksums[1].value = 'b'.repeat(64);
    assert.equal(validateVerification(verification), false);
  });

  it('separates global schedule constraints from account billing anchors', () => {
    assert.equal(validateScheduleOffering({ period_duration: 'P1M', alignment: 'billing_cycle', period_anchor_policy: 'configurable', delivery_sla: 'P1D' }), true, JSON.stringify(validateScheduleOffering.errors));
    assert.equal(validateScheduleOffering({ period_duration: 'P1M', alignment: 'billing_cycle', period_anchor_policy: 'fixed', period_anchor: '2026-01-31T05:00:00Z', period_timezone: 'America/New_York', delivery_sla: 'P1D' }), true, JSON.stringify(validateScheduleOffering.errors));
    assert.equal(validateScheduleOffering({ period_duration: 'P1M', alignment: 'billing_cycle', period_anchor_policy: 'fixed', delivery_sla: 'P1D' }), false);
    assert.equal(validateScheduleOffering({ period_duration: 'P1D', alignment: 'source_timezone', period_timezone_policy: 'fixed', period_timezone: 'America/New_York', delivery_sla: 'PT8H' }), true, JSON.stringify(validateScheduleOffering.errors));
    assert.equal(validateScheduleOffering({ period_duration: 'P1D', alignment: 'source_timezone', period_timezone_policy: 'account_resolved', delivery_sla: 'PT8H' }), true, JSON.stringify(validateScheduleOffering.errors));
    assert.equal(validateScheduleOffering({ period_duration: 'P1D', alignment: 'source_timezone', period_timezone_policy: 'account_resolved', period_timezone: 'America/New_York', delivery_sla: 'PT8H' }), false);
    assert.match(readSchema('/schemas/core/reporting-schedule.json')['x-adcp-validation'].period_generation, /origin and the interval ordinal/);
    assert.match(readSchema('/schemas/core/reporting-schedule.json')['x-adcp-validation'].period_generation, /1970-01-01T00:00:00Z as interval zero/);
    assert.equal(validateSchedule({ period_duration: 'P2D', alignment: 'utc', delivery_sla: 'PT4H' }), true, JSON.stringify(validateSchedule.errors));
  });

  it('pins inspectable source, restatement, and finality semantics', () => {
    const definition = {
      contract_version: '1.1',
      media_type: 'application/vnd.adcp.reporting-definition+json',
      report_definition_id: revision.report_definition_id,
      reporting_profile: revision.reporting_profile,
      grain: 'media_buy-day',
      source: {
        provider: { domain: 'social.example' },
        system: 'insights',
        api_version: 'v25.0',
        query_semantics: { attribution_window: ['7d_click', '1d_view'], action_report_time: 'conversion' },
      },
      calendar: { timezone_basis: 'account_timezone' },
      metrics: [{ name: 'spend', source_expression: 'spend', aggregation: 'sum', unit: 'account_currency' }],
      dimensions: ['account_id', 'media_buy_id', 'period_start'],
      restatement_policy: { source_requery_duration: 'P28D', emit_only_on_content_change: true, official_correction_mode: 'adjustments_only' },
      finality_policies: [{ finality_policy_id: officialRevision.finality_policy_id, basis: 'contractual_cutoff', duration_after_period_end: 'P2D' }],
    };
    assert.equal(validateReportDefinition(definition), true, JSON.stringify(validateReportDefinition.errors));
    assert.match(readSchema('/schemas/core/reporting-report-definition.json')['x-adcp-validation'].binding, /official revision/);
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
      coverage: fullCoverage,
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
      issue_id: 'iss_history_unavailable_daily_share',
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

  it('represents an unfiltered account with no reporting configurations as an empty scope', () => {
    const response = {
      status: 'completed',
      view: 'periods',
      ledger_snapshot_id: 'ledger_empty_001',
      ledger_as_of: '2026-08-29T12:00:00Z',
      changes_checkpoint: 'checkpoint_empty_001',
      account_id: 'acc_123',
      scope: {
        period_start: '2026-08-01T00:00:00Z',
        period_end: '2026-08-29T00:00:00Z',
        scope_closed: true,
        all_accessible_media_buys: true,
        delivery_config_generations: [],
        feed_purposes: [],
        finality: [],
        ledger_retained_from: '2026-08-01T00:00:00Z',
        coverage_complete: true,
      },
      health: 'complete',
      data_through: null,
      obligation_counts: {
        total: 0,
        waiting: 0,
        healthy: 0,
        delayed: 0,
        action_required: 0,
        complete: 0,
      },
      issues: [],
      periods: [],
      revisions: [],
      adjustments: [],
      materializations: [],
      receipts: [],
      pagination: { has_more: false, total_count: 0 },
    };
    assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
    assert.match(
      readSchema('/schemas/media-buy/get-reporting-status-response.json')['x-adcp-validation'].empty_scope,
      /reporting_delivery_configs: \[\]/,
    );
  });

  it('retains a zero-row revision and consumer-verified native resource evidence', () => {
    assert.equal(validateResponse({
      status: 'completed',
      view: 'revision',
      ledger_snapshot_id: 'ledger_20260828_002',
      ledger_as_of: '2026-08-28T12:00:00Z',
      account_id: 'acc_123',
      revision,
      adjustments: [],
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
      scope_resolved_at: '2026-08-27T00:00:00Z',
      coverage: fullCoverage,
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
      adjustment_count: 0,
      materialization_count: 1,
      successful_materialization_count: 1,
      receipt_count: 0,
      accepted_receipt_count: 0,
      issues: [],
      resource_retained_until: '2026-09-28T04:00:16Z',
    };
    assert.equal(validateObligation(obligation), true, JSON.stringify(validateObligation.errors));
    obligation.media_buy_ids = [];
    assert.equal(validateObligation(obligation), true, JSON.stringify(validateObligation.errors));
    delete obligation.media_buy_ids;
    assert.equal(validateObligation(obligation), false);
    obligation.media_buy_ids = ['mb_123'];
    delete obligation.scope_resolved_at;
    assert.equal(validateObligation(obligation), false);
    obligation.scope_resolved_at = '2026-08-27T00:00:00Z';
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

  it('returns the retained snapshot chain and immutable official close in the paginated ledger', () => {
    const response = {
      status: 'completed',
      view: 'periods',
      ledger_snapshot_id: 'ledger_20260829_001',
      ledger_as_of: '2026-08-29T12:00:00Z',
      changes_checkpoint: 'checkpoint_20260829_001',
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
        scope_resolved_at: '2026-08-27T00:00:00Z',
        coverage: fullCoverage,
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
        adjustment_count: 0,
        materialization_count: 2,
        successful_materialization_count: 2,
        receipt_count: 0,
        accepted_receipt_count: 0,
        issues: [],
        resource_retained_until: '2026-09-28T04:00:16Z',
      }],
      revisions: [revision, officialRevision],
      adjustments: [],
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

  it('locks official revisions and records later corrections as accounting adjustments', () => {
    assert.match(
      readSchema('/schemas/enums/reporting-finality.json').description,
      /official revision is the immutable, invoice-addressable close/,
    );
    assert.match(
      readSchema('/schemas/core/reporting-revision.json')['x-adcp-validation'].slice_identity,
      /no revision may supersede an official revision/,
    );

    const adjustment = {
      reporting_adjustment_id: 'radj_20260829_001',
      adjusts_reporting_revision_id: officialRevision.reporting_revision_id,
      reason_code: 'invalid_traffic',
      accounting_period: {
        start: '2026-09-01T00:00:00Z',
        end: '2026-10-01T00:00:00Z',
      },
      control_total_deltas: [
        { name: 'impressions', value: '-20', value_type: 'integer', unit: 'impressions' },
        { name: 'spend', value: '-35.00', value_type: 'decimal', unit: 'USD' },
      ],
      correction_observed_at: '2026-08-29T10:00:00Z',
      created_at: '2026-08-29T10:00:01Z',
    };
    adjustment.canonical_adjustment_sha256 = crypto.createHash('sha256')
      .update(canonicalize(adjustment))
      .digest('hex');
    assert.equal(validateAdjustment(adjustment), true, JSON.stringify(validateAdjustment.errors));
    const coreAdjustment = structuredClone(adjustment);
    delete coreAdjustment.canonical_adjustment_sha256;
    assert.equal(validateAdjustment(coreAdjustment), true, 'Core adjustments do not require Reconciled Billing digest code');
    assert.equal(new Set(adjustment.control_total_deltas.map(total => total.name)).size, adjustment.control_total_deltas.length);
    const duplicateName = structuredClone(adjustment);
    duplicateName.control_total_deltas.push({ name: 'spend', value: '1.00', value_type: 'decimal', unit: 'USD' });
    assert.notEqual(new Set(duplicateName.control_total_deltas.map(total => total.name)).size, duplicateName.control_total_deltas.length);

    const adjustmentReceipt = {
      reporting_receipt_id: 'receipt_adjustment_20260829_001',
      reporting_adjustment_id: adjustment.reporting_adjustment_id,
      adjusts_reporting_revision_id: adjustment.adjusts_reporting_revision_id,
      status: 'accepted',
      observed_adjustment_sha256: adjustment.canonical_adjustment_sha256,
      observed_at: '2026-08-29T10:01:00Z',
    };
    assert.equal(validateAdjustmentReceipt(adjustmentReceipt), true, JSON.stringify(validateAdjustmentReceipt.errors));
    assert.equal(validateReceiptRequest({
      account: { account_id: 'acc_123' },
      idempotency_key: 'receipt-adjustment-batch-001',
      adjustment_receipts: [adjustmentReceipt],
    }), true, JSON.stringify(validateReceiptRequest.errors));
    const recordedAdjustmentReceipt = { ...adjustmentReceipt, received_at: '2026-08-29T10:01:01Z' };
    assert.equal(validateReceiptResponse({
      status: 'completed',
      results: [{ result: 'recorded', adjustment_receipt: recordedAdjustmentReceipt }],
    }), true, JSON.stringify(validateReceiptResponse.errors));
    delete adjustment.accounting_period;
    assert.equal(validateAdjustment(adjustment), false);
  });

  it('publishes comparable observed reliability with evidence and sample counts', () => {
    const statistics = {
      offering_id: 'analytics-daily-delta',
      measurement_period: {
        start: '2026-06-01T00:00:00Z',
        end: '2026-09-01T00:00:00Z',
      },
      obligations_due: 1000,
      obligations_on_time: 982,
      official_revisions_published: 900,
      official_revisions_adjusted: 18,
      publication_latency_seconds: { p50: 7200, p95: 14400 },
      adjustment_latency_seconds: { p50: 86400, p95: 604800 },
      adjustment_magnitude: [{
        control_total_name: 'spend',
        unit: 'USD',
        sample_count: 18,
        p50_absolute_delta: '12.50',
        p95_absolute_delta: '83.75',
      }],
      evidence: {
        basis: 'reporting_ledger',
        generated_at: '2026-09-01T01:00:00Z',
      },
    };
    assert.equal(validateReliabilityStatistics(statistics), true, JSON.stringify(validateReliabilityStatistics.errors));
    delete statistics.adjustment_latency_seconds;
    assert.equal(validateReliabilityStatistics(statistics), false);
  });

  it('gives reporting helper types globally distinct SDK names', () => {
    const reliabilitySchema = readSchema('/schemas/core/reporting-reliability-statistics.json');
    assert.equal(
      reliabilitySchema.properties.measurement_period.$ref,
      '#/definitions/ReportingReliabilityMeasurementPeriod',
    );
    assert.ok(reliabilitySchema.definitions.ReportingReliabilityMeasurementPeriod);

    const adjustmentReceiptSchema = readSchema('/schemas/core/reporting-adjustment-receipt.json');
    assert.equal(
      adjustmentReceiptSchema.properties.rejection_codes.items.$ref,
      '#/definitions/ReportingAdjustmentRejectionCode',
    );
    assert.ok(adjustmentReceiptSchema.definitions.ReportingAdjustmentRejectionCode);
  });

  it('announces ledger changes independently of health and repairs from a checkpoint', () => {
    assert.equal(validateNotificationConfig({
      subscriber_id: 'reporting-ledger',
      url: 'https://buyer.example/webhooks/reporting-ledger',
      event_types: ['reporting.ledger_changed'],
      active: true,
    }), true, JSON.stringify(validateNotificationConfig.errors));

    const event = {
      idempotency_key: 'whk_20260828_revision_0001',
      notification_id: 'ledger_rrv_20260827_b',
      notification_type: 'reporting.ledger_changed',
      fired_at: '2026-08-28T04:00:02Z',
      subscriber_id: 'reporting-ledger',
      account_id: 'acc_123',
      change_kind: 'revision_published',
      reporting_revision_id: officialRevision.reporting_revision_id,
      supersedes_reporting_revision_id: revision.reporting_revision_id,
      finality: 'official',
    };
    assert.equal(validateLedgerWebhook(event), true, JSON.stringify(validateLedgerWebhook.errors));
    event.change_kind = 'adjustment_published';
    assert.equal(validateLedgerWebhook(event), false);
    delete event.reporting_revision_id;
    delete event.supersedes_reporting_revision_id;
    delete event.finality;
    event.reporting_adjustment_id = 'radj_20260829_001';
    event.adjusts_reporting_revision_id = officialRevision.reporting_revision_id;
    assert.equal(validateLedgerWebhook(event), true, JSON.stringify(validateLedgerWebhook.errors));
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
          reliable_reporting_version: '1.0',
          managed_delivery: true,
          configuration_task: 'sync_accounts',
          status_task: 'get_reporting_status',
          receipt_task: 'sync_reporting_receipts',
          readiness_notification: 'reporting.delivery_ready',
          offerings: [{
            offering_id: 'analytics-daily-delta',
            feed_purpose: 'analytics',
            report_definition_id: revision.report_definition_id,
            report_definition_uri: revision.report_definition_uri,
            report_definition_sha256: revision.report_definition_sha256,
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
              canonicalization_contract_version: '1.0',
              canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
              canonicalization_uri: 'https://schemas.example/reporting-canonicalization/v1.json',
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
    const ledgerOnly = structuredClone(capabilities);
    delete ledgerOnly.media_buy.reporting_delivery.readiness_notification;
    ledgerOnly.media_buy.reporting_delivery.ledger_notification = 'reporting.ledger_changed';
    delete ledgerOnly.webhook_signing;
    assert.equal(validateCapabilities(ledgerOnly), false, 'ledger notifications require webhook signing');
    capabilities.media_buy.reporting_delivery.offerings[0].reporting_profile.schema_uri = 'https://127.0.0.1/admin';
    assert.equal(validateCapabilities(capabilities), false);
    capabilities.media_buy.reporting_delivery.offerings[0].reporting_profile.schema_uri = 'https://schemas.example/media-buy-delivery/v1.json';
    capabilities.media_buy.reporting_delivery.offerings[0].reporting_profile.canonicalization_uri = 'https://127.0.0.1/canonicalization.json';
    assert.equal(validateCapabilities(capabilities), false);
    capabilities.media_buy.reporting_delivery.offerings[0].reporting_profile.canonicalization_uri = 'https://schemas.example/reporting-canonicalization/v1.json';
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
    assert.match(stateSchema['x-adcp-validation'].binding_authorization, /grants no account authority/);
    assert.match(stateSchema['x-adcp-validation'].revocation, /new obligations\/publication/);
    assert.match(stateSchema['x-adcp-validation'].safe_setup_url, /must surface the URL for explicit human action/);

    const ready = {
      configuration: {
        delivery_config_id: 'daily-share',
        delivery_config_version: 1,
        offering_id: 'analytics-daily-delta',
        active: true,
        feed_purpose: 'analytics',
        report_definition_id: revision.report_definition_id,
        reporting_profile: 'media_buy_delivery_v1',
        scope: { all_media_buys: true },
        coverage_requirement: 'full',
        required_finality: 'official',
        reconciliation_mode: 'delivery_only',
        schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
        method: { pattern: 'dataset_share', transport: 'delta_sharing', orchestration: 'producer_managed', destination: { mode: 'existing', destination_ref: 'dest_shared_reporting' } },
      },
      state: 'ready',
      destination_ref: 'dest_shared_reporting',
      validated_at: '2026-08-27T03:00:00Z',
      activated_at: '2026-08-27T03:00:01Z',
      current_coverage: { ...fullCoverage, evaluated_at: '2026-08-27T03:00:00Z' },
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
