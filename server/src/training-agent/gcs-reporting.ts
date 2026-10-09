import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import { canonicalize } from '@adcp/sdk';
import { AdcpError, type NotificationSubscriptionConfigInput, type ResolveContext } from '@adcp/sdk/server';
import {
  PostgresReportingLedgerStore, PostgresReportingManagedDeliveryStore,
  reportingManagedDeliveryBindingV1, reportingObjectWriteScopeKey,
  type ReportingManagedDeliveryAdapterV1, type ReportingPgPool,
} from '@adcp/sdk/reporting/ledger';
import { createGcsReportingManagedDeliveryAdapterV1, createGcsReportingObjectFenceV1, isReportingGcsFenceError, type GcsReportingReaderOptionsV1 } from '@adcp/sdk/reporting/gcs';
import { createPostgresReliableReportingProductionService,
  type CreatePostgresReliableReportingProductionServiceOptionsV1,
  type PostgresReliableReportingProductionServiceV1,
  type ReliableReportingConfigurationInputV1,
} from '@adcp/sdk/reporting/service';
import type { ExpectedReportingPeriod } from '@adcp/sdk/reporting/consumer';
import { getDatabaseConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { proveAccountWebhookControl } from './webhook-challenge.js';
import { getWebhookSigningMaterial } from './webhooks.js';
import { resolveReportingAccountDurably, TRAINING_REPORTING_ROW_SCHEMA_BYTES } from './reporting-reliability.js';
import { trainingGcsReportingConfig, TRAINING_REPORTING_SCHEMA, TRAINING_REPORTING_LIMITS as limits, type TrainingGcsReportingConfig } from './gcs-reporting-config.js';
import { GCS_OFFERING_ID, GCS_REPORT_DEFINITION_ID, TRAINING_GCS_DEFINITION_BYTES, TRAINING_GCS_CANONICALIZATION_BYTES, trainingGcsCanonicalization, sha256, trainingConstituents, trainingGcsAdapter } from './gcs-reporting-source.js';

const logger = createLogger('training-gcs-reporting');
interface AccountBinding {
  [key: string]: unknown;
  principal_id: string;
  account_id: string;
  source_config_id: string;
  source_config_version: number;
  currency: string;
  media_buy_ids: string[];
  destination_ref: string;
  installed_input: ReliableReportingConfigurationInputV1;
}
export interface TrainingReportingGrant {
  principal_id: string; account_id: string; destination_ref: string; generation: number;
  bucket: string; object_prefix: string; contract_prefix: string;
}

function unavailable(): never {
  throw new AdcpError('SERVICE_UNAVAILABLE', { recovery: 'transient', message: 'Durable reporting is unavailable.' });
}
function denied(): never {
  throw new AdcpError('ACCOUNT_NOT_FOUND', { recovery: 'correctable', message: 'Reporting account was not found.' });
}

/** Shared options also let the migration generator collect the SDK's ordered SQL. */
export function trainingReportingServiceOptions(
  db: ReportingPgPool, config: TrainingGcsReportingConfig, adapter: ReportingManagedDeliveryAdapterV1,
  contractPrefix: string,
): CreatePostgresReliableReportingProductionServiceOptionsV1 {
  async function binding(accountId: string): Promise<AccountBinding> {
    const { rows } = await db.query<AccountBinding>('SELECT * FROM host_accounts WHERE account_id = $1', [accountId]);
    return rows[0] ?? denied();
  }
  async function principal(context: ResolveContext & { account?: { id: string } }): Promise<string> {
    const id = context.authInfo?.clientId;
    if (!id || id !== config.canaryPrincipal) denied();
    if (context.account && (await binding(context.account.id)).principal_id !== id) denied();
    return id;
  }
  const material = getWebhookSigningMaterial();
  const signing = 'signerProvider' in material ? { signerProvider: material.signerProvider } : { signerKey: material.signerKey };
  return {
    db, namespace: config.namespace, publisherScope: `${config.namespace}:sales`, acknowledgeIsolatedDatabase: true,
    adapters: { training: trainingGcsAdapter(db, config.bucket, contractPrefix) },
    contact: { name: 'AgenticAdvertising.org', url: 'https://agenticadvertising.org/contact' },
    automatedRecoveryWindowSeconds: limits.recoverySeconds, statusRetentionDays: limits.statusRetentionDays,
    resolveSource: async account => {
      const saved = await binding(account.id);
      return { adapterId: 'training', sourceTimezone: 'UTC', sourceScope: {
        principal_id: saved.principal_id, source_config_id: saved.source_config_id, source_config_version: saved.source_config_version,
      } };
    },
    resolveCurrency: async account => (await binding(account.id)).currency,
    resolveCoverage: async account => ({ constituents: trainingConstituents((await binding(account.id)).media_buy_ids) }),
    resolveConsumerId: principal,
    obligatedConsumers: async input => {
      const saved = await binding(input.account_id);
      return { ids: [saved.principal_id], complete: true, version: `canary:${saved.source_config_version}` };
    },
    resolveWebhookActivityScope: async context => ({ tenantId: 'sales', principalId: await principal(context) }),
    managedDelivery: { adapter, resourceRetentionDays: limits.resourceRetentionDays, authorizationRevocationSeconds: limits.revocationSeconds, store: { evidenceRetentionDays: limits.statusRetentionDays } },
    activity: { acknowledgeIsolatedDatabase: true, tenantScopeForAccount: () => 'sales', maxPendingPerTenant: 1_000 },
    notifications: {
      subscriptions: { acknowledgeIsolatedDatabase: true },
      webhooks: {
        ...signing, deliveries: { acknowledgeIsolatedDatabase: true }, outbox: { acknowledgeIsolatedDatabase: true },
        retries: { maxAttempts: 2, initialDelayMs: 1000, maxDelayMs: 5000 },
        onAttemptObserverError: () => logger.error('Reporting webhook observer failed'),
      },
      maxFanoutCandidates: 10, fanoutConcurrency: 2, adopterCallbackTimeoutMs: 15_000,
      proofAdapter: { prove: async input => {
        if (input.scope.kind !== 'account' || input.authentication.mode !== 'rfc9421'
          || input.scope.principalId !== config.canaryPrincipal) return { proved: false };
        const result = await proveAccountWebhookControl({ accountId: input.scope.accountId, subscriberId: input.subscriberId, url: input.url, eventTypes: [...input.eventTypes] });
        return { proved: result.ok };
      } },
      authorizeDelivery: async input => {
        if (input.scope.kind !== 'account' || input.scope.principalId !== config.canaryPrincipal
          || input.accountId !== input.scope.accountId) return { authorized: false };
        const saved = await binding(input.scope.accountId);
        return { authorized: saved.principal_id === input.scope.principalId };
      },
    },
  };
}

export class TrainingGcsReporting {
  private stopping = false;
  private constructor(
    readonly config: TrainingGcsReportingConfig,
    readonly db: Pool,
    readonly storage: Storage,
    readonly service: PostgresReliableReportingProductionServiceV1,
    readonly contractPrefix: string,
  ) {}

  static async create(config: TrainingGcsReportingConfig, db: Pool, storage: Storage): Promise<TrainingGcsReporting> {
    const core = new PostgresReportingLedgerStore(db, { acknowledgeIsolatedDatabase: true, managedDelivery: true });
    const managed = new PostgresReportingManagedDeliveryStore(db);
    const authorityId = await managed.getObjectWriteAuthorityId();
    const contractPrefix = `contracts/${sha256(canonicalize([config.namespace, authorityId]))}/v1/`;
    const saved = await db.query<{ namespace: string; bucket: string }>('SELECT namespace, bucket FROM host_installation WHERE singleton = true');
    if (saved.rows.length && (saved.rows[0].namespace !== config.namespace || saved.rows[0].bucket !== config.bucket)) {
      throw new Error('Reporting installation namespace or bucket differs from its durable authority.');
    }
    let host: TrainingGcsReporting | undefined;
    const gcs = await createGcsReportingManagedDeliveryAdapterV1({
      storage, coreStore: core, store: managed, bucket: config.bucket, namespace: config.namespace,
      acknowledgeDedicatedFreshBucket: true, operationDeadlineMilliseconds: limits.operationMilliseconds,
      minimumResourceRetentionDays: limits.resourceRetentionDays,
      resolveExpectedPeriod: async input => (host ?? unavailable()).expectedPeriod(input.binding.account_id, input.binding.configurationId, input.obligation.period.start, input.obligation.period.end),
      resolveContractReader: async input => (host ?? unavailable()).contractReader(input.binding.account_id, input.binding.destination_ref, input.binding.authorization_generation),
    });
    const adapter: ReportingManagedDeliveryAdapterV1 = {
      ...gcs,
      deliver: async (input, context) => {
        try { return await gcs.deliver(input, context); }
        catch (error) {
          logger.error({ code: isReportingGcsFenceError(error) ? error.code : 'INSPECTION_OR_PROVIDER_FAILURE' }, 'GCS reporting delivery failed');
          throw error;
        }
      },
    };
    const service = await createPostgresReliableReportingProductionService(trainingReportingServiceOptions(db, config, adapter, contractPrefix));
    // Persist only after authority/credentials/bucket policy probes, before any
    // contract or reporting upload. A failed first probe must not pin a typo.
    await db.query('INSERT INTO host_installation (singleton, namespace, bucket) VALUES (true, $1, $2) ON CONFLICT DO NOTHING', [config.namespace, config.bucket]);
    const confirmed = await db.query<{ namespace: string; bucket: string }>('SELECT namespace, bucket FROM host_installation WHERE singleton = true');
    if (confirmed.rows[0].namespace !== config.namespace || confirmed.rows[0].bucket !== config.bucket) throw new Error('Reporting installation conflict.');
    host = new TrainingGcsReporting(config, db, storage, service, contractPrefix);
    await host.publishContracts();
    return host;
  }

  private async publishContracts(): Promise<void> {
    for (const [name, text, contentType] of [
      ['definition.json', TRAINING_GCS_DEFINITION_BYTES, 'application/vnd.adcp.reporting-definition+json'],
      ['schema.json', TRAINING_REPORTING_ROW_SCHEMA_BYTES, 'application/schema+json'],
      ['canonicalization.json', TRAINING_GCS_CANONICALIZATION_BYTES, 'application/vnd.adcp.reporting-canonicalization+json'],
    ]) {
      const file = this.storage.bucket(this.config.bucket).file(`${this.contractPrefix}${name}`);
      try {
        await file.save(text, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType }, timeout: limits.operationMilliseconds });
      } catch (error) {
        if ((error as { code?: number }).code !== 412) throw new Error('Private reporting contract publication failed.');
        const [bytes] = await file.download();
        const [metadata] = await file.getMetadata();
        if (!bytes.equals(Buffer.from(text)) || metadata.contentType !== contentType) throw new Error('Private reporting contract conflicts with pinned bytes.');
      }
    }
  }

  async owns(principal: string | undefined, accountId: string): Promise<boolean> {
    if (this.stopping) unavailable();
    if (principal !== this.config.canaryPrincipal) return false;
    const { rows } = await this.db.query('SELECT 1 FROM host_accounts WHERE principal_id = $1 AND account_id = $2', [principal, accountId]);
    return rows.length === 1;
  }

  async provision(principal: string, accountId: string, sourceConfigId: string, destinationRef: string): Promise<TrainingReportingGrant> {
    if (this.stopping || principal !== this.config.canaryPrincipal) denied();
    const account = await resolveReportingAccountDurably(principal, { account_id: accountId });
    if (!account) denied();
    const { rows: priorGrants } = await this.db.query<{ destination_ref: string }>('SELECT destination_ref FROM host_grants WHERE account_id=$1', [accountId]);
    if (priorGrants[0] && priorGrants[0].destination_ref !== destinationRef) {
      throw new AdcpError('VALIDATION_ERROR', { recovery: 'correctable', message: 'The canary account already has a pinned destination.' });
    }
    const { rows } = await this.db.query<{ config: {
      config: { delivery_config_id: string; delivery_config_version: number; active: boolean; offering_id: string; scope: { media_buy_ids?: string[] } };
      activatedAt: string;
    } }>(`SELECT item AS config FROM public.training_reporting_ledgers ledger,
      jsonb_array_elements(ledger.ledger->'history') item
      WHERE ledger.principal_scope = $1 AND ledger.account_id = $2
        AND item->'config'->>'delivery_config_id' = $3
        AND ledger.ledger->'current_generation_keys' ? ((item->'config'->>'delivery_config_id') || chr(31) || (item->'config'->>'delivery_config_version'))`, [principal, accountId, sourceConfigId]);
    const source = rows[0]?.config;
    if (rows.length !== 1 || !source?.config.active || source.config.offering_id !== 'analytics-daily-managed'
      || !source.config.scope.media_buy_ids?.length || source.config.scope.media_buy_ids.length > 10) {
      throw new AdcpError('VALIDATION_ERROR', { recovery: 'correctable', message: 'Canary requires one active daily training configuration with an explicit scope of at most ten media buys.' });
    }
    const currency = account.accountState?.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Reporting account has no trusted currency.');
    const input: ReliableReportingConfigurationInputV1 = {
      delivery_config_id: `gcs:${sourceConfigId}`, delivery_config_version: source.config.delivery_config_version,
      offeringId: GCS_OFFERING_ID, report_definition_id: GCS_REPORT_DEFINITION_ID, feedPurpose: 'analytics', requiredFinality: 'snapshot',
      requestedMetrics: ['impressions'], requestedDimensions: [],
      schedule: { anchor: `${new Date(source.activatedAt).toISOString().slice(0, 10)}T00:00:00.000Z`, periodMilliseconds: 86_400_000, deliverySlaMilliseconds: 14_400_000, recoveryWindowMilliseconds: limits.recoverySeconds * 1000, periodDuration: 'P1D', alignment: 'utc', deliverySlaDuration: 'PT4H' },
      sourceSettings: { attributionModel: 'source_default', attributionWindow: 'source_default', sourceSettingsVersion: '1', sourceSettingsSha256: sha256(canonicalize([currency, 'source_default'])), settingsSnapshotRef: 'training-account-currency-v1' },
      expectedCurrency: currency, expectedSourceTimezone: 'UTC', expectedMediaBuyIds: source.config.scope.media_buy_ids,
      canonicalization: trainingGcsCanonicalization(this.config.bucket, this.contractPrefix),
    };
    await this.db.query(`INSERT INTO host_accounts (principal_id, account_id, source_config_id, source_config_version, currency, media_buy_ids, installed_input, destination_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [principal, accountId, sourceConfigId, source.config.delivery_config_version, currency, JSON.stringify(source.config.scope.media_buy_ids), input, destinationRef]);
    const saved = await this.db.query<AccountBinding>('SELECT * FROM host_accounts WHERE account_id = $1', [accountId]);
    if (saved.rows[0]?.principal_id !== principal || saved.rows[0]?.destination_ref !== destinationRef || canonicalize(saved.rows[0]?.installed_input) !== canonicalize(input)) {
      throw new AdcpError('VALIDATION_ERROR', { recovery: 'correctable', message: 'Reporting account is already bound to different immutable source facts.' });
    }
    const installed = await this.service.installConfiguration(input, { account: { id: accountId, ctx_metadata: {} } });
    // One destination generation per canary account; replay repairs partial provisioning.
    await this.service.stores.managed.authorizeDestination({ account_id: accountId, destination_ref: destinationRef, generation: 1, authorized_at: installed.installedAt });
    await this.service.stores.managed.installBinding(reportingManagedDeliveryBindingV1({
      configurationId: installed.configurationId, account_id: accountId, delivery_config_id: installed.delivery_config_id,
      delivery_config_version: installed.delivery_config_version, destination_ref: destinationRef, authorization_generation: 1,
      feed_purpose: 'analytics', method: 'file_transfer', transport: 'gcs', verification_profile: 'canonical_digest', reconciliation_mode: 'consumer_receipt', resource_retention_days: limits.resourceRetentionDays,
    }));
    // Prefix comes from installation authority, never from producer resource URLs.
    const authority = await this.service.stores.managed.getObjectWriteAuthorityId();
    const scope = { account_id: accountId, destination_ref: destinationRef, generation: 1 };
    const fence = createGcsReportingObjectFenceV1({ storage: this.storage, store: this.service.stores.managed, bucket: this.config.bucket,
      namespace: sha256(canonicalize([this.config.namespace, authority])), operationDeadlineMilliseconds: limits.operationMilliseconds });
    // Reserve the destination's namespace without uploading any reporting bytes.
    await fence.register(scope, 'destination-provisioning-v1', [new Uint8Array()]);
    const provider = await this.service.stores.managed.getAuthorizedObjectWriteBinding(scope);
    if (!provider) denied();
    const grant: TrainingReportingGrant = {
      principal_id: principal, account_id: accountId, destination_ref: destinationRef, generation: 1, bucket: this.config.bucket,
      object_prefix: `adcp-reporting/${provider.namespace_key}/${reportingObjectWriteScopeKey(scope)}/`,
      contract_prefix: this.contractPrefix,
    };
    await this.db.query(`INSERT INTO host_grants (account_id, destination_ref, generation, reader_grant) VALUES ($1,$2,1,$3)
      ON CONFLICT DO NOTHING`, [accountId, destinationRef, grant]);
    const persisted = await this.grant(principal, accountId, destinationRef, 1);
    if (!persisted || canonicalize(persisted) !== canonicalize(grant)) throw new Error('Reporting grant conflict.');
    return persisted;
  }

  async grant(principal: string, accountId: string, destination: string, generation: number): Promise<TrainingReportingGrant | null> {
    if (!await this.owns(principal, accountId)) return null;
    const { rows } = await this.db.query<{ grant: TrainingReportingGrant }>('SELECT reader_grant AS "grant" FROM host_grants WHERE account_id=$1 AND destination_ref=$2 AND generation=$3', [accountId, destination, generation]);
    if (!rows[0] || !await this.service.stores.managed.isAuthorizationCurrent({ account_id: accountId, destination_ref: destination, generation })) return null;
    return rows[0].grant;
  }

  async contractReader(accountId: string, destination: string, generation: number): Promise<GcsReportingReaderOptionsV1> {
    const principal = this.config.canaryPrincipal;
    const grant = await this.grant(principal, accountId, destination, generation);
    if (!grant) denied();
    return {
      scope: { principal_id: principal, account_id: accountId, destination_ref: destination, generation },
      bucket: grant.bucket, objectPrefix: grant.contract_prefix, getStorage: async () => this.storage,
      authorize: async request => {
        const current = await this.grant(request.scope.principal_id, request.scope.account_id, request.scope.destination_ref, request.scope.generation);
        return !!current && current.bucket === request.bucket && current.contract_prefix === request.objectPrefix;
      },
    };
  }

  async expectedPeriod(accountId: string, configurationId: string, periodStart: string, periodEnd: string): Promise<ExpectedReportingPeriod> {
    const { rows } = await this.db.query<AccountBinding>('SELECT * FROM host_accounts WHERE account_id=$1', [accountId]);
    const saved = rows[0] ?? denied();
    const configurations = await this.service.stores.core.listConfigurations(accountId);
    const configuration = configurations.find(item => item.configurationId === configurationId);
    if (!configuration?.canonicalization || configuration.delivery_config_id !== saved.installed_input.delivery_config_id) denied();
    const { rows: grants } = await this.db.query<{ grant: TrainingReportingGrant }>('SELECT reader_grant AS "grant" FROM host_grants WHERE account_id=$1 ORDER BY destination_ref LIMIT 2', [accountId]);
    if (grants.length !== 1) throw new Error('Canary requires exactly one pinned reporting destination.');
    const grant = grants[0].grant;
    const contract = trainingGcsAdapter(this.db, grant.bucket, grant.contract_prefix).sourceOffering.contract;
    return {
      periodStart, periodEnd, deliveryConfigId: configuration.delivery_config_id, deliveryConfigVersion: configuration.delivery_config_version,
      reportDefinitionId: contract.report_definition_id, feedPurpose: 'analytics', reportingProfile: contract.reportingProfile,
      mediaBuyIds: saved.media_buy_ids, destinationRef: grant.destination_ref, deliveryMethod: 'file_transfer', requiredFinality: 'snapshot',
      reconciliationMode: 'consumer_receipt', coverageRequirement: 'full', verificationProfile: 'canonical_digest',
      canonicalization: configuration.canonicalization,
      coverage: { status: 'full', media_buy_ids: saved.media_buy_ids, fully_covered_media_buy_ids: saved.media_buy_ids, partially_covered_media_buy_ids: [], unsupported_media_buy_ids: [], unknown_media_buy_ids: [], package_ids: [], covered_package_ids: [], unsupported_package_ids: [], unknown_package_ids: [] },
      reportDefinitionUri: contract.reportDefinitionUri, reportDefinitionSha256: contract.reportDefinitionSha256,
      schemaVersion: contract.schemaVersion, schemaUri: contract.schemaUri, schemaSha256: contract.schemaSha256,
      schemaDialect: contract.schemaDialect, schemaRefPolicy: contract.schemaRefPolicy,
      automatedRecoveryWindowSeconds: limits.recoverySeconds, deliverySlaSeconds: 14_400, periodSourceTimezone: 'UTC', committedMetrics: ['impressions'],
    };
  }

  async buyerConfiguration(principal: string, accountId: string, destination: string) {
    if (!await this.grant(principal, accountId, destination, 1)) denied();
    const [configuration] = await this.service.stores.core.listConfigurations(accountId);
    if (!configuration) denied();
    // Provisioning is the trusted control plane. Buyers persist these facts,
    // then independently select a closed UTC day; returned resource URLs never
    // determine either their IAM prefix or their expected semantic contract.
    const start = configuration.schedule.anchor;
    const end = new Date(new Date(start).getTime() + 86_400_000).toISOString();
    return { installed_at: configuration.installedAt, expected: await this.expectedPeriod(accountId, configuration.configurationId, start, end) };
  }

  async replaceNotifications(principal: string, accountId: string, configs: NotificationSubscriptionConfigInput[]) {
    if (!await this.owns(principal, accountId)) denied();
    return this.service.notifications.replace({ kind: 'account', tenantId: 'sales', principalId: principal, accountId }, configs);
  }
  async revoke(principal: string, accountId: string, destination: string, generation: number): Promise<boolean> {
    if (!await this.owns(principal, accountId)) denied();
    return this.service.stores.managed.revokeDestination({ account_id: accountId, destination_ref: destination, generation, revoked_at: new Date().toISOString() });
  }
  start(onError?: (error: unknown) => void): void {
    this.service.start({ deploymentWide: true, intervalMilliseconds: 15_000, maxObligationsPerAccount: 4, maxWorkerIterationsPerAccount: 2,
      executionDeadlineMilliseconds: limits.operationMilliseconds, notificationRecoveryLimit: 25, webhookRecoveryLimit: 10,
      ...(onError ? { onError } : { logger: { warn: message => logger.error({ diagnostic: message }, 'Durable reporting scheduler failed') } }) });
  }
  async probe(): Promise<boolean> {
    if (this.stopping) return false;
    await this.db.query('SELECT 1');
    await this.service.notifications.probe();
    if (!await this.service.stores.managed.probeObjectWriteAuthority()) return false;
    const authority = await this.service.stores.managed.getObjectWriteAuthorityId();
    await createGcsReportingObjectFenceV1({ storage: this.storage, store: this.service.stores.managed, bucket: this.config.bucket,
      namespace: sha256(canonicalize([this.config.namespace, authority])), operationDeadlineMilliseconds: 10_000 }).probe();
    return true;
  }
  async drain(): Promise<void> {
    this.stopping = true;
    await this.service.stop();
  }
  async stop(): Promise<void> {
    await this.drain();
    await this.db.end();
  }
  assertServing(): void { if (this.stopping) unavailable(); }
}

let runtime: TrainingGcsReporting | undefined;
export function getTrainingGcsReporting(): TrainingGcsReporting | undefined {
  if (trainingGcsReportingConfig() && !runtime) unavailable();
  runtime?.assertServing();
  return runtime;
}
export async function initializeTrainingGcsReporting(): Promise<void> {
  const config = trainingGcsReportingConfig();
  if (!config || runtime) return;
  const database = getDatabaseConfig();
  if (!database) throw new Error('Reporting requires the application PostgreSQL primary.');
  const db = new Pool({ connectionString: database.connectionString, ssl: database.ssl, max: 4,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
    options: `-c search_path=${TRAINING_REPORTING_SCHEMA},pg_catalog -c statement_timeout=30000 -c lock_timeout=5000` });
  db.on('error', () => logger.error('Reporting PostgreSQL pool failed'));
  try {
    runtime = await TrainingGcsReporting.create(config, db, new Storage({ projectId: 'adcp-production', keyFilename: config.credentialsFile, timeout: 10_000, retryOptions: { totalTimeout: 30, maxRetries: 2 } }));
  } catch {
    await db.end();
    throw new Error('Durable GCS reporting initialization failed; check authority, migrations, credentials and bucket policy.');
  }
}
export async function stopTrainingGcsReporting(): Promise<void> { await runtime?.stop(); }
export async function drainTrainingGcsReporting(): Promise<void> { await runtime?.drain(); }
