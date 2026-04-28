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

import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
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
 *  buyer collapse; falls back to the request's idempotency_key.
 *
 *  Scoped by the caller's principal so two buyers sharing the public sandbox
 *  token who happen to land on the same deterministic response entity id
 *  (e.g. both get `mb_abc123`) produce distinct webhook idempotency_keys.
 *  Without the prefix, a receiver that dedupes across tenants on
 *  `idempotency_key` would drop the second buyer's event as a duplicate of
 *  the first. The principal is the same scoped string the request-side
 *  idempotency cache uses (`scopedPrincipal(auth, accountScope)`), so both
 *  caches partition identically. */
export function deriveWebhookOperationId(
  toolName: string,
  response: Record<string, unknown>,
  requestIdempotencyKey: string | undefined,
  principal: string,
): string {
  for (const field of ['media_buy_id', 'creative_id', 'activation_id', 'signal_activation_id', 'task_id', 'list_id', 'account_id']) {
    const v = response[field];
    if (typeof v === 'string' && v.length > 0) return `${principal}|${toolName}.${v}`;
  }
  if (requestIdempotencyKey) return `${principal}|${toolName}.${requestIdempotencyKey}`;
  return `${principal}|${toolName}.${randomUUID()}`;
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
