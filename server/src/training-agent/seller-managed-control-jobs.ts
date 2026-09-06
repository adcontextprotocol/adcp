import { createHmac, randomUUID } from 'node:crypto';
import {
  AdcpError,
  type AdcpStructuredError,
  type IdempotencyStore,
  type ScopedTaskRef,
  type TaskRegistry,
  type TaskRegistryScope,
} from '@adcp/sdk/server';
import { isDatabaseInitialized, query } from '../db/client.js';
import { decrypt, deriveKey, encrypt } from '../db/encryption.js';
import { createLogger } from '../logger.js';

const logger = createLogger('seller-managed-control-jobs');
const LEASE_MS = 30_000;
const LEASE_HEARTBEAT_MS = 10_000;
const TASK_CREATE_GRACE_MS = 2_000;
const RECONCILE_INTERVAL_MS = 5_000;
const RECONCILE_FAILURE_THRESHOLD = 3;
const FRAMEWORK_WEBHOOK_GRACE_MS = 60_000;

export interface SellerManagedControlJobContext extends Record<string, unknown> {
  mode: 'open' | 'training';
  sharedPublicBrandDomain?: string;
}

export interface SellerManagedControlJob {
  taskId: string;
  accountId: string;
  ownerScope: string;
  idempotencyPrincipal: string;
  idempotencyKey: string;
  requestFingerprint: string;
  hasWebhook: boolean;
  webhookTenantScope?: string;
  pushConfig?: Record<string, unknown>;
  mediaBuyId: string;
  expectedRevision: number;
  authorizedActions: string[];
  request: Record<string, unknown>;
  executionContext: SellerManagedControlJobContext;
  status: 'pending' | 'working' | 'succeeded' | 'failed';
  leaseOwner?: string;
  leaseVersion: number;
  leaseExpiresAt?: string;
  attemptCount: number;
  nextAttemptAt: string;
  result?: Record<string, unknown>;
  error?: AdcpStructuredError;
  terminalAt?: string;
  taskSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SellerManagedControlJobInput {
  taskId?: string;
  accountId: string;
  ownerScope: string;
  idempotencyPrincipal: string;
  idempotencyKey: string;
  hasWebhook: boolean;
  webhookTenantScope?: string;
  pushConfig?: Record<string, unknown>;
  mediaBuyId: string;
  expectedRevision: number;
  authorizedActions: string[];
  request: Record<string, unknown>;
  executionContext: SellerManagedControlJobContext;
}

export type SellerManagedControlJobReplayInput = Pick<
  SellerManagedControlJobInput,
  'accountId' | 'idempotencyPrincipal' | 'idempotencyKey' | 'mediaBuyId'
    | 'expectedRevision' | 'request' | 'pushConfig'
>;

interface ClaimedJob {
  job: SellerManagedControlJob;
  leaseOwner: string;
  leaseVersion: number;
}

export interface SellerManagedControlJobStore {
  enqueue(input: SellerManagedControlJobInput): Promise<SellerManagedControlJob>;
  findReplay(input: SellerManagedControlJobReplayInput): Promise<SellerManagedControlJob | null>;
  rebindReplayOwner(
    input: SellerManagedControlJobReplayInput,
    taskId: string,
    ownerScope: string,
    webhookTenantScope?: string,
  ): Promise<SellerManagedControlJob>;
  claim(leaseOwner: string, taskId?: string): Promise<ClaimedJob | null>;
  renew(claim: ClaimedJob): Promise<boolean>;
  succeed(claim: ClaimedJob, result: Record<string, unknown>): Promise<boolean>;
  fail(claim: ClaimedJob, error: AdcpStructuredError): Promise<boolean>;
  retry(claim: ClaimedJob, delayMs: number): Promise<boolean>;
  markTaskSynced(claim: ClaimedJob): Promise<boolean>;
  markTaskSyncedByTaskId(taskId: string): Promise<boolean>;
  get(taskId: string): Promise<SellerManagedControlJob | null>;
}

function rowToJob(row: Record<string, unknown>): SellerManagedControlJob {
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
  const accountId = String(row.account_id);
  const ownerScope = String(row.owner_scope);
  const idempotencyPrincipal = String(row.idempotency_principal);
  const idempotencyKey = String(row.idempotency_key);
  const pushConfig = row.push_config_encrypted != null && row.push_config_iv != null
    ? JSON.parse(decrypt(
        String(row.push_config_encrypted),
        String(row.push_config_iv),
        jobSecretSalt(idempotencyPrincipal, accountId, idempotencyKey),
      )) as Record<string, unknown>
    : undefined;
  return {
    taskId: String(row.task_id),
    accountId,
    ownerScope,
    idempotencyPrincipal,
    idempotencyKey,
    requestFingerprint: String(row.request_fingerprint),
    hasWebhook: row.has_webhook === true,
    ...(row.webhook_tenant_scope != null
      ? { webhookTenantScope: String(row.webhook_tenant_scope) }
      : {}),
    ...(pushConfig && { pushConfig }),
    mediaBuyId: String(row.media_buy_id),
    expectedRevision: Number(row.expected_revision),
    authorizedActions: row.authorized_actions as string[],
    request: row.request as Record<string, unknown>,
    executionContext: row.execution_context as SellerManagedControlJobContext,
    status: row.status as SellerManagedControlJob['status'],
    ...(row.lease_owner != null ? { leaseOwner: String(row.lease_owner) } : {}),
    leaseVersion: Number(row.lease_version),
    ...(row.lease_expires_at != null ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: iso(row.next_attempt_at),
    ...(row.result != null ? { result: row.result as Record<string, unknown> } : {}),
    ...(row.error != null ? { error: row.error as AdcpStructuredError } : {}),
    ...(row.terminal_at != null ? { terminalAt: iso(row.terminal_at) } : {}),
    ...(row.task_synced_at != null ? { taskSyncedAt: iso(row.task_synced_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Seller-control jobs require finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Seller-control jobs cannot persist ${typeof value}`);
}

function jobSecretSalt(idempotencyPrincipal: string, accountId: string, idempotencyKey: string): string {
  return `seller-control:${createHmac('sha256', 'namespace-v1')
    .update(canonicalJson([idempotencyPrincipal, accountId, idempotencyKey]), 'utf8')
    .digest('hex')}`;
}

function fingerprintInput(input: SellerManagedControlJobReplayInput): string {
  const salt = jobSecretSalt(input.idempotencyPrincipal, input.accountId, input.idempotencyKey);
  return createHmac('sha256', deriveKey(salt)).update(canonicalJson({
    mediaBuyId: input.mediaBuyId,
    expectedRevision: input.expectedRevision,
    request: input.request,
    pushConfig: input.pushConfig ?? null,
  }), 'utf8').digest('hex');
}

export class PostgresSellerManagedControlJobStore implements SellerManagedControlJobStore {
  async enqueue(input: SellerManagedControlJobInput): Promise<SellerManagedControlJob> {
    const taskId = input.taskId ?? `smc_${randomUUID()}`;
    const requestFingerprint = fingerprintInput(input);
    const salt = jobSecretSalt(input.idempotencyPrincipal, input.accountId, input.idempotencyKey);
    const sealedPushConfig = input.pushConfig
      ? encrypt(canonicalJson(input.pushConfig), salt)
      : undefined;
    const result = await query(
      `INSERT INTO seller_managed_control_jobs AS jobs (
         task_id, account_id, owner_scope, idempotency_principal, idempotency_key, request_fingerprint,
         has_webhook, webhook_tenant_scope, push_config_encrypted, push_config_iv, media_buy_id,
         expected_revision, authorized_actions, request, execution_context
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)
       ON CONFLICT (idempotency_principal, account_id, idempotency_key) DO UPDATE
         SET updated_at = jobs.updated_at
       WHERE jobs.request_fingerprint = EXCLUDED.request_fingerprint
       RETURNING *`,
      [
        taskId, input.accountId, input.ownerScope, input.idempotencyPrincipal,
        input.idempotencyKey, requestFingerprint, input.hasWebhook,
        input.webhookTenantScope ?? null,
        sealedPushConfig?.encrypted ?? null, sealedPushConfig?.iv ?? null,
        input.mediaBuyId, input.expectedRevision,
        JSON.stringify(input.authorizedActions), JSON.stringify(input.request),
        JSON.stringify(input.executionContext),
      ],
    );
    if (!result.rows[0]) {
      throw new AdcpError('IDEMPOTENCY_CONFLICT', {
        recovery: 'correctable',
        message: 'idempotency_key was already used with a different seller-control request.',
        field: 'idempotency_key',
      });
    }
    return rowToJob(result.rows[0] as Record<string, unknown>);
  }

  async findReplay(input: SellerManagedControlJobReplayInput): Promise<SellerManagedControlJob | null> {
    const result = await query(
      `SELECT * FROM seller_managed_control_jobs
        WHERE idempotency_principal = $1 AND account_id = $2 AND idempotency_key = $3`,
      [input.idempotencyPrincipal, input.accountId, input.idempotencyKey],
    );
    if (!result.rows[0]) return null;
    const job = rowToJob(result.rows[0] as Record<string, unknown>);
    if (job.requestFingerprint !== fingerprintInput(input)) {
      throw new AdcpError('IDEMPOTENCY_CONFLICT', {
        recovery: 'correctable',
        message: 'idempotency_key was already used with a different seller-control request.',
        field: 'idempotency_key',
      });
    }
    return job;
  }

  async rebindReplayOwner(
    input: SellerManagedControlJobReplayInput,
    taskId: string,
    ownerScope: string,
    webhookTenantScope?: string,
  ): Promise<SellerManagedControlJob> {
    const fingerprint = fingerprintInput(input);
    const result = await query(
      `WITH authorized AS (
         SELECT task_id, webhook_tenant_scope
           FROM seller_managed_control_jobs
          WHERE task_id = $1 AND account_id = $2 AND idempotency_principal = $3
            AND idempotency_key = $4 AND request_fingerprint = $5
       ), rebound_task AS (
         UPDATE adcp_decisioning_tasks AS tasks
            SET owner_scope = $6, updated_at = NOW()
           FROM authorized
          WHERE tasks.task_id = authorized.task_id
            AND tasks.account_id = $2 AND tasks.tool = 'control_media_buy'
         RETURNING tasks.task_id
       ), suppress_previous_webhook AS (
         INSERT INTO adcp_webhook_delivery_bindings (
           publisher_scope, tenant_scope, delivery_id, status
         )
         SELECT 'adcp-training-agent', authorized.webhook_tenant_scope,
                'task-webhook:' || $2 || ':control_media_buy:' || authorized.task_id, 'retired'
           FROM authorized
          WHERE $7::text IS NOT NULL
            AND authorized.webhook_tenant_scope IS NOT NULL
            AND $7 IS DISTINCT FROM (SELECT webhook_tenant_scope FROM authorized)
         ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO NOTHING
         RETURNING delivery_id
       ), suppress_replayed_webhook AS (
         INSERT INTO adcp_webhook_delivery_bindings (
           publisher_scope, tenant_scope, delivery_id, status
         )
         SELECT 'adcp-training-agent', $7,
                'task-webhook:' || $2 || ':control_media_buy:' || authorized.task_id, 'retired'
           FROM authorized
          WHERE $7::text IS NOT NULL
            AND $7 IS DISTINCT FROM authorized.webhook_tenant_scope
            AND NOT EXISTS (SELECT 1 FROM suppress_previous_webhook)
         ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO NOTHING
         RETURNING delivery_id
       ), discard_previous_outbox AS (
         DELETE FROM adcp_webhook_delivery_outbox AS outbox
          USING authorized
          WHERE EXISTS (SELECT 1 FROM suppress_previous_webhook)
            AND outbox.publisher_scope = 'adcp-training-agent'
            AND outbox.tenant_scope = authorized.webhook_tenant_scope
            AND outbox.delivery_id = 'task-webhook:' || $2 || ':control_media_buy:' || authorized.task_id
         RETURNING outbox.delivery_id
       )
       UPDATE seller_managed_control_jobs AS jobs
          SET owner_scope = $6,
              webhook_tenant_scope = COALESCE($7, jobs.webhook_tenant_scope),
              task_synced_at = CASE
                WHEN $7::text IS NOT NULL
                  AND $7 IS DISTINCT FROM authorized.webhook_tenant_scope
                  AND NOT EXISTS (SELECT 1 FROM suppress_previous_webhook)
                  THEN COALESCE(jobs.task_synced_at, NOW())
                ELSE jobs.task_synced_at
              END,
              updated_at = NOW()
        FROM authorized
       WHERE jobs.task_id = authorized.task_id
       RETURNING jobs.*`,
      [taskId, input.accountId, input.idempotencyPrincipal, input.idempotencyKey,
        fingerprint, ownerScope, webhookTenantScope ?? null],
    );
    if (!result.rows[0]) {
      throw new AdcpError('IDEMPOTENCY_CONFLICT', {
        recovery: 'correctable',
        message: 'Seller-managed task replay authorization no longer matches the durable request.',
        field: 'idempotency_key',
      });
    }
    return rowToJob(result.rows[0] as Record<string, unknown>);
  }

  async claim(leaseOwner: string, taskId?: string): Promise<ClaimedJob | null> {
    const result = await query(
      `WITH candidate AS (
         SELECT task_id
           FROM seller_managed_control_jobs
          WHERE task_synced_at IS NULL
            AND ($2::text IS NULL OR task_id = $2)
            AND (
              (status = 'pending' AND next_attempt_at <= NOW())
              OR (status = 'working' AND lease_expires_at <= NOW())
              OR (status IN ('succeeded', 'failed') AND next_attempt_at <= NOW())
            )
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE seller_managed_control_jobs AS jobs
          SET status = CASE WHEN jobs.status IN ('succeeded','failed') THEN jobs.status ELSE 'working' END,
              lease_owner = $1,
              lease_version = jobs.lease_version + 1,
              lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
              attempt_count = CASE WHEN jobs.status IN ('succeeded','failed') THEN jobs.attempt_count ELSE jobs.attempt_count + 1 END,
              updated_at = NOW()
         FROM candidate
        WHERE jobs.task_id = candidate.task_id
       RETURNING jobs.*`,
      [leaseOwner, taskId ?? null, LEASE_MS],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const job = rowToJob(row);
    return { job, leaseOwner, leaseVersion: job.leaseVersion };
  }

  async succeed(claim: ClaimedJob, result: Record<string, unknown>): Promise<boolean> {
    return await this.finish(claim, 'succeeded', result, null);
  }

  async renew(claim: ClaimedJob): Promise<boolean> {
    const updated = await query(
      `UPDATE seller_managed_control_jobs
          SET lease_expires_at = NOW() + ($4::int * INTERVAL '1 millisecond'),
              updated_at = NOW()
        WHERE task_id = $1 AND lease_owner = $2 AND lease_version = $3
          AND status = 'working'`,
      [claim.job.taskId, claim.leaseOwner, claim.leaseVersion, LEASE_MS],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async fail(claim: ClaimedJob, error: AdcpStructuredError): Promise<boolean> {
    return await this.finish(claim, 'failed', null, error);
  }

  private async finish(
    claim: ClaimedJob,
    status: 'succeeded' | 'failed',
    result: Record<string, unknown> | null,
    error: AdcpStructuredError | null,
  ): Promise<boolean> {
    const updated = await query(
      `UPDATE seller_managed_control_jobs
          SET status = $4, result = $5::jsonb, error = $6::jsonb,
              lease_expires_at = NULL, terminal_at = COALESCE(terminal_at, NOW()),
              next_attempt_at = NOW() + ($7::int * INTERVAL '1 millisecond'), updated_at = NOW()
        WHERE task_id = $1 AND lease_owner = $2 AND lease_version = $3
          AND status = 'working'`,
      [claim.job.taskId, claim.leaseOwner, claim.leaseVersion, status,
        result === null ? null : JSON.stringify(result),
        error === null ? null : JSON.stringify(error), FRAMEWORK_WEBHOOK_GRACE_MS],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async retry(claim: ClaimedJob, delayMs: number): Promise<boolean> {
    const updated = await query(
      `UPDATE seller_managed_control_jobs
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = NOW() + ($4::int * INTERVAL '1 millisecond'), updated_at = NOW()
        WHERE task_id = $1 AND lease_owner = $2 AND lease_version = $3
          AND status = 'working'`,
      [claim.job.taskId, claim.leaseOwner, claim.leaseVersion, Math.max(0, delayMs)],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async markTaskSynced(claim: ClaimedJob): Promise<boolean> {
    const updated = await query(
      `UPDATE seller_managed_control_jobs
          SET task_synced_at = NOW(), lease_expires_at = NULL, updated_at = NOW()
        WHERE task_id = $1 AND lease_owner = $2 AND lease_version = $3
          AND status IN ('succeeded','failed')`,
      [claim.job.taskId, claim.leaseOwner, claim.leaseVersion],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async markTaskSyncedByTaskId(taskId: string): Promise<boolean> {
    const updated = await query(
      `UPDATE seller_managed_control_jobs
          SET task_synced_at = COALESCE(task_synced_at, NOW()), lease_expires_at = NULL, updated_at = NOW()
        WHERE task_id = $1 AND status IN ('succeeded','failed')`,
      [taskId],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async get(taskId: string): Promise<SellerManagedControlJob | null> {
    const result = await query(
      'SELECT * FROM seller_managed_control_jobs WHERE task_id = $1',
      [taskId],
    );
    return result.rows[0] ? rowToJob(result.rows[0] as Record<string, unknown>) : null;
  }
}

export class InMemorySellerManagedControlJobStore implements SellerManagedControlJobStore {
  private readonly jobs = new Map<string, SellerManagedControlJob>();

  async enqueue(input: SellerManagedControlJobInput): Promise<SellerManagedControlJob> {
    const now = new Date().toISOString();
    const taskId = input.taskId ?? `smc_${randomUUID()}`;
    const requestFingerprint = fingerprintInput(input);
    const replay = [...this.jobs.values()].find(job => job.idempotencyPrincipal === input.idempotencyPrincipal
      && job.accountId === input.accountId && job.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new AdcpError('IDEMPOTENCY_CONFLICT', {
          recovery: 'correctable',
          message: 'idempotency_key was already used with a different seller-control request.',
          field: 'idempotency_key',
        });
      }
      return structuredClone(replay);
    }
    if (this.jobs.has(taskId)) throw new Error(`Seller-managed control job already exists: ${taskId}`);
    const job: SellerManagedControlJob = {
      ...structuredClone(input), taskId, requestFingerprint, status: 'pending', leaseVersion: 0,
      attemptCount: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    this.jobs.set(taskId, job);
    return structuredClone(job);
  }

  async findReplay(input: SellerManagedControlJobReplayInput): Promise<SellerManagedControlJob | null> {
    const replay = [...this.jobs.values()].find(job => job.idempotencyPrincipal === input.idempotencyPrincipal
      && job.accountId === input.accountId && job.idempotencyKey === input.idempotencyKey);
    if (!replay) return null;
    if (replay.requestFingerprint !== fingerprintInput(input)) {
      throw new AdcpError('IDEMPOTENCY_CONFLICT', {
        recovery: 'correctable',
        message: 'idempotency_key was already used with a different seller-control request.',
        field: 'idempotency_key',
      });
    }
    return structuredClone(replay);
  }

  async rebindReplayOwner(
    input: SellerManagedControlJobReplayInput,
    taskId: string,
    ownerScope: string,
    webhookTenantScope?: string,
  ): Promise<SellerManagedControlJob> {
    const replay = await this.findReplay(input);
    if (!replay || replay.taskId !== taskId) {
      throw new AdcpError('IDEMPOTENCY_CONFLICT', {
        recovery: 'correctable',
        message: 'Seller-managed task replay authorization no longer matches the durable request.',
        field: 'idempotency_key',
      });
    }
    const current = this.jobs.get(taskId)!;
    current.ownerScope = ownerScope;
    if (webhookTenantScope) current.webhookTenantScope = webhookTenantScope;
    current.updatedAt = new Date().toISOString();
    return structuredClone(current);
  }

  async claim(leaseOwner: string, taskId?: string): Promise<ClaimedJob | null> {
    const now = Date.now();
    const candidate = [...this.jobs.values()]
      .filter(job => !job.taskSyncedAt && (!taskId || job.taskId === taskId))
      .filter(job => (
        (job.status === 'pending' && Date.parse(job.nextAttemptAt) <= now)
        || (job.status === 'working' && Date.parse(job.leaseExpiresAt ?? '') <= now)
        || ((job.status === 'succeeded' || job.status === 'failed')
          && Date.parse(job.nextAttemptAt) <= now)
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!candidate) return null;
    candidate.leaseOwner = leaseOwner;
    candidate.leaseVersion += 1;
    candidate.leaseExpiresAt = new Date(now + LEASE_MS).toISOString();
    if (candidate.status !== 'succeeded' && candidate.status !== 'failed') {
      candidate.status = 'working';
      candidate.attemptCount += 1;
    }
    candidate.updatedAt = new Date().toISOString();
    return {
      job: structuredClone(candidate), leaseOwner,
      leaseVersion: candidate.leaseVersion,
    };
  }

  async succeed(claim: ClaimedJob, result: Record<string, unknown>): Promise<boolean> {
    return this.finish(claim, 'succeeded', result, undefined);
  }

  async renew(claim: ClaimedJob): Promise<boolean> {
    const current = this.jobs.get(claim.job.taskId);
    if (!this.owns(current, claim) || current?.status !== 'working') return false;
    current.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    current.updatedAt = new Date().toISOString();
    return true;
  }

  async fail(claim: ClaimedJob, error: AdcpStructuredError): Promise<boolean> {
    return this.finish(claim, 'failed', undefined, error);
  }

  private finish(
    claim: ClaimedJob,
    status: 'succeeded' | 'failed',
    result?: Record<string, unknown>,
    error?: AdcpStructuredError,
  ): boolean {
    const current = this.jobs.get(claim.job.taskId);
    if (!this.owns(current, claim) || current?.status !== 'working') return false;
    current.status = status;
    current.result = result;
    current.error = error;
    current.terminalAt ??= new Date().toISOString();
    current.nextAttemptAt = new Date(Date.now() + FRAMEWORK_WEBHOOK_GRACE_MS).toISOString();
    current.leaseExpiresAt = undefined;
    current.updatedAt = new Date().toISOString();
    return true;
  }

  async retry(claim: ClaimedJob, delayMs: number): Promise<boolean> {
    const current = this.jobs.get(claim.job.taskId);
    if (!this.owns(current, claim) || current?.status !== 'working') return false;
    current.status = 'pending';
    current.leaseOwner = undefined;
    current.leaseExpiresAt = undefined;
    current.nextAttemptAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
    current.updatedAt = new Date().toISOString();
    return true;
  }

  async markTaskSynced(claim: ClaimedJob): Promise<boolean> {
    const current = this.jobs.get(claim.job.taskId);
    if (!current || !this.owns(current, claim)
      || (current.status !== 'succeeded' && current.status !== 'failed')) return false;
    current.taskSyncedAt = new Date().toISOString();
    current.leaseExpiresAt = undefined;
    current.updatedAt = new Date().toISOString();
    return true;
  }

  async markTaskSyncedByTaskId(taskId: string): Promise<boolean> {
    const current = this.jobs.get(taskId);
    if (!current || (current.status !== 'succeeded' && current.status !== 'failed')) return false;
    current.taskSyncedAt ??= new Date().toISOString();
    current.leaseExpiresAt = undefined;
    current.updatedAt = new Date().toISOString();
    return true;
  }

  async get(taskId: string): Promise<SellerManagedControlJob | null> {
    const job = this.jobs.get(taskId);
    return job ? structuredClone(job) : null;
  }

  expireLease(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (job) job.leaseExpiresAt = new Date(0).toISOString();
  }

  age(taskId: string, elapsedMs: number): void {
    const job = this.jobs.get(taskId);
    if (job) job.createdAt = new Date(Date.now() - elapsedMs).toISOString();
  }

  private owns(job: SellerManagedControlJob | undefined, claim: ClaimedJob): boolean {
    return job?.leaseOwner === claim.leaseOwner && job.leaseVersion === claim.leaseVersion;
  }
}

export interface SellerManagedReplayTaskRegistry extends TaskRegistry {
  authorizeSellerManagedReplay(opts: {
    taskId: string;
    accountId: string;
    ownerScope: string;
  }): Promise<void>;
}

/** The SDK normally treats override task IDs as create-once. Seller-control
 * request replay is the narrow exception: a durable idempotency row may need
 * to reconnect the buyer to the exact task after the first HTTP response was
 * lost. Only exact owner/account/tool matches under our `smc_` namespace are
 * replayed; every other collision retains the SDK's fail-closed behavior. */
export function withSellerManagedTaskReplay(registry: TaskRegistry): SellerManagedReplayTaskRegistry {
  const authorizedOwners = new Map<string, string>();
  const taskRefs = new Map<string, ScopedTaskRef>();

  const aliasedScope = (taskId: string, scope: TaskRegistryScope): TaskRegistryScope => {
    const taskRef = taskRefs.get(taskId);
    return taskRef?.accountId === scope.accountId
      && authorizedOwners.get(taskId) === scope.ownerScope
      ? taskRef
      : scope;
  };

  return {
    ...registry,
    get registryId() {
      return registry.registryId;
    },
    async authorizeSellerManagedReplay(opts) {
      let taskRef = taskRefs.get(opts.taskId);
      let existing = taskRef
        ? await registry.getTask(opts.taskId, taskRef)
        : null;
      if (!existing) {
        const reboundRef: ScopedTaskRef = {
          taskId: opts.taskId,
          accountId: opts.accountId,
          ownerScope: opts.ownerScope,
          ...(registry.registryId && { registryId: registry.registryId }),
        };
        existing = await registry.getTask(opts.taskId, reboundRef);
        if (existing) taskRef = reboundRef;
      }
      if (existing && (existing.tool !== 'control_media_buy' || existing.accountId !== opts.accountId)) {
        throw new Error(`Seller-managed task replay scope mismatch: ${opts.taskId}`);
      }
      if (!existing || !taskRef) {
        throw new Error(`Seller-managed task replay scope mismatch: ${opts.taskId}`);
      }
      // Production ownership is atomically rebound in the durable store. The
      // projection is also required for the SDK in-memory registry used by
      // tests and local development, which intentionally exposes no mutation
      // method for task metadata.
      taskRefs.set(opts.taskId, taskRef);
      authorizedOwners.set(opts.taskId, opts.ownerScope);
    },
    async create(opts) {
      if (opts.overrideTaskId?.startsWith('smc_')) {
        const taskRef = taskRefs.get(opts.overrideTaskId);
        const existing = taskRef
          ? await registry.getTask(opts.overrideTaskId, taskRef)
          : null;
        if (existing && taskRef) {
          const ownerScope = opts.ownerScope ?? `account:${opts.accountId}`;
          const authorizedOwner = authorizedOwners.get(opts.overrideTaskId);
          if (existing.tool !== opts.tool || existing.accountId !== opts.accountId
            || (existing.ownerScope !== ownerScope && authorizedOwner !== ownerScope)) {
            throw new Error(`Seller-managed task replay scope mismatch: ${opts.overrideTaskId}`);
          }
          return { ...taskRef, ownerScope };
        }
      }
      const taskRef = await registry.create(opts);
      if (taskRef.taskId.startsWith('smc_')) taskRefs.set(taskRef.taskId, taskRef);
      return taskRef;
    },
    async getTask<TResult = unknown>(taskId: string, scope: TaskRegistryScope) {
      const authorizedOwner = authorizedOwners.get(taskId);
      const existing = authorizedOwner === scope.ownerScope
        ? await registry.getTask<TResult>(taskId, aliasedScope(taskId, scope))
        : await registry.getTask<TResult>(taskId, scope);
      const ownerScope = authorizedOwners.get(taskId);
      return existing && ownerScope === scope.ownerScope && existing.accountId === scope.accountId
        ? { ...existing, ownerScope }
        : existing;
    },
    ...(registry.list && {
      async list(opts) {
        const listed = await registry.list!(opts);
        const tasks = [...listed.tasks];
        for (const [taskId, ownerScope] of authorizedOwners) {
          if (ownerScope !== opts.ownerScope || tasks.some(task => task.taskId === taskId)) continue;
          const taskRef = taskRefs.get(taskId);
          const task = taskRef ? await registry.getTask(taskId, taskRef) : null;
          if (task?.accountId === opts.accountId) tasks.push({ ...task, ownerScope });
        }
        return { tasks };
      },
    }),
    async complete(taskId, scope, result) {
      return await registry.complete(taskId, aliasedScope(taskId, scope), result);
    },
    async fail(taskId, scope, error, result) {
      return await registry.fail(taskId, aliasedScope(taskId, scope), error, result);
    },
    async updateProgress(taskId, scope, progress) {
      return await registry.updateProgress(taskId, aliasedScope(taskId, scope), progress);
    },
    _registerBackground(taskId, scope, completion) {
      registry._registerBackground(taskId, aliasedScope(taskId, scope), completion);
    },
    async awaitTask(taskId, scope) {
      await registry.awaitTask(taskId, aliasedScope(taskId, scope));
    },
    ...(registry.clear && {
      async clear() {
        authorizedOwners.clear();
        taskRefs.clear();
        await registry.clear!();
      },
    }),
  };
}

function submittedSellerControlTaskId(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.task_id === 'string' && record.task_id.startsWith('smc_')) return record.task_id;
  for (const key of ['structuredContent', 'result', 'response']) {
    const nested = submittedSellerControlTaskId(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export async function rebindCachedSdkReplay(opts: {
  taskId: string;
  accountId: string;
  idempotencyPrincipal: string;
  idempotencyKey: string;
  ownerScope: string;
}, runQuery: typeof query | undefined = process.env.NODE_ENV === 'production' ? query : undefined): Promise<void> {
  if (!runQuery) return;
  const result = await runQuery(
    `WITH authorized AS (
       SELECT task_id
         FROM seller_managed_control_jobs
        WHERE task_id = $1 AND account_id = $2 AND idempotency_principal = $3
          AND idempotency_key = $4
     ), rebound_task AS (
       UPDATE adcp_decisioning_tasks AS tasks
          SET owner_scope = $5, updated_at = NOW()
         FROM authorized
        WHERE tasks.task_id = authorized.task_id
          AND tasks.account_id = $2 AND tasks.tool = 'control_media_buy'
       RETURNING tasks.task_id
     )
     UPDATE seller_managed_control_jobs AS jobs
        SET owner_scope = $5, updated_at = NOW()
       FROM authorized
      WHERE jobs.task_id = authorized.task_id
      RETURNING jobs.task_id`,
    [opts.taskId, opts.accountId, opts.idempotencyPrincipal, opts.idempotencyKey,
      opts.ownerScope],
  );
  if (!result.rows[0]) throw new Error(`Cached seller-managed replay authorization failed: ${opts.taskId}`);
}

/** Reconnect SDK-level exact replays before the platform handler is invoked.
 * The SDK cache is intentionally outside the platform, so this adapter is the
 * only point that sees both its stable idempotency proof and the replacement
 * transport owner. */
export function withSellerManagedIdempotencyReplay(
  store: IdempotencyStore,
  taskRegistry: TaskRegistry,
): IdempotencyStore {
  return {
    ...store,
    async check(params) {
      const outcome = await store.check(params);
      const payload = params.payload;
      if (outcome.kind !== 'replay' || !Array.isArray(payload)
        || payload[0] !== '@adcp/sdk-idempotency/v2'
        || payload[1] !== 'control_media_buy' || !Array.isArray(payload[2])) return outcome;
      const taskId = submittedSellerControlTaskId(outcome.response);
      const sessionKey = typeof payload[2][0] === 'string' ? payload[2][0] : undefined;
      const accountId = typeof payload[2][2] === 'string' ? payload[2][2] : undefined;
      if (!taskId || !accountId || !sessionKey) return outcome;
      const ownerScope = `session:${sessionKey}`;
      await rebindCachedSdkReplay({
        taskId, accountId, idempotencyPrincipal: params.principal,
        idempotencyKey: params.key, ownerScope,
      });
      const replayRegistry = taskRegistry as Partial<SellerManagedReplayTaskRegistry>;
      await replayRegistry.authorizeSellerManagedReplay?.({ taskId, accountId, ownerScope });
      return outcome;
    },
  };
}

type ExecuteJob = (job: SellerManagedControlJob) => Promise<Record<string, unknown>>;
type NotifyJob = (job: SellerManagedControlJob) => Promise<void>;
type NotifySystemError = (context: { source: string; errorMessage: string }) => void;

const defaultNotifySystemError: NotifySystemError = context => {
  // Lazy import keeps the durable-job module usable in isolated protocol tests
  // that intentionally provide a minimal logger mock.
  void import('../addie/error-notifier.js')
    .then(({ notifySystemError }) => notifySystemError(context))
    .catch(err => logger.warn({ err }, 'Failed to load seller-control error notifier'));
};

function structuredErrorFromResult(result: Record<string, unknown>): AdcpStructuredError | null {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const first = errors[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const error = first as Record<string, unknown>;
  return {
    code: typeof error.code === 'string' ? error.code : 'SERVICE_UNAVAILABLE',
    recovery: error.recovery === 'terminal' || error.recovery === 'transient'
      || error.recovery === 'correctable' ? error.recovery : 'correctable',
    message: typeof error.message === 'string' ? error.message : 'Seller-managed control failed',
    ...(typeof error.field === 'string' && { field: error.field }),
    ...(error.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? { details: error.details as Record<string, unknown> }
      : {}),
  };
}

class RetryableSellerControlError extends Error {}

/** Durable outbox runner. Store outcome and task outcome are separate, retried
 * idempotently, so a process death at either boundary cannot strand the task. */
export class SellerManagedControlJobCoordinator {
  private readonly workerId = `seller-control-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private reconciliationInFlight = false;
  private consecutiveReconciliationFailures = 0;
  private reconciliationAlerted = false;

  constructor(
    private readonly taskRegistry: TaskRegistry,
    private readonly execute: ExecuteJob,
    readonly store: SellerManagedControlJobStore = process.env.NODE_ENV === 'production'
      ? new PostgresSellerManagedControlJobStore()
      : new InMemorySellerManagedControlJobStore(),
    private readonly notify: NotifyJob = async () => {},
    private readonly isDatabaseReady: () => boolean = isDatabaseInitialized,
    private readonly notifySystemError: NotifySystemError = defaultNotifySystemError,
  ) {}

  start(): void {
    this.reconcile('Initial seller-control reconciliation failed');
    if (process.env.NODE_ENV !== 'production' || this.timer) return;
    this.timer = setInterval(() => {
      this.reconcile('Seller-control reconciliation failed');
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private reconcile(errorMessage: string): void {
    if (this.store instanceof PostgresSellerManagedControlJobStore && !this.isDatabaseReady()) {
      logger.debug('Deferring seller-control reconciliation until database initialization');
      return;
    }
    // setInterval does not wait for async work. During a database outage a
    // claim can take longer than the five-second cadence, so allowing overlap
    // would multiply pool pressure exactly when PostgreSQL is least healthy.
    if (this.reconciliationInFlight) {
      logger.debug('Skipping seller-control reconciliation because the previous run is still active');
      return;
    }

    this.reconciliationInFlight = true;
    void this.runAvailable()
      .then(() => {
        if (this.reconciliationAlerted) {
          logger.info(
            { priorFailures: this.consecutiveReconciliationFailures },
            'Seller-control reconciliation recovered',
          );
        }
        this.consecutiveReconciliationFailures = 0;
        this.reconciliationAlerted = false;
      })
      .catch(err => {
        this.consecutiveReconciliationFailures += 1;
        const context = {
          err,
          consecutiveFailures: this.consecutiveReconciliationFailures,
          threshold: RECONCILE_FAILURE_THRESHOLD,
        };
        if (this.consecutiveReconciliationFailures === RECONCILE_FAILURE_THRESHOLD) {
          this.reconciliationAlerted = true;
          // Alert directly so delivery does not depend on PostHog. Keep the
          // log below error level so its hook cannot send a duplicate page.
          logger.warn(context, `${errorMessage} (alert threshold reached)`);
          const detail = err instanceof Error ? err.message : String(err);
          this.notifySystemError({
            source: 'seller-managed-control-jobs',
            errorMessage: `${errorMessage} (${this.consecutiveReconciliationFailures} consecutive): ${detail}`,
          });
        } else {
          logger.warn(context, errorMessage);
        }
      })
      .finally(() => {
        this.reconciliationInFlight = false;
      });
  }

  async enqueue(input: SellerManagedControlJobInput): Promise<SellerManagedControlJob> {
    return await this.store.enqueue(input);
  }

  async reconnect(
    replayInput: SellerManagedControlJobReplayInput,
    job: SellerManagedControlJob,
    ownerScope: string,
    webhookTenantScope?: string,
  ): Promise<SellerManagedControlJob> {
    const rebound = await this.store.rebindReplayOwner(
      replayInput, job.taskId, ownerScope, webhookTenantScope,
    );
    const registry = this.taskRegistry as Partial<SellerManagedReplayTaskRegistry>;
    if (registry.authorizeSellerManagedReplay) {
      await registry.authorizeSellerManagedReplay({
        taskId: job.taskId,
        accountId: job.accountId,
        ownerScope,
      });
    } else if (job.ownerScope !== ownerScope) {
      throw new Error('Seller-managed task registry does not support authorized reconnect');
    }
    return rebound;
  }

  async runAvailable(): Promise<void> {
    for (let count = 0; count < 100; count += 1) {
      const claim = await this.store.claim(this.workerId);
      if (!claim) return;
      try {
        await this.process(claim, true);
      } catch (err) {
        // A buyer-correctable/terminal failure is already durably copied to
        // the SDK task. Continue reconciling unrelated jobs in this batch.
        if (err instanceof AdcpError) continue;
        throw err;
      }
    }
  }

  async runTask(taskId: string): Promise<Record<string, unknown>> {
    for (;;) {
      const claim = await this.store.claim(this.workerId, taskId);
      if (!claim) {
        const job = await this.store.get(taskId);
        if (job?.status === 'succeeded' && job.result) return job.result;
        if (job?.status === 'failed' && job.error) throw this.asAdcpError(job.error);
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      try {
        return await this.process(claim, false);
      } catch (err) {
        if (err instanceof AdcpError) throw err;
        // The durable row has already been released with backoff. Keep the
        // framework handoff alive; throwing here would terminally fail its
        // task even though another worker can still reconcile the job.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async process(claim: ClaimedJob, recoveryWorker: boolean): Promise<Record<string, unknown>> {
    let job = claim.job;
    let taskScope = { accountId: job.accountId, ownerScope: job.ownerScope };
    const task = await this.taskRegistry.getTask(job.taskId, taskScope);
    if (!task) {
      if (Date.now() - Date.parse(job.createdAt) < TASK_CREATE_GRACE_MS) {
        await this.store.retry(claim, TASK_CREATE_GRACE_MS);
        throw new Error(`Task registration still in progress: ${job.taskId}`);
      }
      try {
        await this.taskRegistry.create({
          tool: 'control_media_buy', accountId: job.accountId,
          ownerScope: job.ownerScope, hasWebhook: job.hasWebhook,
          overrideTaskId: job.taskId,
        });
      } catch (err) {
        const racedTask = await this.taskRegistry.getTask(job.taskId, taskScope);
        if (!racedTask) throw err;
      }
    }

    if (job.status === 'working') {
      try {
        await this.taskRegistry.updateProgress(job.taskId, taskScope, {
          message: 'Processing seller-managed media-buy control',
        });
        const result = await this.executeWithLeaseHeartbeat(claim, job);
        const error = structuredErrorFromResult(result);
        if (error?.recovery === 'transient') {
          if (!await this.store.retry(claim, this.retryDelay(job))) {
            throw new Error(`Lost seller-control lease while scheduling retry: ${job.taskId}`);
          }
          throw new RetryableSellerControlError(error.message);
        }
        const persisted = error
          ? await this.store.fail(claim, error)
          : await this.store.succeed(claim, result);
        if (!persisted) throw new Error(`Lost seller-control lease: ${job.taskId}`);
        const durable = await this.store.get(job.taskId);
        if (!durable) throw new Error(`Seller-control outcome disappeared: ${job.taskId}`);
        job = durable;
        taskScope = { accountId: job.accountId, ownerScope: job.ownerScope };
      } catch (err) {
        if (err instanceof RetryableSellerControlError) throw err;
        if (err instanceof AdcpError) {
          const structured = err.toStructuredError();
          if (structured.recovery === 'transient') {
            if (!await this.store.retry(claim, this.retryDelay(job))) throw err;
            throw new RetryableSellerControlError(structured.message);
          }
          if (!await this.store.fail(claim, structured)) throw err;
          const durable = await this.store.get(job.taskId);
          if (!durable) throw new Error(`Seller-control failure disappeared: ${job.taskId}`);
          job = durable;
          taskScope = { accountId: job.accountId, ownerScope: job.ownerScope };
        } else {
          await this.store.retry(claim, this.retryDelay(job));
          logger.error({ err, taskId: job.taskId }, 'Seller-managed control execution will be retried');
          throw err;
        }
      }
    }

    if (job.status === 'failed' && job.error) {
      await this.taskRegistry.fail(job.taskId, taskScope, job.error, job.result);
      if (recoveryWorker) {
        await this.notify(job);
        await this.store.markTaskSynced(claim);
      }
      throw this.asAdcpError(job.error);
    }
    if (job.status !== 'succeeded' || !job.result) {
      throw new Error(`Seller-managed control job has no durable outcome: ${job.taskId}`);
    }
    await this.taskRegistry.complete(job.taskId, taskScope, job.result);
    if (recoveryWorker) {
      await this.notify(job);
      await this.store.markTaskSynced(claim);
    }
    return job.result;
  }

  async acknowledgeFrameworkWebhook(taskId: string): Promise<void> {
    if (!taskId.startsWith('smc_')) return;
    if (!await this.store.markTaskSyncedByTaskId(taskId)) {
      logger.warn({ taskId }, 'Framework webhook acknowledgement did not match a terminal seller-control job');
    }
  }

  private retryDelay(job: SellerManagedControlJob): number {
    return Math.min(30_000, 250 * (2 ** Math.min(job.attemptCount, 7)));
  }

  private async executeWithLeaseHeartbeat(
    claim: ClaimedJob,
    job: SellerManagedControlJob,
  ): Promise<Record<string, unknown>> {
    if (!await this.store.renew(claim)) {
      throw new Error(`Lost seller-control lease before execution: ${job.taskId}`);
    }
    let leaseLost = false;
    let renewal = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal.then(async () => {
        if (!await this.store.renew(claim)) leaseLost = true;
      }).catch(err => {
        leaseLost = true;
        logger.error({ err, taskId: job.taskId }, 'Seller-control lease renewal failed');
      });
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const result = await this.execute(job);
      clearInterval(heartbeat);
      await renewal;
      if (leaseLost) throw new Error(`Lost seller-control lease during execution: ${job.taskId}`);
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private asAdcpError(error: AdcpStructuredError): AdcpError {
    return new AdcpError(error.code, {
      recovery: error.recovery, message: error.message,
      ...(error.field && { field: error.field }),
      ...(error.details && { details: error.details }),
    });
  }
}
