import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
  safeFetch: vi.fn(),
  fallbackTarget: {
    requested: '3.0',
    version: '3.0.18',
    complianceDir: '/compliance/3.0.18',
    schemaRoot: '/schemas/3.0.18',
  },
  selectedTarget: {
    requested: '3.1',
    version: '3.1.13',
    complianceDir: '/compliance/3.1.13',
    schemaRoot: '/schemas/3.1.13',
  },
}));

vi.mock('@adcp/sdk/testing', () => ({
  SAMPLE_BRIEFS: [],
  getBriefsByVertical: vi.fn(),
  setAgentTesterLogger: vi.fn(),
  comply: vi.fn(),
  loadComplianceIndex: vi.fn(),
  testCapabilityDiscovery: mocks.discovery,
  CapabilityResolutionError: class CapabilityResolutionError extends Error {},
}));

vi.mock('../../src/services/hosted-compliance-version.js', () => ({
  hostedComplianceTarget: () => mocks.fallbackTarget,
  hostedAuthProbeTaskForProfile: vi.fn(),
  hostedStaticApiKeyForProfile: vi.fn(),
  agentAdvertisesBadgeEligibleHostedComplianceTarget: vi.fn().mockReturnValue(false),
  badgeEligibleVersionsForHostedComplianceTarget: vi.fn().mockReturnValue([]),
  selectCanonicalHostedComplianceTargetForProfile: (profile: { adcp_supported_versions?: string[] }) =>
    profile?.adcp_supported_versions?.includes('3.1')
      ? mocks.selectedTarget
      : mocks.fallbackTarget,
  selectHostedComplianceTargetForProfile: (profile: { adcp_supported_versions?: string[] }) =>
    profile?.adcp_supported_versions?.includes('3.1')
      ? mocks.selectedTarget
      : mocks.fallbackTarget,
  agentAdvertisesHostedComplianceTarget: (versions: string[] | undefined, target: { requested: string }) =>
    Boolean(versions?.includes(target.requested)),
  withHostedComplianceRunOptions: (options: unknown) => options,
}));

vi.mock('../../src/utils/sdk-safe-fetch.js', () => ({
  withSdkSafeTransport: (options: Record<string, unknown>) => ({
    ...options,
    transport: {
      ...(options.transport as Record<string, unknown> | undefined),
      fetchFn: mocks.safeFetch,
    },
  }),
}));

vi.mock('../../src/services/storyboards.js', () => ({
  getStoryboard: vi.fn(),
}));

import {
  HOSTED_TARGET_DISCOVERY_TIMEOUT_MS,
  selectComplianceTargetForAgentSelection,
} from '../../src/addie/services/compliance-testing.js';

describe('hosted compliance target discovery deadline', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('allows a slow 3.1 discovery and isolates it from the full-run timeout', async () => {
    vi.useFakeTimers();
    let receivedOptions: Record<string, unknown> | undefined;
    mocks.discovery.mockImplementation((_url, options) => {
      receivedOptions = options;
      return new Promise(resolve => setTimeout(() => resolve({
        profile: { adcp_supported_versions: ['3.1'] },
        steps: [],
      }), 15_000));
    });

    const selectionPromise = selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {
        timeout_ms: 600_000,
        test_session_id: 'heartbeat-test',
        userAgent: 'heartbeat-agent',
        auth: { type: 'bearer', token: 'secret' },
      },
      mocks.fallbackTarget,
      'canonical',
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(selectionPromise).resolves.toEqual({
      target: mocks.selectedTarget,
      confirmed: true,
      source: 'live',
      supportedVersions: ['3.1'],
    });
    expect(receivedOptions).toMatchObject({
      test_session_id: 'heartbeat-test',
      userAgent: 'heartbeat-agent',
      auth: { type: 'bearer', token: 'secret' },
      signal: expect.any(AbortSignal),
      transport: { fetchFn: expect.any(Function) },
    });
    expect(Object.hasOwn(receivedOptions ?? {}, 'timeout_ms')).toBe(false);
  });

  it('hard-stops at 30 seconds and aborts the hosted fetch boundary', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    mocks.safeFetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      transportSignal = init?.signal;
      transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true });
    }));
    mocks.discovery.mockImplementation((_url, options) =>
      options.transport.fetchFn('https://agent.example/mcp'));

    let settled = false;
    const selectionPromise = selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      { timeout_ms: 600_000 },
      mocks.fallbackTarget,
      'canonical',
    ).then(selection => {
      settled = true;
      return selection;
    });

    await vi.advanceTimersByTimeAsync(HOSTED_TARGET_DISCOVERY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(transportSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(selectionPromise).resolves.toEqual({
      target: mocks.fallbackTarget,
      confirmed: false,
      source: 'default',
    });
    expect(transportSignal?.aborted).toBe(true);
  });

  it('hard-stops even when discovery ignores its signal and never settles', async () => {
    vi.useFakeTimers();
    mocks.discovery.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const selectionPromise = selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
    ).then(selection => {
      settled = true;
      return selection;
    });

    await vi.advanceTimersByTimeAsync(HOSTED_TARGET_DISCOVERY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(selectionPromise).resolves.toEqual({
      target: mocks.fallbackTarget,
      confirmed: false,
      source: 'default',
    });
  });

  it('uses recent stored supported versions when live discovery fails', async () => {
    mocks.discovery.mockRejectedValue(new Error('temporary probe failure'));

    await expect(selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
      ['3.1', '3.1', ''],
    )).resolves.toEqual({
      target: mocks.selectedTarget,
      confirmed: false,
      source: 'stored',
    });
  });

  it('rejects recent stored versions that do not match a hosted target', async () => {
    mocks.discovery.mockRejectedValue(new Error('temporary probe failure'));

    await expect(selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
      ['4.0'],
    )).resolves.toEqual({
      target: mocks.fallbackTarget,
      confirmed: false,
      source: 'default',
    });
  });

  it('prefers successful live discovery over recent stored versions', async () => {
    mocks.discovery.mockResolvedValue({
      profile: { adcp_supported_versions: ['3.0'] },
      steps: [],
    });

    await expect(selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
      ['3.1'],
    )).resolves.toEqual({
      target: mocks.fallbackTarget,
      confirmed: true,
      source: 'live',
      supportedVersions: ['3.0'],
    });
  });

  it('does not trust successful live discovery when no hosted target matches', async () => {
    mocks.discovery.mockResolvedValue({
      profile: { adcp_supported_versions: ['4.0'] },
      steps: [],
    });

    await expect(selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
    )).resolves.toEqual({
      target: mocks.fallbackTarget,
      confirmed: false,
      source: 'default',
      supportedVersions: ['4.0'],
    });
  });

  it('rejects caller cancellation after propagating it through discovery fetches', async () => {
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    mocks.safeFetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      transportSignal = init?.signal;
      transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true });
    }));
    mocks.discovery.mockImplementation((_url, options) =>
      options.transport.fetchFn('https://agent.example/mcp'));

    const selectionPromise = selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      { signal: caller.signal },
      mocks.fallbackTarget,
      'canonical',
    );
    caller.abort(new Error('heartbeat stopped'));

    await expect(selectionPromise).rejects.toThrow('heartbeat stopped');
    expect(transportSignal?.aborted).toBe(true);
  });

  it('preserves request metadata while composing the discovery deadline signal', async () => {
    const requestController = new AbortController();
    let forwardedRequest: Request | undefined;
    let forwardedSignal: AbortSignal | undefined;
    mocks.safeFetch.mockImplementation((input, init) => {
      forwardedRequest = input as Request;
      forwardedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        forwardedSignal?.addEventListener('abort', () => reject(forwardedSignal?.reason), { once: true });
      });
    });
    mocks.discovery.mockImplementation(async (_url, options) => {
      await options.transport.fetchFn(new Request('https://agent.example/mcp?probe=1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
          'x-probe': 'capabilities',
        },
        body: JSON.stringify({ method: 'get_adcp_capabilities' }),
        signal: requestController.signal,
      }));
      return {
        profile: { adcp_supported_versions: ['3.1'] },
        steps: [],
      };
    });

    const selectionPromise = selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
    );
    await vi.waitFor(() => expect(forwardedRequest).toBeInstanceOf(Request));

    expect(forwardedRequest?.url).toBe('https://agent.example/mcp?probe=1');
    expect(forwardedRequest?.method).toBe('POST');
    expect(forwardedRequest?.headers.get('authorization')).toBe('Bearer secret');
    expect(forwardedRequest?.headers.get('x-probe')).toBe('capabilities');
    await expect(forwardedRequest?.clone().json()).resolves.toEqual({
      method: 'get_adcp_capabilities',
    });
    expect(forwardedRequest?.signal).not.toBe(requestController.signal);
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(forwardedSignal).not.toBe(forwardedRequest?.signal);
    expect(forwardedSignal?.aborted).toBe(false);

    const requestAbort = new Error('request stopped');
    requestController.abort(requestAbort);
    await expect(selectionPromise).resolves.toEqual({
      target: mocks.fallbackTarget,
      confirmed: false,
      source: 'default',
    });
    expect(forwardedSignal?.aborted).toBe(true);
    expect(forwardedSignal?.reason).toBe(requestAbort);
  });

  it('clears the deadline after a fast successful discovery', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    mocks.discovery.mockImplementation((_url, options) => {
      receivedSignal = options.signal;
      return Promise.resolve({
        profile: { adcp_supported_versions: ['3.1'] },
        steps: [],
      });
    });

    const selection = await selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
    );
    expect(selection.target).toBe(mocks.selectedTarget);

    await vi.advanceTimersByTimeAsync(HOSTED_TARGET_DISCOVERY_TIMEOUT_MS);
    expect(receivedSignal?.aborted).toBe(false);
  });
});
