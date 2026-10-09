import { createHmac } from 'node:crypto';
import { deriveKey } from './encryption.js';

type EvaluationIdentityDomain =
  | 'row-generation'
  | 'auth-scope'
  | 'request';

let identityKey: Buffer | undefined;

/**
 * Replica-stable, keyed identities for non-secret row generation markers and
 * request metadata. Derive a dedicated key from the existing server encryption
 * secret once per process; never use an organization's at-rest encryption key.
 * Fixed domains separate row generation, scope, and request identities. Callers
 * pass row IDs, selected modes, timestamps, and request metadata; never
 * credential ciphertext, IVs, configuration, or decrypted credential material.
 */
export function agentQualityEvaluationFingerprint(domain: EvaluationIdentityDomain, value: string): string {
  identityKey ??= deriveKey('addie:agent-quality-evaluation:identity:v1');
  return createHmac('sha256', identityKey)
    .update(JSON.stringify([domain, value]))
    .digest('hex');
}
