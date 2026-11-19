// A server-suite worker runs with Node's compile cache on, in the directory
// its environment names (server/vitest.config.ts defaults it; see
// tests/node-compile-cache.test.ts for the rule). Skipped when the caller
// turned the cache off; under v8 coverage vitest does that itself by setting
// NODE_DISABLE_COMPILE_CACHE.
import { getCompileCacheDir } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const off = process.env.NODE_DISABLE_COMPILE_CACHE !== undefined || process.env.NODE_COMPILE_CACHE === '';

describe('server-suite worker', () => {
  it.skipIf(off)('compiles natively loaded modules through the shared compile cache', () => {
    const configured = process.env.NODE_COMPILE_CACHE;
    expect(configured, 'NODE_COMPILE_CACHE in the worker environment').toBeTruthy();
    const dir = getCompileCacheDir();
    expect(dir, 'module.getCompileCacheDir()').toBeTruthy();
    expect(path.relative(path.resolve(configured!), dir!).startsWith('..')).toBe(false);
  });
});
