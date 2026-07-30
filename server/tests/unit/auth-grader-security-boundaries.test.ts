import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateFetchUrl: vi.fn(),
  safeFetch: vi.fn(),
  runAuthDiagnosis: vi.fn(),
  processRunner: vi.fn(),
}));

vi.mock('../../src/utils/url-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/url-security.js')>();
  return {
    ...actual,
    validateFetchUrl: (...args: unknown[]) => mocks.validateFetchUrl(...args),
    safeFetch: (...args: unknown[]) => mocks.safeFetch(...args),
  };
});

vi.mock('@adcp/sdk/auth', () => ({
  runAuthDiagnosis: (...args: unknown[]) => mocks.runAuthDiagnosis(...args),
}));

import {
  __setAuthGraderProcessRunnerForTests,
  createAuthGraderToolHandlers,
} from '../../src/addie/mcp/auth-grader-tools.js';
import {
  __createInMemoryStore,
  __resetRateLimitHistory,
  __setRateLimitStore,
} from '../../src/addie/mcp/tool-rate-limiter.js';

const PUBLIC_AGENT_URL = 'https://agent.example.test/mcp';

function gradeReport() {
  return {
    agent_url: PUBLIC_AGENT_URL,
    harness_mode: 'black_box',
    live_endpoint_warning: false,
    contract_loaded: true,
    positive: [],
    negative: [],
    passed: true,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 0,
    total_duration_ms: 10,
  };
}

function gradeResult() {
  return { stdout: JSON.stringify(gradeReport()) };
}

function capabilityResponse(mode: 'either' | 'required' | 'forbidden' = 'required'): Response {
  return new Response(JSON.stringify({
    result: {
      content: [{
        text: JSON.stringify({ request_signing: { covers_content_digest: mode } }),
      }],
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCallCount(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && mock.mock.calls.length < count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(mock).toHaveBeenCalledTimes(count);
}

describe('hosted auth grader security boundaries', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    __setRateLimitStore(__createInMemoryStore());
    await __resetRateLimitHistory();
    mocks.validateFetchUrl.mockResolvedValue(undefined);
    mocks.safeFetch.mockResolvedValue(capabilityResponse());
    mocks.runAuthDiagnosis.mockResolvedValue({ agentUrl: PUBLIC_AGENT_URL, hypotheses: [] });
    mocks.processRunner.mockResolvedValue(gradeResult());
    __setAuthGraderProcessRunnerForTests(mocks.processRunner);
  });

  afterEach(() => {
    __setAuthGraderProcessRunnerForTests(null);
    vi.restoreAllMocks();
  });

  it.each([
    ['grade_agent_signing', { allow_http: true }],
    ['grade_agent_signing', { allow_live_side_effects: true }],
    ['diagnose_agent_auth', { allow_http: true }],
  ])('rejects legacy true options before any URL, network, SDK, or process work for %s', async (toolName, extra) => {
    const handler = createAuthGraderToolHandlers('caller-legacy').get(toolName)!;

    const result = await handler({ agent_url: PUBLIC_AGENT_URL, ...extra });

    expect(result).toMatch(/Hosted Addie cannot/);
    expect(mocks.validateFetchUrl).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.runAuthDiagnosis).not.toHaveBeenCalled();
    expect(mocks.processRunner).not.toHaveBeenCalled();
  });

  it('treats legacy false values as benign while forcing safe CLI and SDK options', async () => {
    const handlers = createAuthGraderToolHandlers('caller-safe-options');

    await handlers.get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      allow_http: false,
      allow_live_side_effects: false,
      content_digest_mode: 'required',
    });
    await handlers.get('diagnose_agent_auth')!({
      agent_url: PUBLIC_AGENT_URL,
      allow_http: false,
    });

    expect(mocks.processRunner).toHaveBeenCalledOnce();
    const [args, options] = mocks.processRunner.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      'grade',
      'request-signing',
      PUBLIC_AGENT_URL,
      '--skip-rate-abuse',
    ]));
    expect(args).not.toContain('--allow-http');
    expect(args).not.toContain('--allow-live-side-effects');
    const skips = String(args[args.indexOf('--skip') + 1]).split(',');
    expect(skips).toEqual(expect.arrayContaining([
      '016-replayed-nonce',
      '020-rate-abuse',
      '018-digest-covered-when-forbidden',
    ]));
    expect(options).toEqual({ timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
    expect(mocks.runAuthDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({ agent_uri: PUBLIC_AGENT_URL }),
      { allowPrivateIp: false, skipRefresh: true, skipToolCall: true },
    );
  });

  it.each([
    'http://public.example.test/mcp',
    'https://user:secret@public.example.test/mcp',
    'https://localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://10.0.0.8/mcp',
    'https://172.16.0.8/mcp',
    'https://192.168.1.8/mcp',
    'https://100.64.0.8/mcp',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/mcp',
    'https://[0:0:0:0:0:0:0:1]/mcp',
    'https://[fe80::1]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fd12::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://2130706433/mcp',
    'https://0177.0.0.1/mcp',
    'https://0x7f000001/mcp',
    'https://agent.local/mcp',
    'https://service.internal/mcp',
    'https://metadata.google.internal/mcp',
  ])('rejects a non-public target before DNS or either outbound sink: %s', async (agentUrl) => {
    const handlers = createAuthGraderToolHandlers('system:addie');

    const [grade, diagnosis] = await Promise.all([
      handlers.get('grade_agent_signing')!({ agent_url: agentUrl }),
      handlers.get('diagnose_agent_auth')!({ agent_url: agentUrl }),
    ]);

    expect(grade).toMatch(/public HTTPS|public network|credentials/);
    expect(diagnosis).toMatch(/public HTTPS|public network|credentials/);
    expect(mocks.validateFetchUrl).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.runAuthDiagnosis).not.toHaveBeenCalled();
    expect(mocks.processRunner).not.toHaveBeenCalled();
  });

  it('rejects a hostname resolving to a private address before capability, SDK, or process sinks', async () => {
    mocks.validateFetchUrl.mockRejectedValueOnce(new Error('private address'));
    const handlers = createAuthGraderToolHandlers('caller-rebind');

    const result = await handlers.get('grade_agent_signing')!({
      agent_url: 'https://rebind.example.test/mcp',
    });

    expect(result).toContain('resolve only to public network addresses');
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.runAuthDiagnosis).not.toHaveBeenCalled();
    expect(mocks.processRunner).not.toHaveBeenCalled();
  });

  it('uses pinned safeFetch with a 10-second signal and no redirects for the capability probe', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    mocks.safeFetch.mockResolvedValueOnce(capabilityResponse('required'));
    const handler = createAuthGraderToolHandlers('caller-capability').get('grade_agent_signing')!;

    await handler({ agent_url: PUBLIC_AGENT_URL });

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(mocks.safeFetch).toHaveBeenCalledWith(PUBLIC_AGENT_URL, expect.objectContaining({
      method: 'POST',
      maxRedirects: 0,
      signal: timeoutSignal,
    }));
    const request = mocks.safeFetch.mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    const args = mocks.processRunner.mock.calls[0][0] as string[];
    const skips = args[args.indexOf('--skip') + 1].split(',');
    expect(skips).toEqual(expect.arrayContaining([
      '016-replayed-nonce',
      '020-rate-abuse',
      '018-digest-covered-when-forbidden',
    ]));
  });

  it('streams and cancels a capability response after the 64 KiB cap', async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.safeFetch.mockResolvedValueOnce(new Response(oversizedBody as unknown as BodyInit, { status: 200 }));
    const handler = createAuthGraderToolHandlers('caller-cap').get('grade_agent_signing')!;

    await handler({ agent_url: PUBLIC_AGENT_URL });

    expect(cancelled).toBe(true);
    expect(mocks.processRunner).toHaveBeenCalledOnce();
    const args = mocks.processRunner.mock.calls[0][0] as string[];
    expect(args[args.indexOf('--skip') + 1].split(',').sort()).toEqual([
      '016-replayed-nonce',
      '020-rate-abuse',
    ]);
  });

  it('sheds a third concurrent child immediately and releases permits after completion', async () => {
    const first = deferred<{ stdout: string }>();
    const second = deferred<{ stdout: string }>();
    mocks.processRunner
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const firstRun = createAuthGraderToolHandlers('caller-one').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    const secondRun = createAuthGraderToolHandlers('caller-two').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    await waitForCallCount(mocks.processRunner, 2);

    const overloaded = await createAuthGraderToolHandlers('caller-three').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    expect(overloaded).toMatch(/capacity is busy/);
    expect(mocks.processRunner).toHaveBeenCalledTimes(2);

    first.resolve(gradeResult());
    second.resolve(gradeResult());
    await Promise.all([firstRun, secondRun]);

    mocks.processRunner.mockResolvedValueOnce(gradeResult());
    const afterRelease = await createAuthGraderToolHandlers('caller-four').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    expect(afterRelease).toContain('Result:** PASS');
    expect(mocks.processRunner).toHaveBeenCalledTimes(3);
  });

  it('releases a child-process permit when the runner rejects', async () => {
    mocks.processRunner.mockRejectedValueOnce(new Error('child failed'));
    const failed = await createAuthGraderToolHandlers('caller-failed').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    expect(failed).toContain('Error running RFC 9421 grader');

    mocks.processRunner.mockResolvedValueOnce(gradeResult());
    const retried = await createAuthGraderToolHandlers('caller-after-failure').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    expect(retried).toContain('Result:** PASS');
  });

  it('releases a child-process permit before handling malformed grader JSON', async () => {
    mocks.processRunner.mockResolvedValueOnce({ stdout: '{not-json' });
    const malformed = await createAuthGraderToolHandlers('caller-malformed').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    expect(malformed).toContain('Error running RFC 9421 grader');

    mocks.processRunner.mockResolvedValueOnce(gradeResult());
    const retried = await createAuthGraderToolHandlers('caller-after-malformed').get('grade_agent_signing')!({
      agent_url: PUBLIC_AGENT_URL,
      content_digest_mode: 'required',
    });
    expect(retried).toContain('Result:** PASS');
  });

  it('enforces the signing-grader per-user cap before spawning a fourth child', async () => {
    const handler = createAuthGraderToolHandlers('caller-rate-limited').get('grade_agent_signing')!;
    for (let i = 0; i < 3; i++) {
      expect(await handler({ agent_url: PUBLIC_AGENT_URL, content_digest_mode: 'required' }))
        .toContain('Result:** PASS');
    }

    const blocked = await handler({ agent_url: PUBLIC_AGENT_URL, content_digest_mode: 'required' });

    expect(blocked).toMatch(/Rate limit exceeded.*grade_agent_signing/i);
    expect(mocks.processRunner).toHaveBeenCalledTimes(3);
  });

  it('wires authenticated web and Slack identities into handler creation', () => {
    const webSource = readFileSync(join(process.cwd(), 'server/src/routes/addie-chat.ts'), 'utf8');
    const slackSource = readFileSync(join(process.cwd(), 'server/src/addie/bolt-app.ts'), 'utf8');

    expect(webSource).toContain('createAuthGraderToolHandlers(userId)');
    expect(slackSource).toContain(
      'memberContext?.workos_user?.workos_user_id ?? `slack:${slackUserId}`',
    );
    expect(slackSource).toContain('createAuthGraderToolHandlers(authGraderCallerId)');
  });
});
