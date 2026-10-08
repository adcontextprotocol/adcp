/** Real PostgreSQL/HTTP MCP with modeled Storage and WorkOS ports; NOT provider qualification. */
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import express from 'express';
import { SingleAgentClient, closeMCPConnections } from '@adcp/sdk';
import { Pool } from 'pg';
import type { Storage } from '@google-cloud/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReportingSourceSliceRequestV1Schema, reportingCoverageDenominatorFingerprintV1, parseVerifiedReportingSourceManifestV1, validateReportingSourceExecutionV1 } from '@adcp/sdk/reporting/source';
import { PostgresReportingLedgerStore, PostgresReportingManagedDeliveryStore, REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION } from '@adcp/sdk/reporting/ledger';
import { createPostgresReportingConsumerRuntimeV1 } from '@adcp/sdk/reporting/consumer';
import { verifyTrainingGcsBuyer, probeRevokedTrainingGenerations } from '../../../scripts/training-gcs-buyer.mjs';
import { committedTrainingSourceExecutor, sha256, trainingConstituents, trainingGcsAdapter } from '../../src/training-agent/gcs-reporting-source.js';
import { obligationId } from '../../src/training-agent/reporting-reliability.js';
import { TRAINING_REPORTING_SCHEMA } from '../../src/training-agent/gcs-reporting-config.js';

const shared = vi.hoisted(() => ({ pool: undefined as Pool | undefined, runtime: undefined as unknown }));
vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_reporting_transport';
  process.env.WORKOS_CLIENT_ID = 'client_test_reporting_transport';
});
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  apiKeys = { createValidation: async ({ value }: { value: string }) => ({
    apiKey: value === 'sk_private_reporting_transport' ? { owner: { id: 'test-private' } } : null,
  }) };
} }));
vi.mock('../../src/db/client.js', () => ({ isDatabaseInitialized: () => !!shared.pool, getPool: () => shared.pool }));
vi.mock('../../src/training-agent/gcs-reporting.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/training-agent/gcs-reporting.js')>(),
  getTrainingGcsReporting: () => shared.runtime,
}));
const { TrainingGcsReporting } = await import('../../src/training-agent/gcs-reporting.js');
const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');

const testUrl = process.env.TRAINING_GCS_TEST_DATABASE_URL;
const config = { bucket: 'training-gcs-modeled-test', namespace: 'training-gcs:test-v1', credentialsFile: '/unused', canaryPrincipal: 'workos:test-private' };
const accountId = 'gcs_account_a';
const mediaBuyId = 'gcs_buy_a';
const period = { start: '2026-10-04T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' };
let db: Pool;
let host: Awaited<ReturnType<typeof TrainingGcsReporting.create>>;
let capturedMaterializations: unknown[];

/** A deterministic test port; modeled generations are never represented as actual GCS evidence. */
function storagePort() {
  const files = new Map<string, { bytes: Buffer; metadata: Record<string, unknown>; generation: string }>();
  let generation = 0;
  const bucket = {
    getMetadata: async () => [{ iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' }, softDeletePolicy: { retentionDurationSeconds: '0' } }],
    file: (name: string, selection?: { generation?: string | number }) => {
      const current = () => {
        const item = files.get(name);
        if (!item || (selection?.generation && String(selection.generation) !== item.generation)) throw Object.assign(new Error('modeled missing object'), { code: 404 });
        return item;
      };
      return {
        getMetadata: async () => { const item = current(); return [{ ...item.metadata, generation: item.generation, size: String(item.bytes.length) }]; },
        download: async () => [current().bytes],
        createReadStream: () => { try { return Readable.from([current().bytes]); } catch (error) { return new Readable({ read() { this.destroy(error as Error); } }); } },
        save: async (body: Buffer | string, options: { preconditionOpts?: { ifGenerationMatch?: number | string }; metadata?: Record<string, unknown> } = {}) => {
          const before = files.get(name);
          const precondition = options.preconditionOpts?.ifGenerationMatch;
          if (precondition !== undefined && (String(precondition) === '0' ? !!before : before?.generation !== String(precondition))) throw Object.assign(new Error('modeled create conflict'), { code: 412 });
          files.set(name, { bytes: Buffer.from(body), metadata: options.metadata ?? {}, generation: String(++generation) });
        },
        delete: async () => { current(); files.delete(name); },
      };
    },
  };
  return { storage: { bucket: () => bucket } as unknown as Storage, files };
}
const provider = storagePort();

describe.skipIf(!testUrl)('training GCS reporting against disposable PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/training_gcs_tests') throw new Error('Tests require the dedicated local training_gcs_tests database.');
    db = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000,
      options: `-c search_path=${TRAINING_REPORTING_SCHEMA},pg_catalog -c statement_timeout=30000 -c lock_timeout=5000` });
    shared.pool = new Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 5000, options: '-c statement_timeout=30000' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DROP SCHEMA IF EXISTS ${TRAINING_REPORTING_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TRAINING_REPORTING_SCHEMA}`);
      await client.query(await readFile(new URL('../../src/db/migrations/619_training_gcs_reporting.sql', import.meta.url), 'utf8'));
      const legacy = await readFile(new URL('../../src/db/migrations/575_reporting_reliability_curriculum.sql', import.meta.url), 'utf8');
      await client.query('SET LOCAL search_path=public,pg_catalog');
      await client.query(legacy.slice(0, legacy.indexOf('UPDATE certification_modules')));
      await client.query('TRUNCATE public.training_reporting_ledgers');
      for (const migration of ['416_adcp_idempotency.sql', '549_idempotency_retention_boundary.sql']) {
        await client.query(await readFile(new URL(`../../src/db/migrations/${migration}`, import.meta.url), 'utf8'));
      }
      await client.query('TRUNCATE public.adcp_idempotency');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const sourceConfig = { delivery_config_id: 'source-daily', delivery_config_version: 1, offering_id: 'analytics-daily-managed', active: true, scope: { media_buy_ids: [mediaBuyId] } };
    const obligation = obligationId(accountId, sourceConfig, period.end);
    const revision = { reporting_revision_id: 'source-revision-a', period, coverage: { status: 'full', media_buy_ids: [mediaBuyId] }, created_at: period.end };
    const ledger = {
      version: 1, history: [{ config: sourceConfig, activatedAt: period.start, activeWindows: [{ start: period.start }] }], current_generation_keys: ['source-daily\u001f1'],
      published_revisions: [[obligation, revision]],
      revision_contents: [[revision.reporting_revision_id, { revision, rows: [{ period_start: period.start, period_end: period.end, impressions: 123 }] }]],
    };
    await db.query(`INSERT INTO public.training_reporting_ledgers(principal_scope,account_id,ledger,account_scope,account_ref,account_state)
      VALUES ($1,$2,$3,$4,$5,$6)`, [config.canaryPrincipal, accountId, ledger, `a:${accountId}`, { account_id: accountId }, { currency: 'USD' }]);
    host = await TrainingGcsReporting.create(config, db, provider.storage);
  }, 30_000);
  afterAll(async () => { await shared.pool?.end(); shared.pool = undefined; if (host) await host.stop(); else await db?.end(); });

  it('probes Core, Managed, notification and installation authority on the same pool', async () => {
    expect(await host.probe()).toBe(true);
    const core = new PostgresReportingLedgerStore(db, { acknowledgeIsolatedDatabase: true, managedDelivery: true });
    const managed = new PostgresReportingManagedDeliveryStore(db);
    expect(await managed.probe(core)).toBe(true);
    const before = await managed.getObjectWriteAuthorityId();
    await db.query(REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION);
    expect(await managed.getObjectWriteAuthorityId()).toBe(before);
  });
  it('provisions immutable authenticated grants and replays provisioning after partial failure', async () => {
    await expect(host.provision('static:public', accountId, 'source-daily', 'destination-a')).rejects.toThrow();
    // Establish a historical installation fixture; worker and PostgreSQL clocks stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(period.start));
    let grant;
    try { grant = await host.provision(config.canaryPrincipal, accountId, 'source-daily', 'destination-a'); }
    finally { vi.useRealTimers(); }
    expect(grant.object_prefix).toMatch(/^adcp-reporting\/[a-f0-9]{64}\/[a-f0-9]{64}\/$/);
    const binding = await host.service.stores.managed.getAuthorizedObjectWriteBinding({ account_id: accountId, destination_ref: 'destination-a', generation: 1 });
    expect(grant.object_prefix).toContain(binding!.namespace_key);
    expect(await host.provision(config.canaryPrincipal, accountId, 'source-daily', 'destination-a')).toEqual(grant);
    await expect(host.provision(config.canaryPrincipal, accountId, 'source-daily', 'destination-b')).rejects.toThrow('pinned destination');
    expect(await host.grant('workos:other', accountId, 'destination-a', 1)).toBeNull();
  });
  it('retains real source rows and manifest bytes across executor reconstruction', async () => {
    const offering = trainingGcsAdapter(db, config.bucket, host.contractPrefix).sourceOffering;
    const constituents = trainingConstituents([mediaBuyId]);
    const request = ReportingSourceSliceRequestV1Schema.parse({
      contractVersion: '1.0', identity: { sourceExecutionKey: 'source-replay', logicalSliceFingerprint: `sha256:${sha256('source-replay')}` },
      sourceScope: { principal_id: config.canaryPrincipal, source_config_id: 'source-daily', source_config_version: 1 }, account: { account_id: accountId },
      delivery_config_id: 'gcs:source-daily', delivery_config_version: 1, report_definition_id: offering.contract.report_definition_id, reporting_obligation_id: 'test-obligation',
      adapterBuild: offering.adapterBuild, offeringId: offering.offeringId, publicationNamespace: offering.publicationNamespace, publicationClass: offering.publicationClass, contract: offering.contract,
      period: { periodKey: period.start.slice(0, 10), sourceLocalDate: period.start.slice(0, 10), ...period, sourceTimezone: 'UTC', sourceReadCutoffAt: period.end, grain: offering.grain, windowing: offering.windowing },
      finality: { revisionKind: 'snapshot' }, trigger: { kind: 'scheduled_poll', id: 'test-trigger' }, sourceRequest: { groupIds: [] },
      coverage: { expected: 'full', constituents, productIds: ['training-reporting-ledger'], mediaBuyIds: [mediaBuyId], packageIds: [], denominatorFingerprint: reportingCoverageDenominatorFingerprintV1(constituents) },
      requestedMetrics: ['impressions'], requestedDimensions: [],
      sourceSettings: { currency: 'USD', attributionModel: 'source_default', attributionWindow: 'source_default', sourceSettingsVersion: '1', sourceSettingsSha256: sha256('test-settings'), settingsSnapshotRef: 'test-settings' },
      deadline: { deadlineAt: '2099-01-01T00:00:00.000Z', cancellationIdentity: 'test-cancellation' },
    });
    const first = await committedTrainingSourceExecutor(db, offering).execute(request, { signal: new AbortController().signal });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Source did not complete.');
    const replay = await committedTrainingSourceExecutor(db, offering).execute(request, { signal: new AbortController().signal });
    expect(replay).toEqual(first);
    await validateReportingSourceExecutionV1({ level: 'basic', capabilities: committedTrainingSourceExecutor(db, offering).capabilities, request, result: first, objectReader: committedTrainingSourceExecutor(db, offering) });
    const manifest = parseVerifiedReportingSourceManifestV1(first.response.manifest!, first.manifestBytes, 'basic');
    expect(manifest.rowCount).toBe(1);
    const object = manifest.objects[0];
    const readerInput = { objectRef: object.objectRef, objectGeneration: object.objectGeneration, sourceScope: request.sourceScope, account: request.account, delivery_config_id: request.delivery_config_id, delivery_config_version: request.delivery_config_version, report_definition_id: request.report_definition_id, reporting_obligation_id: request.reporting_obligation_id, maxBytes: 1024, signal: new AbortController().signal };
    const reader = committedTrainingSourceExecutor(db, offering);
    expect(JSON.parse(Buffer.from(await reader.read(readerInput)).toString())).toEqual({ impressions: 123, period_end: period.end, period_start: period.start });
    await expect(reader.read({ ...readerInput, account: { account_id: 'other' } })).rejects.toThrow();
    await expect(reader.read({ ...readerInput, report_definition_id: 'other_definition' })).rejects.toThrow();
    await expect(reader.read({ ...readerInput, maxBytes: 1 })).rejects.toThrow();
    await expect(reader.execute({ ...request, identity: { ...request.identity, logicalSliceFingerprint: `sha256:${sha256('conflicting')}` } }, { signal: new AbortController().signal })).rejects.toThrow('identity conflict');
    await expect(reader.execute({ ...request, account: { account_id: 'other' } }, { signal: new AbortController().signal })).rejects.toThrow('identity conflict');
    const missing = await reader.execute({ ...request, identity: { sourceExecutionKey: 'uncommitted', logicalSliceFingerprint: `sha256:${sha256('uncommitted')}` }, period: { ...request.period, start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' } }, { signal: new AbortController().signal });
    expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_READY', retry: 'retryable' } });
  });
  it('runs the actual source producer and managed lifecycle without using synthetic provider evidence', async () => {
    const cycle = await host.service.runCycle({ accountId, maxObligations: 4, maxWorkerIterations: 1 });
    expect(cycle.core.revisionsCommitted).toBeGreaterThan(0);
    expect(cycle.managed.delivered).toBeGreaterThan(0);
    const response = await host.service.platform.getReportingStatus({ account: { account_id: accountId }, view: 'periods', period }, { account: { id: accountId }, authInfo: { clientId: config.canaryPrincipal } } as never);
    expect(response.errors).toBeUndefined();
    expect(response).toMatchObject({ status: 'completed' });
    // Poll the selected period explicitly; the SDK's default 24-hour view does
    // not include this historical fixture's materialization.
    await vi.waitFor(async () => {
      const polled = await host.service.platform.getReportingStatus({ account: { account_id: accountId }, view: 'periods', period }, { account: { id: accountId }, authInfo: { clientId: config.canaryPrincipal } } as never);
      expect(polled.materializations?.some(item => item.status === 'available')).toBe(true);
    }, { timeout: 5000, interval: 50 });
  });
  it('uses the official MCP buyer to inspect bytes, commit a durable receipt and replay the exact retry', async () => {
    const grant = (await host.grant(config.canaryPrincipal, accountId, 'destination-a', 1))!;
    const pins = await host.buyerConfiguration(config.canaryPrincipal, accountId, 'destination-a');
    const persistence = createPostgresReportingConsumerRuntimeV1({ db, namespace: 'local-modeled-buyer', tablePrefix: 'test_training_buyer' });
    for (const sql of persistence.migrations.all) await db.query(sql);
    await persistence.probe();
    const context = { account: { id: accountId }, authInfo: { clientId: config.canaryPrincipal } } as never;
    const batches: Parameters<NonNullable<typeof host.service.platform.syncReportingReceipts>>[0][] = [];
    shared.runtime = host;
    const app = express();
    app.use(express.json());
    app.use(createTrainingAgentRouter({ disableRateLimit: true }));
    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => httpServer.once('listening', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Local MCP listener was not established.');
    const agent = new SingleAgentClient({ id: 'local-modeled-buyer-mcp', name: 'Local modeled GCS buyer',
      agent_uri: `http://127.0.0.1:${address.port}/sales`, protocol: 'mcp', auth_token: 'sk_private_reporting_transport' },
    { adcpVersion: '3.2.1', wireAdcpVersion: '3.2' });
    const call = async (tool: string, params: unknown) => {
      const response = await agent.executeTask(tool, params as never);
      expect(response.success, response.error).toBe(true);
      expect(response.status).toBe('completed');
      expect(response.data?.errors).toBeUndefined();
      return response.data;
    };
    const client = {
      getReportingStatus: (p: never) => call('get_reporting_status', p),
      getMediaBuyDelivery: (p: never) => call('get_media_buy_delivery', p),
      syncReportingReceipts: async (p: Parameters<NonNullable<typeof host.service.platform.syncReportingReceipts>>[0]) => {
        batches.push(structuredClone(p));
        return call('sync_reporting_receipts', p);
      },
      syncReportingStatus: (p: never) => call('sync_reporting_status', p),
    };
    let verified;
    try {
      verified = await verifyTrainingGcsBuyer({ grant, expected: { ...pins.expected, periodStart: period.start, periodEnd: period.end },
        storage: provider.storage, client, persistence, consumerScope: 'modeled-buyer:account-a',
        authorize: async () => !!await host.grant(config.canaryPrincipal, accountId, 'destination-a', 1) });
      expect((await call('sync_reporting_receipts', batches[0]))?.results[0].result).toBe('recorded');
    } finally {
      await closeMCPConnections();
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      shared.runtime = undefined;
    }
    expect(verified.definitive).toBe(true);
    expect(verified.submittedReceipts).toHaveLength(1);
    expect(verified.failedConsumerStatuses).toHaveLength(0);
    expect(verified.submittedReceipts[0]).toMatchObject({ status: 'accepted', verification_profile: 'canonical_digest', observed_row_count: 1 });
    const duplicate = await host.service.platform.syncReportingReceipts!(batches[0], context);
    expect(duplicate.results[0].result).toBe('recorded');
    expect((await db.query('SELECT count(*)::text AS count FROM adcp_reporting_receipts')).rows[0].count).toBe('1');
    const conflicting = structuredClone(batches[0]);
    conflicting.receipts![0].observed_row_count = 999;
    const refusal = await host.service.platform.syncReportingReceipts!(conflicting, context);
    expect(refusal.results[0].result).toBe('failed');
    capturedMaterializations = verified.ledger.materializations;
  }, 120_000);
  it('reconstructs the seller from PostgreSQL without changing namespace, UUID, grants or receipt evidence', async () => {
    const before = await host.service.stores.managed.getObjectWriteAuthorityId();
    const grant = await host.grant(config.canaryPrincipal, accountId, 'destination-a', 1);
    await host.service.stop();
    host = await TrainingGcsReporting.create(config, db, provider.storage);
    expect(await host.service.stores.managed.getObjectWriteAuthorityId()).toBe(before);
    expect(await host.grant(config.canaryPrincipal, accountId, 'destination-a', 1)).toEqual(grant);
    const status = await host.service.platform.getReportingStatus({ account: { account_id: accountId }, view: 'periods', period }, { account: { id: accountId }, authInfo: { clientId: config.canaryPrincipal } } as never);
    expect(status.receipts?.some(item => item.status === 'accepted')).toBe(true);
  });
  it('revokes authoritative grants, closes private contracts and fences the modeled inventory', async () => {
    const grant = (await host.grant(config.canaryPrincipal, accountId, 'destination-a', 1))!;
    const reader = await host.contractReader(accountId, 'destination-a', 1);
    expect(await reader.authorize({ scope: reader.scope, bucket: reader.bucket, objectPrefix: reader.objectPrefix, objectName: `${reader.objectPrefix}schema.json` }, { signal: new AbortController().signal })).toBe(true);
    expect(await host.revoke(config.canaryPrincipal, accountId, 'destination-a', 1)).toBe(true);
    expect(await host.grant(config.canaryPrincipal, accountId, 'destination-a', 1)).toBeNull();
    expect(await reader.authorize({ scope: reader.scope, bucket: reader.bucket, objectPrefix: reader.objectPrefix, objectName: `${reader.objectPrefix}schema.json` }, { signal: new AbortController().signal })).toBe(false);
    await host.service.managed.runWorker({ account_id: accountId, maxIterations: 5 });
    expect(await host.service.stores.managed.getObjectWriteBinding({ account_id: accountId, destination_ref: 'destination-a', generation: 1 })).not.toBeNull();
    expect(await probeRevokedTrainingGenerations(provider.storage, grant, capturedMaterializations)).toMatchObject({ native_generations_404: 1 });
  });
  it('starts and gracefully drains the coordinated scheduler', async () => {
    const errors: unknown[] = [];
    host.start(error => { errors.push(error); });
    expect(host.service.running).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    await host.service.stop();
    expect(host.service.running).toBe(false);
    expect(errors).toEqual([]);
  });
});
