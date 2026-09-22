import { describe, expect, it, vi } from 'vitest';

const encryption = vi.hoisted(() => ({ deriveKey: vi.fn(() => Buffer.alloc(32, 17)) }));
vi.mock('../../src/db/encryption.js', () => encryption);

import { agentQualityEvaluationFingerprint } from '../../src/db/agent-quality-evaluation-identity.js';

const storedRepresentation = JSON.stringify(['context-one', 'bearer', '2026-09-22 12:00:00.123456+00']);

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
      .toBe('697624df998c56fb76de1293f68f1479f04dfd5acbbbe69a1e1e11819ffef798');
  });

  it('distinguishes row generations separated by one microsecond', () => {
    const original = agentQualityEvaluationFingerprint('oauth-authorization-code', storedRepresentation);
    const changed = agentQualityEvaluationFingerprint(
      'oauth-authorization-code',
      JSON.stringify(['context-one', 'bearer', '2026-09-22 12:00:00.123457+00']),
    );
    expect(changed).not.toBe(original);
  });
});
