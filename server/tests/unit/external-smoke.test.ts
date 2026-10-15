import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testCapabilityDiscovery, type TestOptions } from '@adcp/sdk/testing';
import { boundedDiscovery, checkProbe, MAX_ATTEMPTS, releasePrecision, SmokeFailure, type ReleaseProbe } from '../../../scripts/external-smoke/check.js';

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

describe('external smoke served-release negotiation', () => {
  // A 3.0 pin cannot carry adcp_version, so the SDK sends only
  // adcp_major_version: 3 and validates against 3.0. The agent may serve its
  // highest 3.x release and echo it; the spec says to validate against that.
  const pinned: TestOptions = { ...options, adcpVersion: '3.0.27' };
  const pinnedResolver = { version: '3.0.27' } as Parameters<typeof checkProbe>[2];
  const servedProbe: ReleaseProbe = {
    options: { ...options, adcpVersion: '3.2.4' },
    resolverOptions: { version: '3.2.4' } as ReleaseProbe['resolverOptions'],
  };
  const served = (echo: string | undefined, issues: Array<{ pointer: string; message: string }> = []): Result => {
    const result = success();
    result.profile!.adcp_supported_versions = ['3.0', '3.1', '3.2'];
    result.profile!.raw_capabilities = echo === undefined ? {} : { adcp_version: echo };
    if (issues.length) result.profile!.capabilities_schema_issues = issues;
    return result;
  };
  const threeTwoShapes = [
    { pointer: '/media_buy/features/bidding_policy', message: 'must be boolean' },
    { pointer: '/compliance_testing/scenarios/4', message: 'must be one of: "force_creative_status"' },
  ];

  it('validates and resolves against the echoed release instead of the 3.0 pin', async () => {
    const discover = vi.fn<typeof testCapabilityDiscovery>()
      .mockResolvedValueOnce(served('3.2', threeTwoShapes))
      .mockResolvedValueOnce(served('3.2'));
    const repin = vi.fn(() => servedProbe);
    const resolve = vi.fn(() => resolved);
    await expect(checkProbe(url, pinned, pinnedResolver, false, { discover, resolve, repin }))
      .resolves.toBe('authenticated');
    expect(repin).toHaveBeenCalledExactlyOnceWith('3.2');
    expect(discover).toHaveBeenNthCalledWith(1, url, pinned);
    expect(discover).toHaveBeenNthCalledWith(2, url, servedProbe.options);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.anything(), servedProbe.resolverOptions);
  });

  it('re-validates at the served release even when the pin validation passed', async () => {
    const discover = vi.fn<typeof testCapabilityDiscovery>()
      .mockResolvedValueOnce(served('3.2'))
      .mockResolvedValueOnce(served('3.2', [{ pointer: '/adcp', message: 'invalid' }]));
    await expect(checkProbe(url, pinned, pinnedResolver, false, { discover, repin: () => servedProbe }))
      .rejects.toMatchObject({ kind: 'semantic', message: expect.stringContaining('/adcp') });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['echoes the pinned release', '3.0'],
    ['omits the echo', undefined],
  ])('keeps pin validation when the agent %s', async (_label, echo) => {
    const discover = vi.fn<typeof testCapabilityDiscovery>().mockResolvedValue(served(echo, threeTwoShapes));
    const repin = vi.fn(() => servedProbe);
    await expect(checkProbe(url, pinned, pinnedResolver, false, { discover, repin }))
      .rejects.toMatchObject({ kind: 'semantic', message: expect.stringContaining('bidding_policy') });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(repin).not.toHaveBeenCalled();
  });

  it.each([
    ['a release its supported_versions omit', '3.3', /supported_versions do not list/],
    ['a different major', '4.0', /majors must agree/],
  ])('rejects an agent that serves %s', async (_label, echo, message) => {
    const discover = vi.fn<typeof testCapabilityDiscovery>().mockResolvedValue(served(echo, threeTwoShapes));
    const repin = vi.fn(() => servedProbe);
    const rejection = checkProbe(url, pinned, pinnedResolver, false, { discover, repin });
    await expect(rejection).rejects.toMatchObject({ kind: 'semantic', message: expect.stringMatching(message) });
    await expect(rejection).rejects.toThrow(/bidding_policy/);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(repin).not.toHaveBeenCalled();
  });

  it('fails when no hosted bundle exists for the served release', async () => {
    const discover = vi.fn<typeof testCapabilityDiscovery>().mockResolvedValue(served('3.2', threeTwoShapes));
    const repin = () => { throw new Error('No npm-published compliance version is registered for 3.2'); };
    await expect(checkProbe(url, pinned, pinnedResolver, false, { discover, repin }))
      .rejects.toMatchObject({ kind: 'semantic', message: expect.stringMatching(/no hosted bundle.*3\.2.*bidding_policy/) });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('fails when the agent serves another release once pinned to the echoed one', async () => {
    const discover = vi.fn<typeof testCapabilityDiscovery>()
      .mockResolvedValueOnce(served('3.2', threeTwoShapes))
      .mockResolvedValueOnce(served('3.1'));
    await expect(checkProbe(url, pinned, pinnedResolver, false, { discover, repin: () => servedProbe }))
      .rejects.toMatchObject({ kind: 'semantic', message: expect.stringContaining('but 3.1 when pinned to 3.2') });
  });

  it('normalizes pins and echoes to release precision', () => {
    expect(releasePrecision('3.0.27')).toBe('3.0');
    expect(releasePrecision('3.2')).toBe('3.2');
    expect(releasePrecision('3.2.0-rc.7')).toBe('3.2-rc.7');
    expect(releasePrecision('3.2-rc.7')).toBe('3.2-rc.7');
    expect(releasePrecision('v3')).toBeUndefined();
    expect(releasePrecision(3)).toBeUndefined();
  });
});

describe('external smoke SDK cross-check and auth evidence', () => {
  const complianceFalsePositive = 'Tools suggest unreported protocols: compliance (has: [comply_test_controller])';
  const withCrossCheck = (error: string, protocols: string[], declaresBlock = true): Result => {
    const result = success();
    result.profile!.supported_protocols = protocols;
    result.profile!.raw_capabilities = declaresBlock ? { compliance_testing: { scenarios: ['force_creative_status'] } } : {};
    result.steps.push({ step: 'Cross-validate protocols and tools', passed: false, duration_ms: 0, error });
    return result;
  };

  it('waives the SDK compliance cross-check false positive when compliance_testing was declared', async () => {
    const discover = vi.fn().mockResolvedValue(withCrossCheck(complianceFalsePositive, ['media_buy', 'compliance_testing']));
    await expect(checkProbe(url, options, {}, false, { discover, resolve: () => resolved })).resolves.toBe('authenticated');
  });

  it.each([
    ['compliance_testing was not declared', complianceFalsePositive, ['media_buy'], false],
    ['the SDK synthesized compliance_testing without a declared block', complianceFalsePositive, ['media_buy', 'compliance_testing'], false],
    ['the step reports another issue', `Protocol 'signals' reported but no matching tools found; ${complianceFalsePositive}`, ['media_buy', 'compliance_testing']],
    ['another protocol is unreported', 'Tools suggest unreported protocols: signals (has: [get_signals])', ['media_buy', 'compliance_testing']],
  ])('still fails the cross-check when %s', async (_label, error, protocols, declaresBlock = true) => {
    const discover = vi.fn().mockResolvedValue(withCrossCheck(error, protocols, declaresBlock));
    await expect(checkProbe(url, options, {}, false, { discover, resolve: () => resolved }))
      .rejects.toMatchObject({ kind: 'semantic' });
  });

  it('treats an SDK OAuth challenge as anonymous auth-required evidence', async () => {
    const discover = vi.fn().mockResolvedValue(failure(
      'Agent https://smoke.example.com/mcp requires OAuth authorization. Authorization server: https://auth.example.com. Provide an OAuthFlowHandler or run an interactive flow to complete authorization.',
    ));
    await expect(checkProbe(url, {}, {}, true, { discover })).resolves.toBe('auth-required');
    await expect(checkProbe(url, options, {}, false, { discover })).rejects.toMatchObject({ kind: 'auth' });
    expect(discover).toHaveBeenCalledTimes(2);
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
