/**
 * Webhook signing and emission for the training agent.
 *
 * Uses `@adcp/sdk/server`'s `createWebhookEmitter` to post RFC 9421-signed
 * completion webhooks with stable `idempotency_key` per logical event and
 * retry/backoff on 5xx/429. The signer uses a single Ed25519 keypair sourced
 * from `WEBHOOK_SIGNING_KEY_JWK` (a private JWK) when configured, or a
 * freshly-generated key at startup for dev mode.
 *
 * Public key is published at `/.well-known/jwks.json` on the training agent
 * router so buyers can verify incoming webhooks against a real JWKS endpoint.
 */

import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  createWebhookEmitter,
  memoryWebhookDeliveryStore,
  type WebhookEmitter,
  type WebhookAuthentication,
  type WebhookDeliveryRecovery,
  type WebhookDeliveryStore,
  type WebhookEmitParams,
  type WebhookEmitResult,
} from '@adcp/sdk/server';
import type { SignerKey, SigningProvider } from '@adcp/sdk/signing';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';
import { isDatabaseInitialized } from '../db/client.js';
import { createTrainingWebhookFetch } from './webhook-fetch.js';
import { getWebhookSigningProvider } from '../security/gcp-kms-signer.js';
import {
  WEBHOOK_SIGNING_KID,
  WEBHOOK_SIGNING_PUBLIC_KEY_PEM,
} from '../security/expected-public-key.js';
import { PostgresWebhookDeliveryPersistence } from './webhook-delivery-store.js';

const logger = createLogger('training-agent-webhooks');

/** MCP webhook envelope's `task_type` enum. Only tools in this map emit a
 *  completion webhook when the caller supplies `push_notification_config.url`.
 *  Keep in sync with `static/schemas/source/core/mcp-webhook-payload.json`. */
export type WebhookTaskType =
  | 'create_media_buy' | 'update_media_buy' | 'sync_creatives' | 'build_creative'
  | 'get_products' | 'request_proposals' | 'refine_proposals' | 'decline_proposals'
  | 'activate_signal'
  | 'get_signals' | 'create_property_list' | 'update_property_list' | 'get_property_list'
  | 'list_property_lists' | 'delete_property_list' | 'sync_accounts'
  | 'get_account_financials' | 'get_creative_delivery' | 'sync_event_sources'
  | 'sync_audiences' | 'sync_catalogs' | 'log_event' | 'get_brand_identity'
  | 'get_rights' | 'acquire_rights' | 'update_rights';

export const TOOL_TO_TASK_TYPE = {
  get_products: 'get_products',
  request_proposals: 'request_proposals',
  refine_proposals: 'refine_proposals',
  decline_proposals: 'decline_proposals',
  create_media_buy: 'create_media_buy',
  update_media_buy: 'update_media_buy',
  sync_creatives: 'sync_creatives',
  build_creative: 'build_creative',
  activate_signal: 'activate_signal',
  get_signals: 'get_signals',
  create_property_list: 'create_property_list',
  update_property_list: 'update_property_list',
  get_property_list: 'get_property_list',
  list_property_lists: 'list_property_lists',
  delete_property_list: 'delete_property_list',
  sync_accounts: 'sync_accounts',
  get_account_financials: 'get_account_financials',
  get_creative_delivery: 'get_creative_delivery',
  sync_event_sources: 'sync_event_sources',
  sync_audiences: 'sync_audiences',
  sync_catalogs: 'sync_catalogs',
  log_event: 'log_event',
  get_brand_identity: 'get_brand_identity',
  get_rights: 'get_rights',
  acquire_rights: 'acquire_rights',
  update_rights: 'update_rights',
} as const satisfies Record<string, WebhookTaskType>;

type WebhookEmittingTool = keyof typeof TOOL_TO_TASK_TYPE;

/** AdCP protocol domain for each webhook-emitting tool. Values are the kebab-case
 *  enum from `enums/adcp-protocol.json`. Matches the spec's operational grouping:
 *  creative operations bundled into a media-buy seller stamp as `media-buy`
 *  (see `core/mcp-webhook-payload.json` example where `sync_creatives` → `media-buy`);
 *  dedicated brand / signals / governance tools stamp their own domain. The
 *  `Record<WebhookEmittingTool, ...>` type forces this map to stay in sync with
 *  `TOOL_TO_TASK_TYPE` — adding a tool there without a protocol here fails tsc. */
type WebhookProtocol = 'media-buy' | 'signals' | 'governance' | 'creative' | 'brand' | 'sponsored-intelligence';

export const TOOL_TO_PROTOCOL: Readonly<Record<WebhookEmittingTool, WebhookProtocol>> = {
  get_products: 'media-buy',
  request_proposals: 'media-buy',
  refine_proposals: 'media-buy',
  decline_proposals: 'media-buy',
  create_media_buy: 'media-buy',
  update_media_buy: 'media-buy',
  sync_creatives: 'media-buy',
  build_creative: 'creative',
  get_creative_delivery: 'media-buy',
  sync_event_sources: 'media-buy',
  sync_audiences: 'media-buy',
  sync_catalogs: 'media-buy',
  log_event: 'media-buy',
  sync_accounts: 'governance',
  get_account_financials: 'governance',
  activate_signal: 'signals',
  get_signals: 'signals',
  create_property_list: 'governance',
  update_property_list: 'governance',
  get_property_list: 'governance',
  list_property_lists: 'governance',
  delete_property_list: 'governance',
  get_brand_identity: 'brand',
  get_rights: 'brand',
  acquire_rights: 'brand',
  update_rights: 'brand',
};

function extractWebhookUrl(args: Record<string, unknown>): string | undefined {
  const pnc = args.push_notification_config as { url?: unknown } | undefined;
  if (!pnc || typeof pnc !== 'object') return undefined;
  return typeof pnc.url === 'string' && pnc.url.length > 0 ? pnc.url : undefined;
}

/** Extract the buyer-supplied `operation_id` from `push_notification_config`.
 *  Per the MCP webhook payload contract, this value MUST be echoed verbatim
 *  on the wire — sellers MUST NOT derive it from the URL or from seller-side
 *  state. See [`push-notification-config.json`](/schemas/core/push-notification-config.json)
 *  and `docs/building/by-layer/L3/webhooks.mdx#operation-ids-and-url-templates`. */
function extractBuyerOperationId(args: Record<string, unknown>): string | undefined {
  const pnc = args.push_notification_config as { operation_id?: unknown } | undefined;
  if (!pnc || typeof pnc !== 'object') return undefined;
  return typeof pnc.operation_id === 'string' && pnc.operation_id.length > 0 ? pnc.operation_id : undefined;
}

function extractWebhookToken(args: Record<string, unknown>): string | undefined {
  const pnc = args.push_notification_config as { token?: unknown } | undefined;
  if (!pnc || typeof pnc !== 'object') return undefined;
  return typeof pnc.token === 'string' && pnc.token.length > 0 ? pnc.token : undefined;
}

function extractWebhookAuthentication(args: Record<string, unknown>): WebhookAuthentication | undefined {
  const pnc = args.push_notification_config as {
    authentication?: { schemes?: unknown; credentials?: unknown };
  } | undefined;
  const authentication = pnc?.authentication;
  if (!authentication || typeof authentication !== 'object'
      || !Array.isArray(authentication.schemes)
      || typeof authentication.credentials !== 'string') return undefined;
  if (authentication.schemes[0] === 'Bearer') {
    return { type: 'bearer', token: authentication.credentials };
  }
  if (authentication.schemes[0] === 'HMAC-SHA256') {
    return { type: 'hmac_sha256', secret: authentication.credentials };
  }
  return undefined;
}

/** Derive a stable scope key for the **webhook delivery store** — NOT the
 *  wire-level `operation_id`. Two emissions with the same scope key reuse the
 *  same payload `idempotency_key` across retries. Prefers the request's
 *  idempotency key because it names one logical fire; falls back to a
 *  buyer-facing response entity only when the request has no such identity.
 *
 *  Scoped by the caller's principal so two buyers sharing the public sandbox
 *  token who happen to land on the same deterministic response entity id
 *  (e.g. both get `mb_abc123`) produce distinct webhook idempotency_keys.
 *  Without the principal input, a receiver that dedupes across tenants on
 *  `idempotency_key` would drop the second buyer's event as a duplicate of
 *  the first. The principal is the same scoped string the request-side
 *  idempotency cache uses (`scopedPrincipal(auth, accountScope)`), so both
 *  caches partition identically.
 *
 *  The returned delivery ID is an opaque digest: neither the seller-side
 *  principal nor the request key is persisted or placed on the wire. The
 *  wire `operation_id` field comes from the buyer-supplied configuration
 *  (see `extractBuyerOperationId`). */
export function deriveWebhookIdempotencyScope(
  toolName: string,
  response: Record<string, unknown>,
  requestIdempotencyKey: string | undefined,
  principal: string,
): string {
  const opaqueDeliveryId = (kind: string, value: string): string => `whd_${createHash('sha256')
    .update(JSON.stringify([principal, toolName, kind, value]), 'utf8')
    .digest('hex')}`;
  // A request idempotency key identifies the exact logical fire. Prefer it
  // over response entity IDs: two intentional updates to one media buy must
  // not collide merely because both responses contain the same media_buy_id.
  // Exact request retries, conversely, retain one delivery identity.
  if (requestIdempotencyKey) return opaqueDeliveryId('request', requestIdempotencyKey);
  for (const field of ['media_buy_id', 'creative_id', 'activation_id', 'signal_activation_id', 'task_id', 'list_id', 'account_id']) {
    const v = response[field];
    if (typeof v === 'string' && v.length > 0) return opaqueDeliveryId(field, v);
  }
  return opaqueDeliveryId('random', randomUUID());
}

/**
 * Fire a completion webhook for a successful tool call if the buyer supplied
 * `push_notification_config.url` and the tool maps to a webhook task type.
 *
 * Fire-and-forget: the emitter handles RFC 9421 signing, `idempotency_key`
 * stability across retries, and retry/backoff on 5xx/429 internally. Any
 * delivery failure is logged but never surfaces to the caller — the sync
 * response has already been returned.
 *
 * Shared between legacy dispatch (`task-handlers.ts`) and the framework
 * adapter (`framework-server.ts`) so both paths emit byte-identical envelopes.
 */
export function maybeEmitCompletionWebhook(opts: {
  toolName: string;
  args: Record<string, unknown>;
  response: Record<string, unknown>;
  requestIdempotencyKey?: string;
  /** Caller-uniqueness key for webhook idempotency. Pass the same value the
   *  request-side idempotency store uses for this caller (legacy dispatch
   *  passes `scopedPrincipal(auth, accountScope)`; the framework path passes
   *  `auth` directly except for `static:public` where it scopes by account).
   *  Two distinct callers MUST produce distinct strings here, otherwise
   *  receivers that dedupe across tenants on `idempotency_key` may drop one
   *  caller's webhook as a duplicate of another's. Empty strings are rejected
   *  fail-fast — they would silently degrade scoping to "no partitioning". */
  principal: string;
}): void {
  if (!opts.principal) {
    throw new Error('maybeEmitCompletionWebhook: principal must be a non-empty string (callers must pass the same caller-uniqueness key used for the request-side idempotency cache)');
  }
  const webhookUrl = extractWebhookUrl(opts.args);
  if (!webhookUrl || !(opts.toolName in TOOL_TO_TASK_TYPE)) return;
  const tool = opts.toolName as WebhookEmittingTool;

  const emitter = getWebhookEmitter().forTenantScope(tenantScopeFromTrustedValue(opts.principal));
  const idempotencyScope = deriveWebhookIdempotencyScope(opts.toolName, opts.response, opts.requestIdempotencyKey, opts.principal);
  const webhookTaskId = (opts.response.task_id as string | undefined)
    ?? `tsk_${idempotencyScope.slice(4, 36)}`;
  // Wire `operation_id` MUST be the buyer-supplied value. When the buyer
  // registers without one (non-conformant per push-notification-config.json,
  // but tolerated for sandbox testing), fall back to `task_id` — a buyer-
  // visible identifier that's part of the response either way. Never emit
  // the principal-scoped `idempotencyScope` on the wire: it embeds the
  // seller-side auth token.
  const wireOperationId = extractBuyerOperationId(opts.args) ?? webhookTaskId;
  const token = extractWebhookToken(opts.args);
  const payload: Record<string, unknown> = {
    operation_id: wireOperationId,
    task_id: webhookTaskId,
    task_type: TOOL_TO_TASK_TYPE[tool],
    protocol: TOOL_TO_PROTOCOL[tool],
    status: 'completed',
    timestamp: new Date().toISOString(),
    ...(token !== undefined && { token }),
    result: opts.response,
  };
  const authentication = extractWebhookAuthentication(opts.args);
  void emitter.emit({
    url: webhookUrl,
    payload,
    delivery_id: idempotencyScope,
    ...(authentication !== undefined && { authentication }),
  })
    .catch(err => logger.warn({ err, tool: opts.toolName, url: webhookUrl }, 'Webhook emission failed'));
}

export async function emitAccountNotificationWebhook(opts: {
  url: string;
  payload: Record<string, unknown>;
  operationId: string;
  notificationType: string;
  authentication?: WebhookAuthentication;
}): Promise<WebhookEmitResult> {
  const emitter = getWebhookEmitter().forTenantScope(tenantScopeFromTrustedValue(
    `${opts.notificationType}:${opts.operationId.split(':', 1)[0] ?? 'unknown'}`,
  ));
  return emitter.emit({
    url: opts.url,
    payload: opts.payload,
    delivery_id: opts.operationId,
    ...(opts.authentication !== undefined && { authentication: opts.authentication }),
  });
}

export interface PropertyListChangedWebhookParams {
  url: string;
  listId: string;
  listName: string;
  operationId: string;
  resolvedAt: string;
  cacheValidUntil: string;
  changeSummary: {
    properties_added?: number;
    properties_removed?: number;
    total_properties: number;
  };
}

/** Emit an RFC 9421-only property-list change notification.
 *
 * Property-list registration exposes only `webhook_url`, not an
 * authentication-mode selector. The deprecated body `signature` remains a
 * required literal marker through 3.x for schema compatibility; it has no
 * authentication semantics. */
export function emitPropertyListChangedWebhook(opts: PropertyListChangedWebhookParams): void {
  const payload: Record<string, unknown> = {
    event: 'property_list_changed',
    list_id: opts.listId,
    list_name: opts.listName,
    change_summary: opts.changeSummary,
    resolved_at: opts.resolvedAt,
    cache_valid_until: opts.cacheValidUntil,
    signature: 'rfc9421',
  };

  void getWebhookEmitter().forTenantScope('property-list-notifications').emit({
    url: opts.url,
    payload,
    delivery_id: opts.operationId,
  }).catch(err => logger.warn(
    { err, listId: opts.listId, url: opts.url },
    'Property-list change webhook emission failed',
  ));
}

const ENV_KEY = 'WEBHOOK_SIGNING_KEY_JWK';
const KMS_WEBHOOK_ENV = 'GCP_KMS_WEBHOOK_KEY_VERSION';

type WebhookMaterial =
  | { kind: 'kms'; signerProvider: SigningProvider; publicJwk: AdcpJsonWebKey }
  | { kind: 'inline'; signerKey: SignerKey; publicJwk: AdcpJsonWebKey };

let material: WebhookMaterial | null = null;
let emitter: WebhookEmitter | null = null;
let durablePersistence: PostgresWebhookDeliveryPersistence | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryRunning = false;

const WEBHOOK_PUBLISHER_SCOPE = 'adcp-training-agent';
const DEFAULT_WEBHOOK_TENANT_SCOPE = 'training-agent-system';
const DELIVERY_RETRY_HORIZON_SECONDS = 86_400;
const RECOVERY_POLL_MS = 60_000;

function requiresDurableWebhookState(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';
}

function getDurablePersistence(): PostgresWebhookDeliveryPersistence {
  durablePersistence ??= new PostgresWebhookDeliveryPersistence();
  return durablePersistence;
}

function tenantScopeFromTrustedValue(value: string): string {
  return `tenant-${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function generateEphemeralKey(): { signer: SignerKey; publicJwk: AdcpJsonWebKey } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateJwkRaw = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const publicJwkRaw = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const keyMaterial = String(publicJwkRaw.x ?? '');
  const kid = `training-${createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16)}`;
  const privateJwk: AdcpJsonWebKey = {
    ...privateJwkRaw as AdcpJsonWebKey,
    kid,
    alg: 'EdDSA',
    adcp_use: 'request-signing',
    key_ops: ['sign'],
  };
  const pubJwk: AdcpJsonWebKey = {
    ...publicJwkRaw as AdcpJsonWebKey,
    kid,
    alg: 'EdDSA',
    adcp_use: 'request-signing',
    key_ops: ['verify'],
    use: 'sig',
  };
  return {
    signer: { keyid: kid, alg: 'ed25519', privateKey: privateJwk },
    publicJwk: pubJwk,
  };
}

function loadConfiguredKey(raw: string): { signer: SignerKey; publicJwk: AdcpJsonWebKey } {
  const jwk = JSON.parse(raw) as AdcpJsonWebKey;
  if (!jwk.kid || !jwk.kty || !jwk.d || !jwk.x) {
    throw new Error(`${ENV_KEY} must be a full private JWK with kid, kty, x, d fields`);
  }
  if (jwk.adcp_use !== undefined && jwk.adcp_use !== 'request-signing' && jwk.adcp_use !== 'webhook-signing') {
    throw new Error(`${ENV_KEY} adcp_use must be request-signing or webhook-signing`);
  }
  // Preserve the declared purpose for stable configured kids. Missing purpose
  // means a pre-migration key; retain the historical webhook-only authority
  // rather than silently expanding it to signed requests.
  const keyPurpose = jwk.adcp_use ?? 'webhook-signing';
  const signer: SignerKey = {
    keyid: jwk.kid,
    alg: 'ed25519',
    privateKey: {
      ...jwk,
      alg: 'EdDSA',
      adcp_use: keyPurpose,
      key_ops: ['sign'],
    },
  };
  // Public JWK is the private JWK minus `d`.
  const { d: _drop, ...publicOnly } = jwk;
  const pubJwk: AdcpJsonWebKey = {
    ...publicOnly,
    alg: 'EdDSA',
    adcp_use: keyPurpose,
    key_ops: ['verify'],
    use: 'sig',
  };
  return { signer, publicJwk: pubJwk };
}

/**
 * Synchronous SigningProvider wrapper around the lazy KMS-backed
 * webhook-signing provider. The wire identity (`keyid`, `algorithm`,
 * `fingerprint`) is known statically from committed constants, so we
 * hand a fully-shaped provider to `createWebhookEmitter` without
 * blocking on a KMS round-trip at startup. The first `sign()` call
 * resolves the underlying KMS singleton in `gcp-kms-signer.ts`; the
 * tripwire / algorithm assertion fires there.
 */
function buildKmsWebhookProviderWrapper(keyVersion: string): SigningProvider {
  return {
    keyid: WEBHOOK_SIGNING_KID,
    algorithm: 'ed25519',
    fingerprint: keyVersion,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      const provider = await getWebhookSigningProvider();
      if (!provider) {
        throw new Error(
          'GCP KMS webhook signing unavailable at sign-time despite env being set. Check structured logs for init failure.'
        );
      }
      return provider.sign(payload);
    },
  };
}

function publicJwkFromPem(pem: string, kid: string): AdcpJsonWebKey {
  const raw = createPublicKey(pem).export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string };
  if (raw.kty !== 'OKP' || raw.crv !== 'Ed25519' || typeof raw.x !== 'string') {
    throw new Error('Webhook public key is not Ed25519 OKP');
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: raw.x,
    kid,
    alg: 'EdDSA',
    adcp_use: 'webhook-signing',
    key_ops: ['verify'],
    use: 'sig',
  } as AdcpJsonWebKey;
}

function ensureMaterial(): WebhookMaterial {
  if (material) return material;
  const kmsKeyVersion = process.env[KMS_WEBHOOK_ENV];
  if (kmsKeyVersion) {
    material = {
      kind: 'kms',
      signerProvider: buildKmsWebhookProviderWrapper(kmsKeyVersion),
      publicJwk: publicJwkFromPem(WEBHOOK_SIGNING_PUBLIC_KEY_PEM, WEBHOOK_SIGNING_KID),
    };
    logger.info({ kid: WEBHOOK_SIGNING_KID }, 'Webhook signing routes through GCP KMS');
    return material;
  }
  const raw = process.env[ENV_KEY];
  const m = raw ? loadConfiguredKey(raw) : generateEphemeralKey();
  if (!raw) {
    logger.warn(
      { kid: m.signer.keyid },
      `Training agent webhook signing key generated ephemerally. Set ${ENV_KEY} or ${KMS_WEBHOOK_ENV} for stable keys across restarts.`,
    );
  }
  material = { kind: 'inline', signerKey: m.signer, publicJwk: m.publicJwk };
  return material;
}

export function getPublicJwks(): { keys: AdcpJsonWebKey[] } {
  return { keys: [ensureMaterial().publicJwk] };
}

/** Expose the webhook signer to framework-server config — exactly one of
 *  `signerKey` or `signerProvider` per the SDK's discriminated config. */
export function getWebhookSigningMaterial():
  | ({ signerKey: SignerKey } & {
      publisherScope?: string;
      deliveryStore?: WebhookDeliveryStore;
      deliveryRecovery?: WebhookDeliveryRecovery;
      deliveryRetryHorizonSeconds?: number;
      fetch?: typeof fetch;
      userAgent?: string;
    })
  | ({ signerProvider: SigningProvider } & {
      publisherScope?: string;
      deliveryStore?: WebhookDeliveryStore;
      deliveryRecovery?: WebhookDeliveryRecovery;
      deliveryRetryHorizonSeconds?: number;
      fetch?: typeof fetch;
      userAgent?: string;
    }) {
  const m = ensureMaterial();
  const durableConfig = requiresDurableWebhookState()
    ? {
        publisherScope: WEBHOOK_PUBLISHER_SCOPE,
        deliveryStore: getDurablePersistence(),
        deliveryRecovery: getDurablePersistence(),
        deliveryRetryHorizonSeconds: DELIVERY_RETRY_HORIZON_SECONDS,
      }
    : {};
  const emitterConfig = {
    ...durableConfig,
    userAgent: 'adcp-training-agent/1.0',
    fetch: createTrainingWebhookFetch(),
  };
  if (requiresDurableWebhookState() && !emitter) {
    // Tenant servers are constructed before the database pool. Queue the
    // recovery emitter so it exists for restart replay without making tenant
    // registration perform I/O; the worker waits for DB initialization.
    queueMicrotask(() => { getWebhookEmitter(); });
  }
  return m.kind === 'kms'
    ? { signerProvider: m.signerProvider, ...emitterConfig }
    : { signerKey: m.signerKey, ...emitterConfig };
}

async function recoverPendingWebhookDeliveries(): Promise<void> {
  if (!emitter || !durablePersistence || recoveryRunning || !isDatabaseInitialized()) return;
  recoveryRunning = true;
  try {
    const deliveries = await durablePersistence.claimRecoverable(WEBHOOK_PUBLISHER_SCOPE);
    for (const delivery of deliveries) {
      try {
        const result = await emitter.forTenantScope(delivery.key.tenantScope).emit(delivery.params);
        if (!result.delivered) {
          const horizonEnd = delivery.createdAtMs + DELIVERY_RETRY_HORIZON_SECONDS * 1_000;
          if (Date.now() >= horizonEnd) {
            await durablePersistence.settle(delivery.key, 'terminal');
            logger.warn(
              { deliveryId: delivery.key.deliveryId },
              'Webhook recovery horizon elapsed; terminalized pending delivery',
            );
          } else {
            await durablePersistence.releaseRecoverable(delivery.key, RECOVERY_POLL_MS);
          }
        }
      } catch (err) {
        const horizonEnd = delivery.createdAtMs + DELIVERY_RETRY_HORIZON_SECONDS * 1_000;
        if (Date.now() >= horizonEnd) {
          await durablePersistence.settle(delivery.key, 'terminal');
        } else {
          await durablePersistence.releaseRecoverable(delivery.key, RECOVERY_POLL_MS);
        }
        logger.warn(
          { err, deliveryId: delivery.key.deliveryId },
          'Pending webhook recovery attempt failed',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Webhook recovery outbox scan failed');
  } finally {
    recoveryRunning = false;
  }
}

function startWebhookRecoveryWorker(): void {
  if (!requiresDurableWebhookState() || recoveryTimer) return;
  void recoverPendingWebhookDeliveries();
  recoveryTimer = setInterval(() => {
    void recoverPendingWebhookDeliveries();
  }, RECOVERY_POLL_MS);
  recoveryTimer.unref?.();
}

/** Return the only training-agent webhook emitter.
 *
 * Completion and property-list change notifications route through this
 * emitter. Storage-time URL validation is not sufficient: this fetch policy
 * repeats validation at delivery time and pins the public address at connect
 * time. */
export function getWebhookEmitter(): WebhookEmitter {
  if (emitter) return emitter;
  const m = ensureMaterial();
  const durable = requiresDurableWebhookState() ? getDurablePersistence() : undefined;
  emitter = createWebhookEmitter({
    ...(m.kind === 'kms' ? { signerProvider: m.signerProvider } : { signerKey: m.signerKey }),
    deliveryStore: durable ?? memoryWebhookDeliveryStore(),
    ...(durable !== undefined && { deliveryRecovery: durable }),
    publisherScope: WEBHOOK_PUBLISHER_SCOPE,
    tenantScope: DEFAULT_WEBHOOK_TENANT_SCOPE,
    deliveryRetryHorizonSeconds: DELIVERY_RETRY_HORIZON_SECONDS,
    userAgent: 'adcp-training-agent/1.0',
    fetch: createTrainingWebhookFetch(),
  });
  startWebhookRecoveryWorker();
  return emitter;
}

export async function emitFrameworkTaskWebhook(params: WebhookEmitParams): Promise<WebhookEmitResult> {
  const taskId = typeof params.payload.task_id === 'string' ? params.payload.task_id : undefined;
  return getWebhookEmitter().forTenantScope('framework-task-notifications').emit({
    ...params,
    payload: {
      ...params.payload,
      operation_id: params.payload.operation_id ?? taskId,
    },
  });
}

/** Reset state — tests only. */
export function resetWebhookSigning(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  recoveryRunning = false;
  material = null;
  emitter = null;
  durablePersistence = null;
}
