import { describe, it, expect } from 'vitest';
import { validateAuthTokenChars } from '../../src/db/agent-context-db.js';

describe('validateAuthTokenChars', () => {
  it('accepts a normal bearer token', () => {
    expect(validateAuthTokenChars('token-1')).toBeNull();
    expect(validateAuthTokenChars('a.b.c')).toBeNull();
  });

  it('accepts an empty string (caller decides whether empty means clear)', () => {
    expect(validateAuthTokenChars('')).toBeNull();
  });

  it('accepts visible-ASCII punctuation common in tokens', () => {
    expect(validateAuthTokenChars('punct.~+/=')).toBeNull();
  });

  it('rejects tokens containing a NUL byte (Postgres TEXT-column crash vector)', () => {
    expect(validateAuthTokenChars('abc\u0000def')).toMatch(/invalid characters/i);
  });

  it('rejects a NUL byte at the tail (the failure mode from the InMobi report)', () => {
    expect(validateAuthTokenChars('mytoken\u0000')).toMatch(/invalid characters/i);
    expect(validateAuthTokenChars('\u0000mytoken')).toMatch(/invalid characters/i);
  });

  it('rejects CR or LF (HTTP header-injection vectors)', () => {
    expect(validateAuthTokenChars('abc\rdef')).toMatch(/invalid characters/i);
    expect(validateAuthTokenChars('abc\ndef')).toMatch(/invalid characters/i);
    expect(validateAuthTokenChars('abc\r\ndef')).toMatch(/invalid characters/i);
  });

  // Pin the "narrow" decision: we reject only the three characters that are
  // definitively dangerous (Postgres TEXT crash + HTTP header injection).
  // Bearer tokens in the wild can be opaque — a future PR that quietly
  // broadens this regex to all C0 control bytes would break legitimate
  // provider tokens. This test catches that drift.
  it('does NOT reject other control bytes (kept narrow on purpose)', () => {
    expect(validateAuthTokenChars('abc\u0001def')).toBeNull();
    expect(validateAuthTokenChars('abc\u001Fdef')).toBeNull();
    expect(validateAuthTokenChars('abc\u007Fdef')).toBeNull();
    expect(validateAuthTokenChars('abc\tdef')).toBeNull();
  });

  // Defense-in-depth: a Basic-auth token is base64 (visible-ASCII), so the
  // outer validator can't see a NUL hidden in the decoded user:pass. The
  // hint sanitizer in getTokenHint strips it before the hint is written to
  // the auth_token_hint TEXT column. We exercise the outer validator here
  // and assert the base64 envelope passes — the hint sanitizer is covered
  // implicitly by the saveAuthToken path used by save_agent.
  it('accepts Basic-auth base64 envelopes even when the decoded payload contains a NUL', () => {
    const evilBasic = Buffer.from('u\u0000:p').toString('base64');
    expect(validateAuthTokenChars(evilBasic)).toBeNull();
  });
});
