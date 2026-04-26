/**
 * Webhook signing and emission for the training agent.
 *
 * Uses `@adcp/client/server`'s `createWebhookEmitter` to post RFC 9421-signed
 * completion webhooks with stable `idempotency_key` per logical event and
 * retry/backoff on 5xx/429.
 *
 * Production (`GCP_KMS_WEBHOOK_KEY_VERSION` set): routes signing through a
 * GCP KMS-backed `SigningProvider`. Private key material never enters
 * process memory. Key separation per AdCP spec — a distinct
 * `cryptoKeyVersion` from the request-signing path.
 *
 * Dev (env unset): falls back to either `WEBHOOK_SIGNING_KEY_JWK` (a
 * stable private JWK) or a freshly-generated key at startup.
 *
 * Public key is published at the root `/.well-known/jwks.json` (with
 * `adcp_use: "webhook-signing"`) and at the training-agent's own
 * `/api/training-agent/.well-known/jwks.json` for legacy callers.
 */

import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  createWebhookEmitter,
  memoryWebhookKeyStore,
  type WebhookEmitter,
} from '@adcp/client/server';
import type { SignerKey, SigningProvider } from '@adcp/client/signing';
import type { AdcpJsonWebKey } from '@adcp/client/signing';
import { createLogger } from '../logger.js';
import { createWebhookFetch } from './webhook-fetch.js';
import { getWebhookSigningProvider } from '../security/gcp-kms-signer.js';
import {
  WEBHOOK_SIGNING_KID,
  WEBHOOK_SIGNING_PUBLIC_KEY_PEM,
} from '../security/expected-public-key.js';

const logger = createLogger('training-agent-webhooks');

/** MCP webhook envelope's `task_type` enum. Only tools in this map emit a
 *  completion webhook when the caller supplies `push_notification_config.url`.
 *  Keep in sync with `static/schemas/source/core/mcp-webhook-payload.json`. */
export type WebhookTaskType =
  | 'create_media_buy' | 'update_media_buy' | 'sync_creatives' | 'activate_signal'
  | 'get_signals' | 'create_property_list' | 'update_property_list' | 'get_property_list'
  | 'list_property_lists' | 'delete_property_list' | 'sync_accounts'
  | 'get_account_financials' | 'get_creative_delivery' | 'sync_event_sources'
  | 'sync_audiences' | 'sync_catalogs' | 'log_event' | 'get_brand_identity'
  | 'get_rights' | 'acquire_rights';

export const TOOL_TO_TASK_TYPE = {
  create_media_buy: 'create_media_buy',
  update_media_buy: 'update_media_buy',
  sync_creatives: 'sync_creatives',
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
} as const;

export type WebhookEmittingTool = keyof typeof TOOL_TO_TASK_TYPE;

export const TOOL_TO_PROTOCOL: Record<WebhookEmittingTool, 'mcp' | 'a2a'> = {
  create_media_buy: 'mcp', update_media_buy: 'mcp', sync_creatives: 'mcp',
  activate_signal: 'mcp', get_signals: 'mcp', create_property_list: 'mcp',
  update_property_list: 'mcp', get_property_list: 'mcp', list_property_lists: 'mcp',
  delete_property_list: 'mcp', sync_accounts: 'mcp', get_account_financials: 'mcp',
  get_creative_delivery: 'mcp', sync_event_sources: 'mcp', sync_audiences: 'mcp',
  sync_catalogs: 'mcp', log_event: 'mcp', get_brand_identity: 'mcp',
  get_rights: 'mcp', acquire_rights: 'mcp',
};

/**
 * Extract the webhook URL from tool arguments. Caller drops the optional
 * `push_notification_config.{url,authentication}` fields onto the request;
 * we sign only the URL.
 */
function extractWebhookUrl(args: Record<string, unknown>): string | undefined {
  const pnc = args.push_notification_config;
  if (!pnc || typeof pnc !== 'object') return undefined;
  const url = (pnc as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

/** A stable, deterministic key for the operation a webhook represents. */
export function deriveWebhookOperationId(
  toolName: string,
  response: Record<string, unknown>,
  requestIdempotencyKey: string | undefined,
  principal: string,
): string {
  const taskId = typeof response.task_id === 'string' ? response.task_id : null;
  const seed = taskId ?? requestIdempotencyKey ?? randomUUID();
  return createHash('sha256').update(principal).update('').update(toolName).update('').update(seed).digest('hex').slice(0, 32);
}

/** Fire-and-forget completion webhook emission. The `toolName` is `string`
 *  (not `WebhookEmittingTool`) because callers — `task-handlers.ts:3750`
 *  and `framework-server.ts:265` — operate on the AdCP server's full tool
 *  surface, not just the webhook-emitting subset. The runtime guard below
 *  filters to the subset before dispatching. */
export function maybeEmitCompletionWebhook(opts: {
  toolName: string;
  args: Record<string, unknown>;
  response: Record<string, unknown>;
  requestIdempotencyKey?: string;
  principal: string;
}): void {
  if (!opts.principal) {
    throw new Error('maybeEmitCompletionWebhook: principal must be a non-empty string (callers must pass the same caller-uniqueness key used for the request-side idempotency cache)');
  }
  const webhookUrl = extractWebhookUrl(opts.args);
  if (!webhookUrl || !(opts.toolName in TOOL_TO_TASK_TYPE)) return;
  const tool = opts.toolName as WebhookEmittingTool;

  const emitter = getWebhookEmitter();
  const operationId = deriveWebhookOperationId(opts.toolName, opts.response, opts.requestIdempotencyKey, opts.principal);
  const webhookTaskId = (opts.response.task_id as string | undefined)
    ?? `tsk_${operationId.slice(0, 32).replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
  const payload: Record<string, unknown> = {
    task_id: webhookTaskId,
    task_type: TOOL_TO_TASK_TYPE[tool],
    protocol: TOOL_TO_PROTOCOL[tool],
    status: 'completed',
    timestamp: new Date().toISOString(),
    result: opts.response,
  };
  void emitter.emit({ url: webhookUrl, payload, operation_id: operationId })
    .catch(err => logger.warn({ err, tool: opts.toolName, url: webhookUrl }, 'Webhook emission failed'));
}

const ENV_KEY = 'WEBHOOK_SIGNING_KEY_JWK';
const KMS_WEBHOOK_ENV = 'GCP_KMS_WEBHOOK_KEY_VERSION';

type WebhookMaterial =
  | { kind: 'kms'; signerProvider: SigningProvider; publicJwk: AdcpJsonWebKey }
  | { kind: 'inline'; signerKey: SignerKey; publicJwk: AdcpJsonWebKey };

let material: WebhookMaterial | null = null;
let emitter: WebhookEmitter | null = null;

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
    adcp_use: 'webhook-signing',
    key_ops: ['sign'],
  };
  const pubJwk: AdcpJsonWebKey = {
    ...publicJwkRaw as AdcpJsonWebKey,
    kid,
    alg: 'EdDSA',
    adcp_use: 'webhook-signing',
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
  const signer: SignerKey = {
    keyid: jwk.kid,
    alg: 'ed25519',
    privateKey: {
      ...jwk,
      alg: 'EdDSA',
      adcp_use: 'webhook-signing',
      key_ops: ['sign'],
    },
  };
  const { d: _drop, ...publicOnly } = jwk;
  const pubJwk: AdcpJsonWebKey = {
    ...publicOnly,
    alg: 'EdDSA',
    adcp_use: 'webhook-signing',
    key_ops: ['verify'],
    use: 'sig',
  };
  return { signer, publicJwk: pubJwk };
}

/**
 * Synchronous SigningProvider wrapper around the lazy KMS-backed
 * webhook-signing provider. The wire identity (`keyid`, `algorithm`,
 * `fingerprint`) is known statically from committed constants, so we can
 * hand a fully-shaped provider to `createWebhookEmitter` without waiting
 * for the KMS round-trip. The first `sign()` call resolves the underlying
 * KMS provider (cached singleton in `gcp-kms-signer.ts`) and delegates;
 * the tripwire / algorithm assertion fires there.
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

function ensureMaterial(): WebhookMaterial {
  if (material) return material;
  const kmsKeyVersion = process.env[KMS_WEBHOOK_ENV];
  if (kmsKeyVersion) {
    const publicJwk = buildPublicJwkFromPem(WEBHOOK_SIGNING_PUBLIC_KEY_PEM, WEBHOOK_SIGNING_KID);
    material = {
      kind: 'kms',
      signerProvider: buildKmsWebhookProviderWrapper(kmsKeyVersion),
      publicJwk,
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

function buildPublicJwkFromPem(pem: string, kid: string): AdcpJsonWebKey {
  // Inline import to keep this module's own surface lean.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey } = require('node:crypto') as typeof import('node:crypto');
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

export function getPublicJwks(): { keys: AdcpJsonWebKey[] } {
  return { keys: [ensureMaterial().publicJwk] };
}

/** Material handed to `createAdcpServer({ webhooks })` — exactly one of
 *  `signerKey` or `signerProvider` per the SDK's discriminated config. */
export function getWebhookSigningMaterial():
  | { signerKey: SignerKey }
  | { signerProvider: SigningProvider } {
  const m = ensureMaterial();
  return m.kind === 'kms'
    ? { signerProvider: m.signerProvider }
    : { signerKey: m.signerKey };
}

export function getWebhookEmitter(): WebhookEmitter {
  if (emitter) return emitter;
  const m = ensureMaterial();
  // Production (`NODE_ENV=production`, i.e. fly.io) refuses webhook delivery
  // to private/loopback/metadata addresses. Dev and CI need loopback for
  // conformance storyboards using `http://127.0.0.1:<port>` receivers.
  const allowPrivateIp = process.env.NODE_ENV !== 'production';
  emitter = createWebhookEmitter({
    ...(m.kind === 'kms' ? { signerProvider: m.signerProvider } : { signerKey: m.signerKey }),
    idempotencyKeyStore: memoryWebhookKeyStore(),
    userAgent: 'adcp-training-agent/1.0',
    fetch: createWebhookFetch({ allowPrivateIp }),
  });
  return emitter;
}

/** Reset state — tests only. */
export function resetWebhookSigning(): void {
  material = null;
  emitter = null;
}
