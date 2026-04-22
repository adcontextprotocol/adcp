/**
 * Webhook signing and emission for the training agent.
 *
 * Uses `@adcp/client/server`'s `createWebhookEmitter` to post RFC 9421-signed
 * completion webhooks with stable `idempotency_key` per logical event and
 * retry/backoff on 5xx/429. The signer uses a single Ed25519 keypair sourced
 * from `WEBHOOK_SIGNING_KEY_JWK` (a private JWK) when configured, or a
 * freshly-generated key at startup for dev mode.
 *
 * Public key is published at `/.well-known/jwks.json` on the training agent
 * router so buyers can verify incoming webhooks against a real JWKS endpoint.
 */

import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  createWebhookEmitter,
  memoryWebhookKeyStore,
  type WebhookEmitter,
} from '@adcp/client/server';
import type { SignerKey } from '@adcp/client/signing';
import type { AdcpJsonWebKey } from '@adcp/client/signing';
import { createLogger } from '../logger.js';

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

const TOOL_TO_PROTOCOL: Readonly<Record<WebhookEmittingTool, WebhookProtocol>> = {
  create_media_buy: 'media-buy',
  update_media_buy: 'media-buy',
  sync_creatives: 'media-buy',
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
};

function extractWebhookUrl(args: Record<string, unknown>): string | undefined {
  const pnc = args.push_notification_config as { url?: unknown } | undefined;
  if (!pnc || typeof pnc !== 'object') return undefined;
  return typeof pnc.url === 'string' && pnc.url.length > 0 ? pnc.url : undefined;
}

/** Derive a stable logical event id for webhook idempotency. Two emissions
 *  with the same operation_id reuse the same `idempotency_key` across retries.
 *  Prefers a buyer-facing entity id from the response so retries from the same
 *  buyer collapse; falls back to the request's idempotency_key. */
function deriveWebhookOperationId(
  toolName: string,
  response: Record<string, unknown>,
  requestIdempotencyKey: string | undefined,
): string {
  for (const field of ['media_buy_id', 'creative_id', 'activation_id', 'signal_activation_id', 'task_id', 'list_id', 'account_id']) {
    const v = response[field];
    if (typeof v === 'string' && v.length > 0) return `${toolName}.${v}`;
  }
  if (requestIdempotencyKey) return `${toolName}.${requestIdempotencyKey}`;
  return `${toolName}.${randomUUID()}`;
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
}): void {
  const webhookUrl = extractWebhookUrl(opts.args);
  if (!webhookUrl || !(opts.toolName in TOOL_TO_TASK_TYPE)) return;
  const tool = opts.toolName as WebhookEmittingTool;

  const emitter = getWebhookEmitter();
  const operationId = deriveWebhookOperationId(opts.toolName, opts.response, opts.requestIdempotencyKey);
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

let signerKey: SignerKey | null = null;
let publicJwk: AdcpJsonWebKey | null = null;
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
  // Public JWK is the private JWK minus `d`.
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

function ensureKey(): { signer: SignerKey; publicJwk: AdcpJsonWebKey } {
  if (signerKey && publicJwk) return { signer: signerKey, publicJwk };
  const raw = process.env[ENV_KEY];
  const material = raw ? loadConfiguredKey(raw) : generateEphemeralKey();
  signerKey = material.signer;
  publicJwk = material.publicJwk;
  if (!raw) {
    logger.warn(
      { kid: signerKey.keyid },
      `Training agent webhook signing key generated ephemerally. Set ${ENV_KEY} for stable keys across restarts.`,
    );
  }
  return material;
}

export function getPublicJwks(): { keys: AdcpJsonWebKey[] } {
  const { publicJwk: pub } = ensureKey();
  return { keys: [pub] };
}

/** Expose the webhook signer to framework-server config (`webhooks: { signerKey }`). */
export function getWebhookSigningKey(): SignerKey {
  return ensureKey().signer;
}

export function getWebhookEmitter(): WebhookEmitter {
  if (emitter) return emitter;
  const { signer } = ensureKey();
  emitter = createWebhookEmitter({
    signerKey: signer,
    idempotencyKeyStore: memoryWebhookKeyStore(),
    userAgent: 'adcp-training-agent/1.0',
  });
  return emitter;
}

/** Reset state — tests only. */
export function resetWebhookSigning(): void {
  signerKey = null;
  publicJwk = null;
  emitter = null;
}
