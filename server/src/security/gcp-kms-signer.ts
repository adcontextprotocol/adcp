/**
 * GCP KMS-backed RFC 9421 SigningProviders for Addie.
 *
 * Two providers, one per AdCP signing purpose (request vs webhook). AdCP
 * requires distinct key material per purpose; both providers wrap a
 * different `cryptoKeyVersion` under the same KMS keyring with the shared
 * service account.
 *
 * Reads three Fly secrets:
 *   - GCP_SA_JSON: service-account credentials JSON (shared IAM identity)
 *   - GCP_KMS_KEY_VERSION: cryptoKeyVersion for outbound AdCP request signing
 *   - GCP_KMS_WEBHOOK_KEY_VERSION: cryptoKeyVersion for webhook signing
 *
 * On first call per provider, fetches the public key, asserts it's
 * Ed25519, and asserts it matches the committed PEM. Mismatch fails
 * loudly — tripwire against an out-of-band key swap in GCP that would
 * silently re-sign with an unexpected key.
 *
 * Singleton per purpose. Lazy init so dev (no env) boots; production
 * pays the `getPublicKey` round-trip on the first signed call.
 */

import { createPublicKey } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { SigningProvider } from '@adcp/client/signing';
import { createLogger } from '../logger.js';
import {
  ALGORITHM,
  REQUEST_SIGNING_KID,
  REQUEST_SIGNING_PUBLIC_KEY_PEM,
  WEBHOOK_SIGNING_KID,
  WEBHOOK_SIGNING_PUBLIC_KEY_PEM,
} from './expected-public-key.js';

const logger = createLogger('gcp-kms-signer');

const KMS_ALG_ED25519 = 'EC_SIGN_ED25519';

interface SignerSpec {
  /** Logical name for logs. */
  purpose: 'request-signing' | 'webhook-signing';
  /** Fly secret holding the cryptoKeyVersion path. */
  keyVersionEnvVar: 'GCP_KMS_KEY_VERSION' | 'GCP_KMS_WEBHOOK_KEY_VERSION';
  /** Wire `kid` published in `Signature-Input` and at the JWKS endpoint. */
  kid: string;
  /** Committed PEM the signer must match at init. */
  expectedPem: string;
}

const REQUEST_SPEC: SignerSpec = {
  purpose: 'request-signing',
  keyVersionEnvVar: 'GCP_KMS_KEY_VERSION',
  kid: REQUEST_SIGNING_KID,
  expectedPem: REQUEST_SIGNING_PUBLIC_KEY_PEM,
};

const WEBHOOK_SPEC: SignerSpec = {
  purpose: 'webhook-signing',
  keyVersionEnvVar: 'GCP_KMS_WEBHOOK_KEY_VERSION',
  kid: WEBHOOK_SIGNING_KID,
  expectedPem: WEBHOOK_SIGNING_PUBLIC_KEY_PEM,
};

interface ProviderState {
  cached: SigningProvider | null;
  initInFlight: Promise<SigningProvider> | null;
}

const requestState: ProviderState = { cached: null, initInFlight: null };
const webhookState: ProviderState = { cached: null, initInFlight: null };

/**
 * Returns the GCP KMS-backed signing provider for outbound AdCP request
 * signing, or null if env vars are unset (dev / non-signing deployments).
 * Throws if env is set but misconfigured.
 */
export function getRequestSigningProvider(): Promise<SigningProvider | null> {
  return getProvider(REQUEST_SPEC, requestState);
}

/**
 * Returns the GCP KMS-backed signing provider for webhook signing, or
 * null if env vars are unset. Distinct key material from the
 * request-signing provider per AdCP's key-separation requirement.
 */
export function getWebhookSigningProvider(): Promise<SigningProvider | null> {
  return getProvider(WEBHOOK_SPEC, webhookState);
}

async function getProvider(spec: SignerSpec, state: ProviderState): Promise<SigningProvider | null> {
  if (state.cached) return state.cached;

  const saJson = process.env.GCP_SA_JSON;
  const keyVersion = process.env[spec.keyVersionEnvVar];

  if (!saJson && !keyVersion) {
    return null;
  }
  if (!saJson || !keyVersion) {
    throw new Error(
      `GCP KMS ${spec.purpose} partially configured: both GCP_SA_JSON and ${spec.keyVersionEnvVar} must be set, or neither.`
    );
  }

  if (!state.initInFlight) {
    state.initInFlight = (async () => {
      const credentials = parseServiceAccountJson(saJson);
      const client = new KeyManagementServiceClient({ credentials });
      const provider = await buildProvider(client, spec, keyVersion);
      state.cached = provider;
      logger.info(
        { purpose: spec.purpose, kid: spec.kid, algorithm: ALGORITHM, keyVersion: redactKeyVersion(keyVersion) },
        'GCP KMS signing provider initialized'
      );
      return provider;
    })().finally(() => {
      state.initInFlight = null;
    });
  }

  return state.initInFlight;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Don't include the parser detail — the offset/character it cites can
    // quote bytes from the malformed value, including private-key fragments.
    throw new Error('GCP_SA_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('GCP_SA_JSON must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const client_email = typeof obj.client_email === 'string' ? obj.client_email : null;
  const private_key = typeof obj.private_key === 'string' ? obj.private_key : null;
  if (!client_email || !private_key) {
    throw new Error('GCP_SA_JSON must contain `client_email` and `private_key` fields');
  }
  return { client_email, private_key };
}

async function buildProvider(
  client: KeyManagementServiceClient,
  spec: SignerSpec,
  keyVersion: string
): Promise<SigningProvider> {
  const [pubResp] = await client.getPublicKey({ name: keyVersion });
  const kmsAlgorithm = pubResp.algorithm ?? '';
  const pem = pubResp.pem ?? '';
  if (!pem) {
    throw new Error(`GCP KMS getPublicKey returned no PEM for ${spec.purpose} (${redactKeyVersion(keyVersion)})`);
  }
  if (kmsAlgorithm !== KMS_ALG_ED25519) {
    throw new Error(
      `GCP KMS ${spec.purpose} key ${redactKeyVersion(keyVersion)} has algorithm '${kmsAlgorithm}', expected '${KMS_ALG_ED25519}'`
    );
  }

  assertPublicKeyMatchesCommitted(pem, spec, keyVersion);

  return {
    keyid: spec.kid,
    algorithm: ALGORITHM,
    fingerprint: keyVersion,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      const [resp] = await client.asymmetricSign({
        name: keyVersion,
        data: payload,
      });
      return coerceSignature(resp.signature);
    },
  };
}

function coerceSignature(value: Buffer | Uint8Array | string | null | undefined): Uint8Array {
  if (value == null) {
    throw new Error('GCP KMS asymmetricSign returned no signature bytes');
  }
  if (typeof value === 'string') {
    // The Node KMS client returns Buffer in practice; the string union is
    // declared by the proto-generated types but doesn't appear at runtime.
    // Refuse rather than guess at an encoding.
    throw new Error('GCP KMS asymmetricSign returned a string signature; expected Buffer/Uint8Array');
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * Tripwire: compare the KMS-returned PEM to the one committed in this repo
 * for the given purpose. Different bytes mean the GCP key was rotated or
 * replaced without a corresponding code change — refuse to sign rather than
 * emit signatures verifiers (looking at the published JWKS) will reject.
 *
 * Comparison is on the SPKI public-key bytes, not the raw PEM string, so
 * formatting differences (line endings, header capitalization) don't
 * trigger false positives.
 */
function assertPublicKeyMatchesCommitted(actualPem: string, spec: SignerSpec, keyVersion: string): void {
  const actualSpki = createPublicKey(actualPem).export({ type: 'spki', format: 'der' }) as Buffer;
  const expectedSpki = createPublicKey(spec.expectedPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (!actualSpki.equals(expectedSpki)) {
    throw new Error(
      `GCP KMS ${spec.purpose} public key for ${redactKeyVersion(keyVersion)} does not match the committed expected key. ` +
        `If the key was rotated, update server/src/security/expected-public-key.ts and redeploy.`
    );
  }
}

function redactKeyVersion(keyVersion: string): string {
  // Logs go to PostHog/OpenTelemetry; the resource name isn't a secret but
  // there's no reason to spray the project ID through every log line.
  return keyVersion.replace(/projects\/[^/]+/, 'projects/<redacted>');
}

/** Test-only — drop both cached providers so subsequent calls re-initialize. */
export function resetGcpKmsSignerForTests(): void {
  requestState.cached = null;
  requestState.initInFlight = null;
  webhookState.cached = null;
  webhookState.initInFlight = null;
}
