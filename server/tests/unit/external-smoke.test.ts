import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testCapabilityDiscovery, type TestOptions } from '@adcp/sdk/testing';
import { boundedDiscovery, checkProbe, MAX_ATTEMPTS, SmokeFailure } from '../../../scripts/external-smoke/check.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = 'https://smoke.example.com/mcp';
const options: TestOptions = { auth: { type: 'bearer', token: 'test-only' } };
type Result = Awaited<ReturnType<typeof testCapabilityDiscovery>>;
const success = (): Result => ({
  profile: { name: 'Test agent', tools: ['get_products'], adcp_version: 'v3', supported_protocols: ['media_buy'] },
  steps: [{ step: 'Discover agent capabilities', task: 'getAgentInfo', passed: true, duration_ms: 0 }],
});
const failure = (error: string): Result => ({
  profile: { name: 'Unknown', tools: [] },
  steps: [{ step: 'Discover agent capabilities', task: 'getAgentInfo', passed: false, duration_ms: 0, error }],
});
const resolved = { storyboards: ['test'], bundles: ['test'] } as unknown as ReturnType<typeof import('@adcp/sdk/testing').resolveStoryboardsForCapabilities>;

afterEach(() => vi.restoreAllMocks());

describe('external smoke discovery', () => {
  it('aborts a never-settling real SDK transport within budget, drains requests, and isolates the next attempt', async () => {
    const unscopedFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unscoped network request'));
    let active = 0;
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      active++;
      const signal = init!.signal!;
      signals.push(signal);
      const abort = () => { active--; reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }));
    const attempts: AbortSignal[] = [];
    const discover = vi.fn<typeof testCapabilityDiscovery>((endpoint, opts) => {
      attempts.push(opts.signal!);
      expect(opts.transport?.requestTimeoutMs).toBe(2000);
      return testCapabilityDiscovery(endpoint, opts);
    });
    const start = performance.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(boundedDiscovery(url, options, {
        discover, fetchFn, attemptTimeoutMs: 250, requestTimeoutMs: 2000,
      })).rejects.toMatchObject({ kind: 'transient' });
      expect(active).toBe(0);
    }
    expect(performance.now() - start).toBeLessThan(2000);
    expect(fetchFn).toHaveBeenCalled();
    expect(unscopedFetch).not.toHaveBeenCalled();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
    const next = vi.fn<typeof testCapabilityDiscovery>(async (_endpoint, opts) => {
      expect(opts.signal?.aborted).toBe(false);
      expect(attempts).not.toContain(opts.signal);
      return success();
    });
    await expect(boundedDiscovery(url, options, { discover: next })).resolves.toEqual(success());
  });

  it('the real SDK consumes the explicit request timeout before the longer attempt budget', async () => {
    let active = 0;
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      active++;
      const abort = () => { active--; reject(init!.signal!.reason); };
      if (init!.signal!.aborted) abort();
      else init!.signal!.addEventListener('abort', abort, { once: true });
    }));
    const start = performance.now();
    const result = await boundedDiscovery(url, options, { fetchFn, attemptTimeoutMs: 2000, requestTimeoutMs: 50 });
    expect(result.steps.some(step => !step.passed)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(active).toBe(0);
    await expect(checkProbe(url, options, {}, false, { discover: async () => result }))
      .rejects.toMatchObject({ kind: 'transient' });
  });

  it('bounds SDK calls that omit the signal and prevents late calls from starting another request', async () => {
    let active = 0;
    let lateFetch: typeof fetch;
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      active++;
      init!.signal!.addEventListener('abort', () => { active--; reject(init!.signal!.reason); }, { once: true });
    }));
    const discover = vi.fn<typeof testCapabilityDiscovery>(async (_endpoint, opts) => {
      lateFetch = opts.transport!.trustedFetchFn!;
      await lateFetch(url); // Deliberately omit signal, like rc.35's second call.
      return success();
    });
    await expect(boundedDiscovery(url, options, { discover, fetchFn, attemptTimeoutMs: 20 })).rejects.toMatchObject({ kind: 'transient' });
    expect(active).toBe(0);
    await expect(lateFetch!(url)).rejects.toMatchObject({ kind: 'transient' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('classifies auth failure with a truthy empty profile using failed discovery evidence', async () => {
    const discover = vi.fn().mockResolvedValue(failure('HTTP 401 Unauthorized'));
    const resolve = vi.fn();
    await expect(checkProbe(url, {}, {}, true, { discover, resolve })).resolves.toBe('auth-required');
    expect(discover).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    await expect(checkProbe(url, options, {}, false, { discover, resolve })).rejects.toMatchObject({ kind: 'auth' });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it.each(['missing step', 'failed step', 'skipped step', 'empty tools', 'missing version', 'empty versions'])(
    'rejects public discovery with %s', async condition => {
      const result = success();
      if (condition === 'missing step') result.steps = [];
      if (condition === 'failed step') result.steps[0].passed = false;
      if (condition === 'skipped step') result.steps[0].skipped = true;
      if (condition === 'empty tools') result.profile!.tools = [];
      if (condition === 'missing version') delete result.profile!.adcp_version;
      if (condition === 'empty versions') result.profile!.adcp_supported_versions = [];
      const discover = vi.fn().mockResolvedValue(result);
      await expect(checkProbe(url, {}, {}, true, { discover })).rejects.toThrow();
      expect(discover).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])('discovers exactly once before local resolver assertions (anonymous=%s)', async anonymous => {
    const discover = vi.fn().mockResolvedValue(success());
    const resolve = vi.fn<typeof import('@adcp/sdk/testing').resolveStoryboardsForCapabilities>(() => {
      expect(discover).toHaveBeenCalledExactlyOnceWith(url, anonymous ? {} : options);
      return resolved;
    });
    await expect(checkProbe(url, anonymous ? {} : options, {}, anonymous, { discover, resolve }))
      .resolves.toBe(anonymous ? 'public' : 'authenticated');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toMatchObject({ supported_protocols: ['media_buy'] });
  });

  it.each(['ECONNRESET', 'HTTP 503 Service unavailable', 'Request timed out', 'EAI_AGAIN'])('retries %s exactly to the fixed bound', async error => {
    const discover = vi.fn().mockResolvedValue(failure(error));
    await expect(checkProbe(url, options, {}, false, { discover })).rejects.toMatchObject({ kind: 'transient' });
    expect(discover).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('recovers on a fresh attempt after a thrown transient transport failure', async () => {
    const discover = vi.fn().mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).mockResolvedValueOnce(success());
    await expect(checkProbe(url, options, {}, false, { discover, resolve: () => resolved })).resolves.toBe('authenticated');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it.each(['schema validation failed: timeout field invalid', 'schema validation failed: HTTP 401', 'HTTP 400 invalid request', 'unknown network failure', 'HTTP 403 Forbidden', 'Expected 503 tools'])(
    'never retries %s', async error => {
      const discover = vi.fn().mockResolvedValue(failure(error));
      await expect(checkProbe(url, options, {}, false, { discover })).rejects.toThrow();
      expect(discover).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let a transient error hide a semantic validation failure', async () => {
    const result = failure('HTTP 503');
    result.steps.push({ step: 'Validate capabilities', passed: false, duration_ms: 0 });
    const discover = vi.fn().mockResolvedValue(result);
    await expect(checkProbe(url, options, {}, false, { discover })).rejects.toMatchObject({ kind: 'semantic' });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('rejects profile schema issues even when discovery steps passed', async () => {
    const result = success();
    result.profile!.capabilities_schema_issues = [{ pointer: '/adcp', message: 'invalid' }];
    const discover = vi.fn().mockResolvedValue(result);
    await expect(checkProbe(url, options, {}, false, { discover })).rejects.toMatchObject({ kind: 'semantic' });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it.each(['storyboards', 'bundles', 'throw'])('does not retry local resolver failure: %s', async mode => {
    const discover = vi.fn().mockResolvedValue(success());
    const resolve = vi.fn(() => {
      if (mode === 'throw') throw new SmokeFailure('transient', 'HTTP 503');
      return { ...resolved, [mode]: [] };
    });
    await expect(checkProbe(url, {}, {}, true, { discover, resolve })).rejects.toThrow();
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe('external smoke CI isolation', () => {
  it('default integration selection cannot execute the external harness', () => {
    const pkg = JSON.parse(readFileSync(resolvePath(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:server-integration']).toBe('vitest run server/tests/integration --config server/vitest.config.ts');
    const files = JSON.parse(execFileSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'list', 'server/tests/integration',
      '--config', 'server/vitest.config.ts', '--filesOnly', '--json',
    ], { cwd: root, encoding: 'utf8', timeout: 20_000 })).map((entry: { file: string }) => entry.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file: string) => file.includes('/tests/integration/'))).toBe(true);
    expect(files.some((file: string) => file.includes('external-smoke'))).toBe(false);
    // Discovery alone cannot detect a later import of the live entry point.
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/external-smoke|ADCP_SMOKE_CHECK/);
    expect(pkg.scripts.test).not.toContain('test:external-smoke');
  });

  it('the valid scheduled/manual workflow invokes the exact dedicated command', () => {
    const document = parseDocument(readFileSync(resolvePath(root, '.github/workflows/external-smoke.yml'), 'utf8'));
    expect(document.errors).toEqual([]);
    const workflow = document.toJS();
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    const pkg = JSON.parse(readFileSync(resolvePath(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:external-smoke']).toBe('tsx scripts/external-smoke/run.ts');
    expect(workflow.jobs.smoke.steps.filter((step: { run?: string }) => step.run === 'npm run test:external-smoke')).toHaveLength(1);
    expect(workflow.jobs.smoke['timeout-minutes']).toBe(5);
  });
});
