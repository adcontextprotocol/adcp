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

import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  createWebhookEmitter,
  memoryWebhookKeyStore,
  type WebhookEmitter,
} from '@adcp/client/server';
import type { SignerKey } from '@adcp/client/signing';
import type { AdcpJsonWebKey } from '@adcp/client/signing';
import { createLogger } from '../logger.js';

const logger = createLogger('training-agent-webhooks');

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
