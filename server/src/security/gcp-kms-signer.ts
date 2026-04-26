/**
 * GCP KMS-backed RFC 9421 SigningProvider for Addie's outbound AdCP requests.
 *
 * Reads two Fly secrets:
 *   - GCP_SA_JSON: service-account credentials JSON (IAM identity)
 *   - GCP_KMS_KEY_VERSION: full resource name
 *     `projects/.../keyRings/.../cryptoKeys/.../cryptoKeyVersions/N`
 *
 * On first call, builds a `KeyManagementServiceClient`, fetches the public
 * key, asserts it's Ed25519, and asserts it matches the committed PEM at
 * `expected-public-key.pem`. Mismatch fails loudly — tripwire against an
 * out-of-band key swap in GCP that would otherwise silently re-sign with
 * an unexpected key.
 *
 * Singleton — one provider per process. The KMS client is fetched lazily so
 * boot doesn't fail in dev where the secrets aren't set.
 */

import { createPublicKey } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { SigningProvider } from '@adcp/client/signing';
import { createLogger } from '../logger.js';
import { EXPECTED_PUBLIC_KEY_PEM } from './expected-public-key.js';

const logger = createLogger('gcp-kms-signer');

export const KID = 'aao-signing-2026-04';
export const ALGORITHM = 'ed25519' as const;

const KMS_ALG_ED25519 = 'EC_SIGN_ED25519';
const KMS_ALG_P256 = 'EC_SIGN_P256_SHA256';

let cached: { provider: SigningProvider; publicKeyPem: string } | null = null;
let initInFlight: Promise<{ provider: SigningProvider; publicKeyPem: string }> | null = null;

/**
 * Returns the GCP KMS-backed signing provider, or null if env vars are
 * unset (dev / non-signing deployments). Throws if env is set but
 * misconfigured — fail-fast so a half-configured production deploy
 * doesn't silently fall through to unsigned requests.
 *
 * Only successful init is cached. Transient KMS errors (network blip
 * during `getPublicKey`) are retried on the next call rather than
 * permanently sticking the process. Concurrent callers share one
 * in-flight init promise so a thundering herd doesn't fan out into
 * many `getPublicKey` calls.
 */
export async function getGcpKmsSigningProvider(): Promise<SigningProvider | null> {
  if (cached) return cached.provider;

  const saJson = process.env.GCP_SA_JSON;
  const keyVersion = process.env.GCP_KMS_KEY_VERSION;

  if (!saJson && !keyVersion) {
    return null;
  }
  if (!saJson || !keyVersion) {
    throw new Error(
      'GCP KMS signing partially configured: both GCP_SA_JSON and GCP_KMS_KEY_VERSION must be set, or neither.'
    );
  }

  if (!initInFlight) {
    initInFlight = (async () => {
      const credentials = parseServiceAccountJson(saJson);
      const client = new KeyManagementServiceClient({ credentials });
      return buildProvider(client, keyVersion);
    })().finally(() => {
      // Release the in-flight slot once the promise settles. Success-cache
      // is set in the .then below; failure is retried on the next call.
      initInFlight = null;
    });
  }

  const result = await initInFlight;
  cached = result;
  logger.info(
    { kid: KID, algorithm: ALGORITHM, keyVersion: redactKeyVersion(keyVersion) },
    'GCP KMS signing provider initialized'
  );
  return result.provider;
}

/**
 * Returns the cached PEM public key after `getGcpKmsSigningProvider()` has
 * been called at least once. Used by the JWKS endpoint to publish the key.
 */
export function getCachedPublicKeyPem(): string | null {
  return cached?.publicKeyPem ?? null;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GCP_SA_JSON is not valid JSON: ${(err as Error).message}`);
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
  keyVersion: string
): Promise<{ provider: SigningProvider; publicKeyPem: string }> {
  const [pubResp] = await client.getPublicKey({ name: keyVersion });
  const kmsAlgorithm = pubResp.algorithm ?? '';
  const pem = pubResp.pem ?? '';
  if (!pem) {
    throw new Error(`GCP KMS getPublicKey returned no PEM for ${redactKeyVersion(keyVersion)}`);
  }
  if (kmsAlgorithm !== KMS_ALG_ED25519) {
    throw new Error(
      `GCP KMS key ${redactKeyVersion(keyVersion)} has algorithm '${kmsAlgorithm}', expected '${KMS_ALG_ED25519}'`
    );
  }

  assertPublicKeyMatchesCommitted(pem, keyVersion);

  const provider: SigningProvider = {
    keyid: KID,
    algorithm: ALGORITHM,
    fingerprint: keyVersion,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      const [resp] = await client.asymmetricSign({
        name: keyVersion,
        data: payload,
      });
      const sig = coerceSignature(resp.signature);
      return sig;
    },
  };

  return { provider, publicKeyPem: pem };
}

function coerceSignature(value: Buffer | Uint8Array | string | null | undefined): Uint8Array {
  if (value == null) {
    throw new Error('GCP KMS asymmetricSign returned no signature bytes');
  }
  if (typeof value === 'string') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * Tripwire: compare the KMS-returned PEM to the one committed in this repo.
 * Different bytes mean the GCP key was rotated or replaced without a
 * corresponding code change — refuse to sign rather than emit signatures
 * verifiers (looking at the published JWKS) will reject.
 *
 * Comparison is on the SPKI public-key bytes, not the raw PEM string, so
 * formatting differences (line endings, header capitalization) don't
 * trigger false positives.
 */
function assertPublicKeyMatchesCommitted(actualPem: string, keyVersion: string): void {
  const actualSpki = createPublicKey(actualPem).export({ type: 'spki', format: 'der' }) as Buffer;
  const expectedSpki = createPublicKey(EXPECTED_PUBLIC_KEY_PEM).export({ type: 'spki', format: 'der' }) as Buffer;
  if (!actualSpki.equals(expectedSpki)) {
    throw new Error(
      `GCP KMS public key for ${redactKeyVersion(keyVersion)} does not match the committed expected key. ` +
        `If the key was rotated, update server/src/security/expected-public-key.ts and redeploy.`
    );
  }
}

function redactKeyVersion(keyVersion: string): string {
  // Logs go to PostHog/OpenTelemetry; the resource name isn't a secret but
  // there's no reason to spray the project ID through every log line.
  return keyVersion.replace(/projects\/[^/]+/, 'projects/<redacted>');
}

/** Test-only — drop the cached provider so a subsequent call re-initializes. */
export function resetGcpKmsSignerForTests(): void {
  cached = null;
  initInFlight = null;
}
