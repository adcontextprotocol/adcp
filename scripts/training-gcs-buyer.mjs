#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import { SingleAgentClient, canonicalize, closeMCPConnections } from '@adcp/sdk';
import { createGcsReportingResourceReaderV1, createGcsReportingReferenceResolverV1 } from '@adcp/sdk/reporting/gcs';
import { createPostgresReportingConsumerRuntimeV1, reconcileReporting } from '@adcp/sdk/reporting/consumer';

/** Uses buyer-owned credentials/state and saved grants, never producer echoes. */
export async function verifyTrainingGcsBuyer({ grant, expected, storage, client, persistence, consumerScope, authorize }) {
  const scope = { principal_id: grant.principal_id, account_id: grant.account_id, destination_ref: grant.destination_ref, generation: grant.generation };
  const reader = objectPrefix => ({
    scope, bucket: grant.bucket, objectPrefix, getStorage: async () => storage,
    operationDeadlineMilliseconds: 30_000, maxBytes: 4 * 1024 * 1024,
    authorize: async request => canonicalize(request.scope) === canonicalize(scope)
      && request.bucket === grant.bucket && request.objectPrefix === objectPrefix && await authorize(grant),
  });
  return reconcileReporting({
    client, request: { account: { account_id: grant.account_id }, delivery_config_ids: [expected.deliveryConfigId], period: { start: expected.periodStart, end: expected.periodEnd } },
    expectedPeriods: [expected], resourceReader: createGcsReportingResourceReaderV1(reader(grant.object_prefix)),
    manifestInspectorOptions: { referenceResolver: createGcsReportingReferenceResolverV1(reader(grant.contract_prefix)),
      referenceAllowedOrigins: ['https://storage.googleapis.com'], maxTotalBytes: 4 * 1024 * 1024, maxObjectBytes: 4 * 1024 * 1024, maxInspectionMs: 30_000 },
    checkpointStore: persistence.checkpointStore, checkpointScope: consumerScope,
    pendingConsumerStatusStore: persistence.pendingConsumerStatusStore, pendingConsumerStatusScope: consumerScope,
  });
}

/** A 403 or a current tombstone is not a revoked native generation 404. */
export async function probeRevokedTrainingGenerations(storage, grant, materializations) {
  const resources = materializations.map(item => item.resource).filter(Boolean);
  if (!resources.length) throw new Error('No pre-revocation native generations were captured.');
  for (const resource of resources) {
    const uri = new URL(resource.location);
    const prefix = `/${grant.bucket}/${grant.object_prefix}`;
    if (uri.origin !== 'https://storage.googleapis.com' || uri.username || uri.password || uri.search || uri.hash
      || uri.pathname.includes('%') || !uri.pathname.startsWith(prefix) || resource.immutability !== 'native_version'
      || !/^[0-9]+$/.test(resource.native_version_ref)) throw new Error('Resource differs from the saved native grant.');
    try {
      await storage.bucket(grant.bucket).file(uri.pathname.slice(grant.bucket.length + 2), { generation: resource.native_version_ref }).getMetadata();
    } catch (error) {
      if (error?.code === 404) continue;
      throw new Error('Native generation probe did not return 404.');
    }
    throw new Error('A revoked native generation is still readable.');
  }
  return { native_generations_404: resources.length };
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, init: { type: 'boolean' }, provisioning: { type: 'string' }, day: { type: 'string' },
    evidence: { type: 'string' },
    command: { type: 'string', default: 'verify' }, agent: { type: 'string', default: 'https://test-agent.adcontextprotocol.org/sales' },
  } });
  if (values.help) {
    console.log('node scripts/training-gcs-buyer.mjs --provisioning <saved-private-grant.json> --day YYYY-MM-DD --evidence <file> [--init] [--command verify|replay|revoked-404]\nUses the training agent MCP endpoint. Requires TRAINING_BUYER_TOKEN, TRAINING_BUYER_GCS_CREDENTIALS_FILE (keyless external_account), and TRAINING_BUYER_DATABASE_URL (buyer-owned; verify only).');
    return;
  }
  if (!values.provisioning || !values.evidence || !['verify', 'replay', 'revoked-404'].includes(values.command)
    || !process.env.TRAINING_BUYER_GCS_CREDENTIALS_FILE) throw new Error('Required buyer configuration is missing.');
  const saved = JSON.parse(await readFile(values.provisioning, 'utf8'));
  const { grant } = saved;
  if (!grant || !/^workos:.+$/.test(grant.principal_id) || grant.generation !== 1
    || !grant.object_prefix?.endsWith('/') || !grant.contract_prefix?.endsWith('/')) throw new Error('Invalid trusted provisioning snapshot.');
  const credentials = JSON.parse(await readFile(process.env.TRAINING_BUYER_GCS_CREDENTIALS_FILE, 'utf8'));
  if (credentials.type !== 'external_account') throw new Error('Buyer requires a dedicated keyless credential configuration.');
  const storage = new Storage({ projectId: 'adcp-production', keyFilename: process.env.TRAINING_BUYER_GCS_CREDENTIALS_FILE,
    timeout: 10_000, retryOptions: { totalTimeout: 30, maxRetries: 2 } });
  if (values.command === 'revoked-404') {
    const evidence = JSON.parse(await readFile(values.evidence, 'utf8'));
    if (canonicalize(evidence.grant) !== canonicalize(grant)) throw new Error('Evidence belongs to another saved grant.');
    console.log(JSON.stringify(await probeRevokedTrainingGenerations(storage, grant, evidence.materializations)));
    return;
  }
  const url = new URL(values.agent);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !process.env.TRAINING_BUYER_TOKEN) throw new Error('Authenticated HTTPS agent is required.');
  const base = url.href.replace(/\/$/, '');
  const authorize = async () => {
    const response = await fetch(`${base}/reporting/destinations/${encodeURIComponent(grant.account_id)}/${encodeURIComponent(grant.destination_ref)}`, {
      headers: { Authorization: `Bearer ${process.env.TRAINING_BUYER_TOKEN}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const current = await response.json();
    return canonicalize(current.grant) === canonicalize(grant);
  };
  if (!await authorize()) throw new Error('Saved grant is no longer authorized.');
  const agent = new SingleAgentClient({ id: 'training-gcs-buyer', name: 'Private training GCS buyer', agent_uri: base,
    protocol: 'mcp', auth_token: process.env.TRAINING_BUYER_TOKEN }, { adcpVersion: '3.2.1', wireAdcpVersion: '3.2' });
  const receiptBatches = [];
  const statusBatches = [];
  const call = async (tool, params, options) => {
    if (tool === 'sync_reporting_receipts') receiptBatches.push(structuredClone(params));
    if (tool === 'sync_reporting_status') statusBatches.push(structuredClone(params));
    const result = await agent.executeTask(tool, params, undefined, { signal: options?.signal ?? AbortSignal.timeout(30_000) });
    if (!result.success || result.status !== 'completed' || result.data?.errors?.length) throw new Error('Buyer protocol operation failed.');
    return result.data;
  };
  const client = { getReportingStatus: (p, o) => call('get_reporting_status', p, o), getMediaBuyDelivery: (p, o) => call('get_media_buy_delivery', p, o),
    syncReportingReceipts: (p, o) => call('sync_reporting_receipts', p, o), syncReportingStatus: (p, o) => call('sync_reporting_status', p, o) };
  let pool;
  try {
    if (values.command === 'replay') {
      const evidence = JSON.parse(await readFile(values.evidence, 'utf8'));
      if (canonicalize(evidence.grant) !== canonicalize(grant)) throw new Error('Evidence belongs to another saved grant.');
      for (const params of evidence.receipt_batches) {
        const response = await client.syncReportingReceipts(params);
        if (response.results?.some(item => item.result === 'failed')) throw new Error('Duplicate receipt was refused.');
      }
      for (const params of evidence.status_batches) await client.syncReportingStatus(params);
      console.log(JSON.stringify({ duplicate_batches_replayed: evidence.receipt_batches.length + evidence.status_batches.length }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.day ?? '')) throw new Error('Select a closed UTC day independently.');
    const start = new Date(`${values.day}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    if (start.toISOString().slice(0, 10) !== values.day || start < new Date(saved.buyer.installed_at) || end > new Date()) throw new Error('Select an eligible closed day after installation.');
    const expected = { ...saved.buyer.expected, periodStart: start.toISOString(), periodEnd: end.toISOString() };
    if (expected.verificationProfile !== 'canonical_digest' || !expected.canonicalization) throw new Error('Saved canonical pins are required.');
    const databaseUrl = process.env.TRAINING_BUYER_DATABASE_URL;
    if (!databaseUrl || databaseUrl === process.env.DATABASE_URL || databaseUrl === process.env.DATABASE_PRIVATE_URL) throw new Error('Buyer-owned PostgreSQL must differ from the application database.');
    pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000,
      options: '-c search_path=training_reporting_buyer,pg_catalog -c statement_timeout=30000 -c lock_timeout=5000' });
    const persistence = createPostgresReportingConsumerRuntimeV1({ db: pool, namespace: 'training-gcs-canary-buyer-v1', tablePrefix: 'training_gcs_buyer' });
    if (values.init) { await pool.query('CREATE SCHEMA IF NOT EXISTS training_reporting_buyer'); for (const sql of persistence.migrations.all) await pool.query(sql); }
    await persistence.probe();
    const result = await verifyTrainingGcsBuyer({ grant, expected, storage, client, persistence, consumerScope: `${base}:${grant.principal_id}`, authorize });
    const evidence = { sdk: '15.2.0', protocol: 'mcp', checked_at: new Date().toISOString(), grant,
      definitive: result.definitive, receipt_batches: receiptBatches, status_batches: statusBatches,
      receipts: result.submittedReceipts, materializations: result.ledger.materializations,
      obligations: result.obligations, failed_consumer_statuses: result.failedConsumerStatuses };
    await writeFile(values.evidence, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    if (!result.definitive || result.failedConsumerStatuses.length) throw new Error('Buyer verification is not definitive; inspect retained evidence and repair by authenticated polling.');
    console.log(JSON.stringify({ definitive: true, receipts: result.submittedReceipts.length, evidence: values.evidence }));
  } finally { await pool?.end(); await closeMCPConnections(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Training GCS buyer failed. Check private configuration and retained evidence; credentials are not printed.'); process.exitCode = 1; });
}
