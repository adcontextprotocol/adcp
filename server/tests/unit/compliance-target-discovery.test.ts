import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
  sdkComply: vi.fn(),
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
  comply: mocks.sdkComply,
  loadComplianceIndex: vi.fn(),
  testCapabilityDiscovery: mocks.discovery,
  CapabilityResolutionError: class CapabilityResolutionError extends Error {
    constructor(params: { code: string; message: string; specialism?: string; parentProtocol?: string }) {
      super(params.message);
      Object.assign(this, params);
    }
  },
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
  withHostedComplianceRunOptions: (options: Record<string, unknown>, target: { version: string }) => ({
    ...options,
    version: target.version,
  }),
  withHostedTestOptions: (options: Record<string, unknown>, target: { version: string }) => ({
    ...options,
    adcpVersion: options.adcpVersion ?? target.version,
  }),
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

import { CapabilityResolutionError } from '@adcp/sdk/testing';
import {
  HOSTED_TARGET_DISCOVERY_TIMEOUT_MS,
  classifyCapabilityResolutionErrorWithDeclaredProtocols,
  comply,
  hostedCapabilityDiscoveryOptions,
  selectComplianceTargetForAgentSelection,
} from '../../src/addie/services/compliance-testing.js';

describe('hosted capability probe versions', () => {
  it('pins explicit recommendation targets and preserves auth and safe transport', () => {
    const options = hostedCapabilityDiscoveryOptions(
      { auth: { type: 'bearer', token: 'secret' } },
      { requested: '3.1.20', version: '3.1.20', complianceDir: '/compliance/3.1.20', schemaRoot: '/schemas/3.1.20' },
    );
    expect(options).toMatchObject({
      adcpVersion: '3.1.20',
      versionEnvelope: 'auto',
      auth: { type: 'bearer', token: 'secret' },
      transport: { fetchFn: mocks.safeFetch },
    });
  });

  it('uses major-only recovery before a target is selected', () => {
    const options = hostedCapabilityDiscoveryOptions({ adcpVersion: '3.2.0-rc.7' });
    expect(options.versionEnvelope).toBe('major-only');
    expect(options.adcpVersion).toBeUndefined();
    expect(options.transport?.fetchFn).toBe(mocks.safeFetch);
  });
});

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
      versionEnvelope: 'major-only',
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
    expect(mocks.discovery).toHaveBeenCalledWith(
      'https://agent.example/mcp',
      expect.objectContaining({ adcpVersion: mocks.selectedTarget.version }),
    );
  });

  it('uses a pinned last-known target when discovery returns a partial profile', async () => {
    mocks.discovery.mockResolvedValue({ profile: { name: 'Older agent' }, steps: [] });

    await expect(selectComplianceTargetForAgentSelection(
      'https://agent.example/mcp',
      {},
      mocks.fallbackTarget,
      'canonical',
      ['3.1'],
    )).resolves.toEqual({
      target: mocks.selectedTarget,
      confirmed: false,
      source: 'stored',
    });
    expect(mocks.discovery).toHaveBeenCalledWith(
      'https://agent.example/mcp',
      expect.objectContaining({ adcpVersion: mocks.selectedTarget.version }),
    );
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

const exactStableTarget = {
  requested: '3.1.20',
  version: '3.1.20',
  complianceDir: '/compliance/3.1.20',
  schemaRoot: '/schemas/3.1.20',
};

describe('hosted compliance run pre-discovery', () => {
  beforeEach(() => {
    mocks.discovery.mockReset();
    mocks.sdkComply.mockReset();
    mocks.discovery.mockResolvedValue({
      profile: { adcp_supported_versions: ['3.1'] },
      steps: [],
    });
    mocks.sdkComply.mockResolvedValue({ agent_profile: {} });
  });

  it.each([
    ['no operator auth', {}],
    ['bearer auth', { auth: { type: 'bearer' as const, token: 'secret' } }],
    ['static fixture probe task without operator auth', { test_kit: { auth: { probe_task: 'list_creative_formats' } } }],
  ])('probes the agent at the requested exact target version with %s', async (_label, options) => {
    await comply('https://agent.example/mcp', { test_session_id: 'explicit-target', ...options }, exactStableTarget);

    expect(mocks.discovery).toHaveBeenCalledTimes(1);
    expect(mocks.discovery.mock.calls[0][1]).toMatchObject({ adcpVersion: '3.1.20' });
  });

  it('skips pre-discovery when operator auth already names a probe task', async () => {
    await comply('https://agent.example/mcp', {
      test_session_id: 'explicit-target',
      auth: { type: 'bearer', token: 'secret' },
      test_kit: { auth: { probe_task: 'list_creative_formats' } },
    }, exactStableTarget);

    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(mocks.sdkComply).toHaveBeenCalledTimes(1);
  });
});

describe('capability resolution error reprobe', () => {
  const parentProtocolMissing = () => new CapabilityResolutionError({
    code: 'specialism_parent_protocol_missing',
    message: 'Agent declared specialism "sales-guaranteed" (parent protocol: media_buy) but did not include it in supported_protocols',
    specialism: 'sales-guaranteed',
    parentProtocol: 'media_buy',
  });

  beforeEach(() => {
    mocks.discovery.mockReset();
    mocks.safeFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reprobes the agent at the failed run target version with the caller auth and safe transport', async () => {
    mocks.discovery.mockResolvedValue({
      profile: { adcp_supported_versions: ['3.1'], supported_protocols: ['media-buy'] },
      steps: [],
    });

    await classifyCapabilityResolutionErrorWithDeclaredProtocols(
      parentProtocolMissing(),
      'https://agent.example/mcp',
      { type: 'bearer', token: 'secret' },
      exactStableTarget,
    );

    expect(mocks.discovery).toHaveBeenCalledTimes(1);
    expect(mocks.discovery.mock.calls[0][1]).toMatchObject({
      adcpVersion: '3.1.20',
      auth: { type: 'bearer', token: 'secret' },
      transport: { fetchFn: expect.any(Function) },
    });
  });

  it('refines the classification from the reprobed supported protocols', async () => {
    mocks.discovery.mockResolvedValue({
      profile: { adcp_supported_versions: ['3.1'], supported_protocols: ['media-buy'] },
      steps: [],
    });

    await expect(classifyCapabilityResolutionErrorWithDeclaredProtocols(
      parentProtocolMissing(),
      'https://agent.example/mcp',
      undefined,
      exactStableTarget,
    )).resolves.toMatchObject({
      kind: 'unrecognized_supported_protocol',
      declaredProtocol: 'media-buy',
      expectedProtocol: 'media_buy',
    });
  });

  it('does not reprobe for other capability resolution errors', async () => {
    const unknownSpecialism = new CapabilityResolutionError({
      code: 'unknown_specialism',
      message: 'Agent declared specialism "made-up" but no bundle exists for it',
      specialism: 'made-up',
    });

    await expect(classifyCapabilityResolutionErrorWithDeclaredProtocols(
      unknownSpecialism,
      'https://agent.example/mcp',
      undefined,
      exactStableTarget,
    )).resolves.toMatchObject({ kind: 'unknown_specialism' });
    expect(mocks.discovery).not.toHaveBeenCalled();
  });

  it('keeps the initial classification when the reprobe fails', async () => {
    mocks.discovery.mockRejectedValue(new Error('agent unreachable'));

    await expect(classifyCapabilityResolutionErrorWithDeclaredProtocols(
      parentProtocolMissing(),
      'https://agent.example/mcp',
      undefined,
      exactStableTarget,
    )).resolves.toMatchObject({ kind: 'specialism_parent_protocol_missing', parentProtocol: 'media_buy' });
  });

  it('stops waiting for a reprobe that never settles at the discovery deadline', async () => {
    vi.useFakeTimers();
    mocks.discovery.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const classification = classifyCapabilityResolutionErrorWithDeclaredProtocols(
      parentProtocolMissing(),
      'https://agent.example/mcp',
      undefined,
      exactStableTarget,
    ).then(result => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(HOSTED_TARGET_DISCOVERY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(classification).resolves.toMatchObject({ kind: 'specialism_parent_protocol_missing' });
  });
});
