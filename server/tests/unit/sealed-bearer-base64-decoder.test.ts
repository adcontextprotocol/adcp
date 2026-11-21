// A malformed sealed bearer is a client error (401) whichever base64 decoder
// the WorkOS SDK chose when it loaded. The SDK decodes with
// Uint8Array.fromBase64 when the runtime has the TC39 base64 API (built in
// from V8 14 / Node 25, or installed by a polyfill such as the core-js that
// pdf-parse bundles), and with atob otherwise; it decides once, at module
// evaluation (@workos-inc/node lib/factory-*.mjs, `jsBase64Enabled`). For the
// same bad character atob throws a DOMException named InvalidCharacterError
// and Uint8Array.fromBase64 throws a SyntaxError.
//
// api-key-validation-timeout.test.ts drives the SDK instance this worker
// already loaded, usually the atob one. This file evaluates a fresh instance
// of the SDK's CommonJS build while the TC39 API is present, so the other
// decoder runs whatever ran earlier in the worker. The API is present only
// during that evaluation and during each test (the SDK looks it up per call),
// and the fresh instance leaves the require cache after the file.
import { createRequire } from 'node:module';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_server_test';
  process.env.WORKOS_CLIENT_ID = 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

// The TC39 Uint8Array base64 API, counting decodes. Where the runtime lacks
// it, a Buffer-backed stand-in that throws SyntaxError for characters outside
// the alphabet, as the built-in does.
const base64Api = vi.hoisted(() => {
  type FromBase64 = (input: string, options?: { alphabet?: 'base64' | 'base64url' }) => Uint8Array;
  type Encode = (this: Uint8Array, options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }) => string;
  const saved = {
    fromBase64: Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64'),
    toBase64: Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64'),
    toHex: Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex'),
  };
  const alphabets = { base64: /^[A-Za-z0-9+/]*={0,2}$/, base64url: /^[A-Za-z0-9_-]*={0,2}$/ };
  const decode: FromBase64 = (saved.fromBase64?.value as FromBase64 | undefined) ?? ((input, options) => {
    const alphabet = options?.alphabet ?? 'base64';
    if (!alphabets[alphabet].test(input)) throw new SyntaxError('Invalid character in base64 string');
    return new Uint8Array(Buffer.from(input, alphabet));
  });
  const toBase64: Encode = (saved.toBase64?.value as Encode | undefined) ?? function (options) {
    const text = Buffer.from(this).toString(options?.alphabet === 'base64url' ? 'base64url' : 'base64');
    return options?.omitPadding ? text.replace(/=+$/, '') : text;
  };
  const toHex = (saved.toHex?.value as ((this: Uint8Array) => string) | undefined) ?? function (this: Uint8Array) {
    return Buffer.from(this).toString('hex');
  };
  const state = { decodes: 0 };
  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
  return {
    state,
    install() {
      define(Uint8Array, 'fromBase64', ((input, options) => { state.decodes += 1; return decode(input, options); }) as FromBase64);
      define(Uint8Array.prototype, 'toBase64', toBase64);
      define(Uint8Array.prototype, 'toHex', toHex);
    },
    restore() {
      for (const [target, key, descriptor] of [
        [Uint8Array, 'fromBase64', saved.fromBase64],
        [Uint8Array.prototype, 'toBase64', saved.toBase64],
        [Uint8Array.prototype, 'toHex', saved.toHex],
      ] as const) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete (target as unknown as Record<string, unknown>)[key];
      }
    },
  };
});

const freshSdk = vi.hoisted(() => {
  let sdkDir: string | undefined;
  const forget = (require: NodeJS.Require) => {
    for (const id of Object.keys(require.cache)) if (sdkDir && id.startsWith(sdkDir)) delete require.cache[id];
  };
  return {
    // Evaluate the actual SDK again, with the TC39 API present.
    load(require: NodeJS.Require) {
      sdkDir = require.resolve('@workos-inc/node').replace(/[^\\/]+$/, '');
      forget(require);
      base64Api.install();
      try { return require('@workos-inc/node'); } finally { base64Api.restore(); }
    },
    forget,
  };
});

vi.mock('@workos-inc/node', () => freshSdk.load(createRequire(import.meta.url)));
import { optionalAuth, requireAuth, stopAuthTimers } from '../../src/middleware/auth.js';

function request(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    path: '/api/test', originalUrl: '/api/test', accepts: () => false,
  } as unknown as Request;
}
function response(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  base64Api.state.decodes = 0;
  base64Api.install();
});
afterEach(() => { base64Api.restore(); });
afterAll(() => { stopAuthTimers(); freshSdk.forget(createRequire(import.meta.url)); });

describe('malformed sealed bearer under the SDK decoder Uint8Array.fromBase64', () => {
  it.each([['requireAuth', requireAuth], ['optionalAuth', optionalAuth]] as const)('%s answers 401, not 503', async (name, authenticate) => {
    const res = response();
    const next = vi.fn();
    // Well-formed seal layout; the HMAC part holds a character outside base64url.
    await authenticate(request(`Fe26.2*1*salt*iv*encrypted**${name}*!~2`), res, next);
    expect(base64Api.state.decodes).toBeGreaterThan(0);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
