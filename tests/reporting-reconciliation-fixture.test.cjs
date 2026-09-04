'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');
const FIXTURE_ROOT = path.join(
  ROOT,
  'static/compliance/source/test-vectors/reporting-reconciliation',
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), 'utf8'));
}

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compileSchema(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function hash(bytes, algorithm) {
  return crypto.createHash(algorithm).update(bytes).digest('hex');
}

function canonicalReportBytes(rows, primaryKeys, canonicalize) {
  const sorted = [...rows].sort((left, right) => {
    const leftKey = Buffer.from(canonicalize(primaryKeys.map(key => left[key])));
    const rightKey = Buffer.from(canonicalize(primaryKeys.map(key => right[key])));
    return Buffer.compare(leftKey, rightKey);
  });
  return Buffer.from(`[${sorted.map(row => canonicalize(row)).join(',')}]`);
}

function assertReceiptAcknowledgement(request, response, expectedResult) {
  assert.equal(request.receipts.length, 1);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].result, expectedResult);
  const { received_at: receivedAt, ...acknowledged } = response.results[0].receipt;
  assert.match(receivedAt, /^2026-08-27T04:01:01Z$/);
  assert.deepEqual(acknowledged, request.receipts[0]);
}

function replaceJsonPointer(document, pointer, value) {
  const segments = pointer.slice(1).split('/').map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const property = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], document);
  assert.ok(parent && Object.hasOwn(parent, property), `mutation pointer must exist: ${pointer}`);
  parent[property] = value;
}

function observedControlTotals(rows, expectedTotals) {
  return expectedTotals.map(total => {
    const sum = rows.reduce((value, row) => value + Number(row[total.name]), 0);
    const decimalPlaces = total.value_type === 'decimal'
      ? Math.max(...rows.map(row => String(row[total.name]).split('.')[1]?.length ?? 0))
      : 0;
    return { ...total, value: decimalPlaces ? sum.toFixed(decimalPlaces) : String(sum) };
  });
}

function executeScenario(index, scenario, canonicalize, validateRow) {
  const mutation = scenario.mutation;
  const revision = structuredClone(readJson(index.base_inputs.revision));
  const materialization = readJson(index.base_inputs.materialization);
  const objectAssets = new Map([
    ['manifest', index.base_inputs.manifest],
    ['rows.jsonl', 'rows.jsonl'],
  ]);
  const objects = new Map(
    [...objectAssets].map(([objectRef, asset]) => [objectRef, fs.readFileSync(path.join(FIXTURE_ROOT, asset))]),
  );

  if (mutation.operation === 'remove_object') objects.delete(mutation.object_ref);
  if (mutation.operation === 'xor_byte') {
    const bytes = Buffer.from(objects.get(mutation.object_ref));
    assert.ok(mutation.byte_offset < bytes.length, 'xor_byte offset must select an existing byte');
    bytes[mutation.byte_offset] ^= mutation.xor_mask;
    objects.set(mutation.object_ref, bytes);
  }
  if (mutation.operation === 'replace_json_pointer') {
    assert.equal(mutation.asset, index.base_inputs.revision);
    replaceJsonPointer(revision, mutation.pointer, mutation.value);
  }

  const attempts = new Map();
  const trace = [];
  const readObject = objectRef => {
    const attempt = (attempts.get(objectRef) ?? 0) + 1;
    attempts.set(objectRef, attempt);
    if (mutation.operation === 'inject_read_error'
      && mutation.object_ref === objectRef
      && mutation.attempt === attempt) {
      trace.push({ object_ref: objectRef, outcome: mutation.outcome });
      return { outcome: mutation.outcome };
    }
    if (!objects.has(objectRef)) {
      trace.push({ object_ref: objectRef, outcome: 'not_found' });
      return { outcome: 'not_found' };
    }
    trace.push({ object_ref: objectRef, outcome: 'bytes', asset: objectAssets.get(objectRef) });
    return { outcome: 'bytes', bytes: objects.get(objectRef) };
  };

  let encounteredError;
  let manifestRead = readObject('manifest');
  if (manifestRead.outcome === 'transient_error') {
    encounteredError = { code: 'RESOURCE_NOT_READY', classification: 'retryable' };
    manifestRead = readObject('manifest');
  }
  if (manifestRead.outcome !== 'bytes') {
    return {
      outcome: 'rejected',
      error: { code: 'RESOURCE_READ_FAILED', classification: 'permanent' },
      trace,
    };
  }
  if (hash(manifestRead.bytes, 'sha256') !== materialization.resource.manifest_sha256) {
    return {
      outcome: 'rejected',
      error: { code: 'OBJECT_DIGEST_MISMATCH', classification: 'permanent' },
      trace,
    };
  }
  const manifest = JSON.parse(manifestRead.bytes.toString('utf8'));
  const rows = [];
  for (const file of manifest.files) {
    const objectRead = readObject(file.object_ref);
    if (objectRead.outcome !== 'bytes') {
      return {
        outcome: 'rejected',
        error: { code: 'RESOURCE_READ_FAILED', classification: 'permanent' },
        trace,
      };
    }
    if (hash(objectRead.bytes, 'sha256') !== file.sha256) {
      return {
        outcome: 'rejected',
        error: { code: 'OBJECT_DIGEST_MISMATCH', classification: 'permanent' },
        trace,
      };
    }
    for (const line of objectRead.bytes.toString('utf8').trimEnd().split('\n')) {
      const row = JSON.parse(line);
      assert.equal(validateRow(row), true, JSON.stringify(validateRow.errors));
      rows.push(row);
    }
  }

  if (rows.length !== revision.row_count) {
    return { outcome: 'rejected', error: { code: 'ROW_COUNT_MISMATCH', classification: 'permanent' }, trace };
  }
  if (!require('node:util').isDeepStrictEqual(observedControlTotals(rows, revision.control_totals), revision.control_totals)) {
    return { outcome: 'rejected', error: { code: 'CONTROL_TOTAL_MISMATCH', classification: 'permanent' }, trace };
  }
  const canonicalBytes = canonicalReportBytes(rows, readJson(index.base_inputs.canonicalization).primary_keys, canonicalize);
  if (hash(canonicalBytes, 'sha256') !== revision.canonical_content_digest.value) {
    return { outcome: 'rejected', error: { code: 'CANONICAL_DIGEST_MISMATCH', classification: 'permanent' }, trace };
  }

  if (mutation.operation === 'inject_receipt_write_outcome') {
    encounteredError = { code: 'RECEIPT_WRITE_UNCERTAIN', classification: 'retryable' };
  }
  const receiptAsset = mutation.operation === 'use_receipt_asset'
    ? mutation.asset
    : scenario.expected_receipt.request_asset;
  const receipt = readJson(receiptAsset).receipts[0];
  return {
    outcome: receipt.status === 'rejected'
      ? 'rejected'
      : encounteredError ? 'accepted_after_retry' : 'accepted',
    error: encounteredError,
    trace,
  };
}

test('reporting reconciliation fixture is portable, byte-exact, and schema-valid', async () => {
  const canonicalize = (await import('canonicalize')).default;
  const index = readJson('scenario-index.json');
  const indexSchema = readJson('scenario-index.schema.json');

  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  const validateIndex = await ajv.compileAsync(indexSchema);
  assert.equal(validateIndex(index), true, JSON.stringify(validateIndex.errors));

  const validateManifest = await compileSchema('/schemas/core/reporting-file-manifest.json');
  const validateContract = await compileSchema('/schemas/core/reporting-canonicalization-contract.json');
  const validateReportDefinition = await compileSchema('/schemas/core/reporting-report-definition.json');
  const validateObligation = await compileSchema('/schemas/core/reporting-obligation.json');
  const validateRevision = await compileSchema('/schemas/core/reporting-revision.json');
  const validateMaterialization = await compileSchema('/schemas/core/reporting-materialization.json');
  const validateAdjustment = await compileSchema('/schemas/core/reporting-adjustment.json');
  const validateAdjustmentReceipt = await compileSchema('/schemas/core/reporting-adjustment-receipt.json');
  const validateCoverage = await compileSchema('/schemas/core/reporting-coverage.json');
  const validateReceiptRequest = await compileSchema('/schemas/media-buy/sync-reporting-receipts-request.json');
  const validateReceiptResponse = await compileSchema('/schemas/media-buy/sync-reporting-receipts-response.json');
  const rowAjv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(rowAjv);
  const validateRow = rowAjv.compile(readJson('row-schema.json'));

  const listedAssets = new Set(Object.keys(index.assets));
  const diskAssets = new Set();
  for (const directory of ['', 'receipts']) {
    const absolute = path.join(FIXTURE_ROOT, directory);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relative = path.posix.join(directory, entry.name);
      if (['README.md', 'scenario-index.json', 'scenario-index.schema.json'].includes(relative)) continue;
      diskAssets.add(relative);
    }
  }
  assert.deepEqual(listedAssets, diskAssets, 'asset catalog must cover every exact-byte fixture file');

  for (const [relative, expected] of Object.entries(index.assets)) {
    const bytes = fs.readFileSync(path.join(FIXTURE_ROOT, relative));
    assert.equal(bytes.length, expected.size_bytes, `${relative} byte length`);
    assert.equal(hash(bytes, 'sha256'), expected.sha256, `${relative} SHA-256`);
    assert.equal(hash(bytes, 'sha512'), expected.sha512, `${relative} SHA-512`);
  }

  const coverageVectors = readJson('coverage-aggregation.json').vectors;
  assert.deepEqual(
    coverageVectors.map(vector => vector.id),
    ['mixed_support_single_media_buy', 'empty_denominator'],
  );
  assert.equal(new Set(coverageVectors.map(vector => vector.id)).size, coverageVectors.length);
  for (const vector of coverageVectors) {
    assert.equal(
      validateCoverage(vector.expected_coverage),
      true,
      `${vector.id}: ${JSON.stringify(validateCoverage.errors)}`,
    );
  }

  const mixedCoverage = coverageVectors[0];
  assert.deepEqual(mixedCoverage.input.media_buy_ids, ['mb_mixed_support']);
  assert.deepEqual(mixedCoverage.input.package_ids, []);
  assert.deepEqual(mixedCoverage.input.period_slices.map(slice => slice.support), ['full', 'unsupported']);
  assert.equal(mixedCoverage.expected_coverage.status, 'partial');
  assert.deepEqual(mixedCoverage.expected_coverage.partially_covered_media_buy_ids, ['mb_mixed_support']);
  assert.deepEqual(mixedCoverage.expected_coverage.package_ids, []);

  const emptyCoverage = coverageVectors[1];
  assert.deepEqual(emptyCoverage.input.media_buy_ids, []);
  assert.deepEqual(emptyCoverage.input.package_ids, []);
  assert.deepEqual(emptyCoverage.input.period_slices, []);
  assert.equal(emptyCoverage.expected_coverage.status, 'full');

  const coverageSemantics = readSchema('/schemas/core/reporting-coverage.json')['x-adcp-validation'].status;
  const aggregationSemantics = readSchema('/schemas/media-buy/get-reporting-status-response.json')['x-adcp-validation'].coverage_aggregation;
  for (const semantics of [coverageSemantics, aggregationSemantics]) {
    assert.match(semantics, /partially covered media buy/);
    assert.match(semantics, /explicit empty denominator is full/);
    assert.match(semantics, /partially covered media buy counts as a covered item when excluding none and unknown/);
  }

  const contract = readJson('canonicalization.json');
  assert.equal(validateContract(contract), true, JSON.stringify(validateContract.errors));
  assert.equal(contract.schema_sha256, index.assets['row-schema.json'].sha256);

  const vectors = [
    contract.golden_vectors.empty_report,
    contract.golden_vectors.ordering_encoding,
    ...(contract.golden_vectors.additional ?? []),
  ];
  const names = vectors.map(vector => vector.name);
  assert.equal(new Set(names).size, names.length, 'golden-vector names must be unique');
  for (const purpose of ['empty_report', 'ordering_encoding']) {
    assert.equal(vectors.filter(vector => vector.purpose === purpose).length, 1);
  }
  const orderingVector = contract.golden_vectors.ordering_encoding;
  const sortedOrderingRows = [...orderingVector.input_rows].sort((left, right) => {
    const leftKey = Buffer.from(canonicalize(contract.primary_keys.map(key => left[key])));
    const rightKey = Buffer.from(canonicalize(contract.primary_keys.map(key => right[key])));
    return Buffer.compare(leftKey, rightKey);
  });
  assert.notDeepEqual(orderingVector.input_rows, sortedOrderingRows);
  assert.ok(orderingVector.input_rows.some(row => JSON.stringify(row) !== canonicalize(row)));
  for (const vector of vectors) {
    const declared = Buffer.from(vector.canonical_utf8_base64, 'base64');
    assert.equal(declared.toString('base64'), vector.canonical_utf8_base64, `${vector.name} base64`);
    assert.equal(hash(declared, 'sha256'), vector.sha256, `${vector.name} SHA-256`);
    assert.deepEqual(
      canonicalReportBytes(vector.input_rows, contract.primary_keys, canonicalize),
      declared,
      `${vector.name} canonical bytes`,
    );
  }

  const rows = fs.readFileSync(path.join(FIXTURE_ROOT, 'rows.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  for (const row of rows) assert.equal(validateRow(row), true, JSON.stringify(validateRow.errors));
  const canonicalBytes = canonicalReportBytes(rows, contract.primary_keys, canonicalize);
  assert.equal(canonicalBytes.toString('base64'), index.canonical_report.canonical_utf8_base64);
  assert.equal(hash(canonicalBytes, 'sha256'), index.canonical_report.sha256);
  assert.equal(rows.length, index.canonical_report.row_count);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.impressions), 0), 5);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.spend), 0).toFixed(2), '8.00');

  assert.deepEqual(
    index.canonical_report.physical_checksums.map(checksum => checksum.algorithm).sort(),
    ['sha256', 'sha512'],
  );
  for (const checksum of index.canonical_report.physical_checksums) {
    const bytes = fs.readFileSync(path.join(FIXTURE_ROOT, checksum.object_ref));
    assert.equal(hash(bytes, checksum.algorithm), checksum.value);
  }

  assert.equal(index.publish_order.at(-1), 'manifest.json', 'manifest must publish last');
  const validManifest = readJson('manifest.json');
  for (const entry of validManifest.files) {
    const publishedAt = index.publish_order.indexOf(entry.object_ref);
    assert.ok(publishedAt >= 0, `${entry.object_ref} must appear in publish_order`);
    assert.ok(publishedAt < index.publish_order.length - 1, `${entry.object_ref} must publish before manifest`);
  }

  for (const asset of Object.values(index.base_inputs)) {
    assert.ok(listedAssets.has(asset), `base input must be cataloged: ${asset}`);
  }
  const reportDefinition = readJson(index.base_inputs.report_definition);
  const obligation = readJson(index.base_inputs.obligation);
  const revision = readJson(index.base_inputs.revision);
  const materialization = readJson(index.base_inputs.materialization);
  const adjustment = readJson(index.base_inputs.adjustment);
  assert.equal(validateReportDefinition(reportDefinition), true, JSON.stringify(validateReportDefinition.errors));
  assert.equal(validateObligation(obligation), true, JSON.stringify(validateObligation.errors));
  assert.equal(obligation.reconciliation_status, 'pending');
  assert.equal(obligation.health, 'waiting');
  assert.equal(obligation.receipt_count, 0);
  assert.equal(obligation.accepted_receipt_count, 0);
  assert.equal(validateRevision(revision), true, JSON.stringify(validateRevision.errors));
  assert.equal(validateMaterialization(materialization), true, JSON.stringify(validateMaterialization.errors));
  assert.equal(validateAdjustment(adjustment), true, JSON.stringify(validateAdjustment.errors));
  assert.equal(adjustment.adjusts_reporting_revision_id, revision.reporting_revision_id);
  const adjustmentForDigest = structuredClone(adjustment);
  delete adjustmentForDigest.canonical_adjustment_sha256;
  assert.equal(hash(Buffer.from(canonicalize(adjustmentForDigest)), 'sha256'), adjustment.canonical_adjustment_sha256);
  assert.equal(new Set(adjustment.control_total_deltas.map(total => total.name)).size, adjustment.control_total_deltas.length);
  assert.equal(revision.report_definition_sha256, index.assets[index.base_inputs.report_definition].sha256);
  assert.equal(revision.schema_sha256, index.assets[index.base_inputs.row_schema].sha256);
  assert.equal(revision.canonical_content_digest.canonicalization_sha256, index.assets[index.base_inputs.canonicalization].sha256);
  assert.equal(materialization.resource.manifest_sha256, index.assets[index.base_inputs.manifest].sha256);
  assert.equal(validManifest.reporting_obligation_id, obligation.reporting_obligation_id);
  assert.equal(validManifest.reporting_revision_id, revision.reporting_revision_id);
  assert.equal(validManifest.reporting_materialization_id, materialization.reporting_materialization_id);
  assert.deepEqual(validManifest.period, obligation.period);
  assert.deepEqual(validManifest.period, revision.period);
  assert.ok(Date.parse(validManifest.created_at) < Date.parse(readJson('receipts/accepted-request.json').receipts[0].observed_at));

  const adjustmentReceiptRequest = readJson(index.post_official_adjustment.accepted_receipt_request_asset);
  const adjustmentReceiptResponse = readJson(index.post_official_adjustment.accepted_receipt_response_asset);
  assert.equal(validateReceiptRequest(adjustmentReceiptRequest), true, JSON.stringify(validateReceiptRequest.errors));
  assert.equal(validateReceiptResponse(adjustmentReceiptResponse), true, JSON.stringify(validateReceiptResponse.errors));
  const submittedAdjustmentReceipt = adjustmentReceiptRequest.adjustment_receipts[0];
  assert.equal(validateAdjustmentReceipt(submittedAdjustmentReceipt), true, JSON.stringify(validateAdjustmentReceipt.errors));
  assert.equal(submittedAdjustmentReceipt.reporting_adjustment_id, adjustment.reporting_adjustment_id);
  assert.equal(submittedAdjustmentReceipt.observed_adjustment_sha256, adjustment.canonical_adjustment_sha256);
  assert.equal(adjustmentReceiptResponse.results[0].result, 'recorded');
  assert.deepEqual(
    adjustmentReceiptResponse.results[0].adjustment_receipt,
    { ...submittedAdjustmentReceipt, received_at: '2026-08-29T10:01:01Z' },
  );
  assert.equal(index.post_official_adjustment.invoice_anchor_revision_id, revision.reporting_revision_id);
  assert.equal(index.post_official_adjustment.original_revision_and_receipt_immutable, true);

  for (const manifestPath of ['manifest.json']) {
    const manifest = readJson(manifestPath);
    assert.equal(validateManifest(manifest), true, `${manifestPath}: ${JSON.stringify(validateManifest.errors)}`);
    assert.equal(manifest.total_size_bytes, manifest.files.reduce((sum, file) => sum + file.size_bytes, 0));
    assert.equal(manifest.row_count, manifest.files.reduce((sum, file) => sum + file.row_count, 0));
  }

  const receiptAssets = [
    ['receipts/accepted-request.json', validateReceiptRequest],
    ['receipts/rejected-request.json', validateReceiptRequest],
    ['receipts/accepted-recorded-response.json', validateReceiptResponse],
    ['receipts/accepted-unchanged-response.json', validateReceiptResponse],
    ['receipts/rejected-recorded-response.json', validateReceiptResponse],
  ];
  for (const [relative, validate] of receiptAssets) {
    assert.equal(validate(readJson(relative)), true, `${relative}: ${JSON.stringify(validate.errors)}`);
  }
  assertReceiptAcknowledgement(
    readJson('receipts/accepted-request.json'),
    readJson('receipts/accepted-recorded-response.json'),
    'recorded',
  );
  assertReceiptAcknowledgement(
    readJson('receipts/accepted-request.json'),
    readJson('receipts/accepted-unchanged-response.json'),
    'unchanged',
  );
  assertReceiptAcknowledgement(
    readJson('receipts/rejected-request.json'),
    readJson('receipts/rejected-recorded-response.json'),
    'recorded',
  );

  const scenarioIds = index.scenarios.map(scenario => scenario.id);
  assert.equal(new Set(scenarioIds).size, scenarioIds.length, 'scenario IDs must be unique');
  const expectedMatrix = {
    valid: { operation: 'none', outcome: 'accepted' },
    missing_file: { operation: 'remove_object', outcome: 'rejected', error: { code: 'RESOURCE_READ_FAILED', classification: 'permanent' } },
    checksum_mismatch: { operation: 'xor_byte', outcome: 'rejected', error: { code: 'OBJECT_DIGEST_MISMATCH', classification: 'permanent' } },
    row_count_mismatch: { operation: 'replace_json_pointer', pointer: '/row_count', outcome: 'rejected', error: { code: 'ROW_COUNT_MISMATCH', classification: 'permanent' } },
    control_total_mismatch: { operation: 'replace_json_pointer', pointer: '/control_totals/0/value', outcome: 'rejected', error: { code: 'CONTROL_TOTAL_MISMATCH', classification: 'permanent' } },
    canonical_digest_mismatch: { operation: 'replace_json_pointer', pointer: '/canonical_content_digest/value', outcome: 'rejected', error: { code: 'CANONICAL_DIGEST_MISMATCH', classification: 'permanent' } },
    retry: { operation: 'inject_read_error', outcome: 'accepted_after_retry', error: { code: 'RESOURCE_NOT_READY', classification: 'retryable' } },
    checkpoint: { operation: 'inject_receipt_write_outcome', outcome: 'accepted_after_retry', error: { code: 'RECEIPT_WRITE_UNCERTAIN', classification: 'retryable' } },
    rejected_receipt: { operation: 'use_receipt_asset', outcome: 'rejected' },
  };
  assert.deepEqual(new Set(scenarioIds), new Set(Object.keys(expectedMatrix)));
  for (const scenario of index.scenarios) {
    const expected = expectedMatrix[scenario.id];
    assert.equal(scenario.mutation.operation, expected.operation, `${scenario.id} mutation operation`);
    if (expected.pointer) assert.equal(scenario.mutation.pointer, expected.pointer, `${scenario.id} mutation pointer`);
    for (const read of scenario.resource_reads) {
      if (read.asset) assert.ok(listedAssets.has(read.asset), `${scenario.id} read asset is cataloged`);
    }
    if (scenario.mutation.asset) assert.ok(listedAssets.has(scenario.mutation.asset), `${scenario.id} mutation asset`);
    for (const field of ['request_asset', 'acknowledgement_asset', 'replay_acknowledgement_asset']) {
      const asset = scenario.expected_receipt[field];
      if (asset) assert.ok(listedAssets.has(asset), `${scenario.id} ${field} is cataloged`);
    }
    const actual = executeScenario(index, scenario, canonicalize, validateRow);
    assert.deepEqual(actual.trace, scenario.resource_reads, `${scenario.id} executable read trace`);
    assert.equal(actual.trace.length, scenario.expected_resource_read_count, `${scenario.id} executed read count`);
    assert.equal(actual.outcome, scenario.expected_outcome, `${scenario.id} executable outcome`);
    assert.equal(actual.outcome, expected.outcome, `${scenario.id} pinned outcome`);
    assert.deepEqual(actual.error, scenario.expected_error, `${scenario.id} executable error`);
    assert.deepEqual(actual.error, expected.error, `${scenario.id} pinned error classification`);
  }

  const rejected = index.scenarios.find(scenario => scenario.id === 'rejected_receipt');
  assert.deepEqual(rejected.expected_receipt.rejection_codes, ['ROW_COUNT_MISMATCH']);
  assert.equal(readJson(rejected.expected_receipt.request_asset).receipts[0].status, 'rejected');

  const uncertain = index.scenarios.find(scenario => scenario.id === 'checkpoint');
  assert.equal(uncertain.expected_error.classification, 'retryable');
  assert.equal(uncertain.expected_receipt.write_attempts, 2);
  assert.equal(uncertain.expected_receipt.first_write_response, 'lost_after_commit');
  assert.equal(uncertain.expected_receipt.acknowledgement_asset, 'receipts/accepted-unchanged-response.json');
  assert.deepEqual(uncertain.checkpoint_events, [
    'inspection_complete',
    'receipt_write_started',
    'receipt_write_outcome_uncertain',
    'resume_with_same_receipt',
  ]);
});
