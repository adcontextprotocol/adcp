import { describe, expect, it, vi } from 'vitest';

const encryption = vi.hoisted(() => ({ deriveKey: vi.fn(() => Buffer.alloc(32, 17)) }));
vi.mock('../../src/db/encryption.js', () => encryption);

import { agentQualityEvaluationFingerprint } from '../../src/db/agent-quality-evaluation-identity.js';

const storedRepresentation = JSON.stringify(['context-one', 'encrypted-generation-one', 'nonce-one']);

describe('keyed evaluation identity', () => {
  it('derives its dedicated key once and is deterministic for the same stored representation', () => {
    expect(encryption.deriveKey).not.toHaveBeenCalled();
    const digest = agentQualityEvaluationFingerprint('static-credential', storedRepresentation);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(agentQualityEvaluationFingerprint('static-credential', storedRepresentation)).toBe(digest);
    expect(encryption.deriveKey).toHaveBeenCalledExactlyOnceWith('addie:agent-quality-evaluation:identity:v1');
  });

  it('separates credential modes, auth scopes, and request identities', () => {
    const domains = [
      'static-credential', 'oauth-authorization-code', 'oauth-client-credentials', 'auth-scope', 'request',
    ] as const;
    const digests = domains.map(domain => agentQualityEvaluationFingerprint(domain, storedRepresentation));
    expect(new Set(digests).size).toBe(domains.length);
  });

  it('matches an independently computed keyed HMAC vector', () => {
    // Python hmac/hashlib reference vector: 32-byte 0x11 key, UTF-8 JSON
    // [domain, storedRepresentation], compact separators. Detects regression
    // to an unkeyed digest or a changed identity encoding.
    expect(agentQualityEvaluationFingerprint('static-credential', storedRepresentation))
      .toBe('323aaf6aaf6afc096a7e5f53c86e44efc505391c1cc0ef6c2b64b2125e8e2558');
  });

  it('distinguishes changed generation bytes', () => {
    const original = agentQualityEvaluationFingerprint('oauth-authorization-code', storedRepresentation);
    const changed = agentQualityEvaluationFingerprint(
      'oauth-authorization-code',
      JSON.stringify(['context-one', 'encrypted-generation-two', 'nonce-two']),
    );
    expect(changed).not.toBe(original);
  });
});
