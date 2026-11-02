import assert from 'node:assert/strict';
import {
  testCapabilityDiscovery,
  resolveStoryboardsForCapabilities,
  type TestOptions,
} from '@adcp/sdk/testing';

export const MAX_ATTEMPTS = 2;
export const ATTEMPT_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 4_000;

type Discovery = typeof testCapabilityDiscovery;
type DiscoveryResult = Awaited<ReturnType<Discovery>>;
type Resolver = typeof resolveStoryboardsForCapabilities;
type FailureKind = 'auth' | 'transient' | 'semantic';

export class SmokeFailure extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message);
    this.name = 'SmokeFailure';
  }
}

// SDK step errors are strings. Keep this allowlist narrow; unknown errors fail
// once. In particular, a generic mention of "auth" or "network" proves nothing.
// `requires OAuth authorization` is the message of the SDK's
// NeedsAuthorizationError (a 401 Bearer challenge), which reaches us only as a
// step string.
function failureKind(error: unknown): FailureKind {
  if (error instanceof SmokeFailure) return error.kind;
  const value = error as { name?: string; code?: string; status?: number; message?: string; cause?: unknown } | null;
  const evidence = typeof error === 'string' ? error :
    [value?.name, value?.code, value?.status, value?.message].join(' ');
  if (/\b(?:AssertionError|ZodError|SchemaValidationError)\b|schema|validation|unsupported version/i.test(evidence)) return 'semantic';
  if ([401, 403].includes(value?.status ?? 0) || /\b(?:unauthorized|UnauthorizedError|forbidden|AUTH_REQUIRED|AUTHENTICATION_REQUIRED|NeedsAuthorizationError)\b|\b(?:HTTP|status(?: code)?)[\s:=]+(?:401|403)\b|authentication required|invalid (?:bearer )?token|\brequires OAuth authorization\b/i.test(evidence)) return 'auth';
  if ([408, 429, 502, 503, 504].includes(value?.status ?? 0) || /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|TimeoutError|SmokeTransientTransportError)\b|\b(?:HTTP|status(?: code)?)[\s:=]+(?:408|429|502|503|504)\b|request timed out|request timeout|version negotiation probe timed out/i.test(evidence)) return 'transient';
  return value?.cause ? failureKind(value.cause) : 'semantic';
}

/** Abort the actual fetch boundary, including SDK calls that omit options.signal. */
export async function boundedDiscovery(
  url: string,
  options: TestOptions,
  {
    discover = testCapabilityDiscovery,
    fetchFn = fetch,
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  }: { discover?: Discovery; fetchFn?: typeof fetch; attemptTimeoutMs?: number; requestTimeoutMs?: number } = {},
): Promise<DiscoveryResult> {
  const controller = new AbortController();
  const timeout = new SmokeFailure('transient', `Discovery attempt timed out after ${attemptTimeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeout), attemptTimeoutMs);
  const scopedFetch: typeof fetch = async (input, init) => {
    controller.signal.throwIfAborted();
    const signals = [controller.signal, init?.signal, input instanceof Request ? input.signal : undefined]
      .filter((signal): signal is AbortSignal => signal != null);
    try {
      return await fetchFn(input, { ...init, signal: AbortSignal.any(signals) });
    } catch (error) {
      // Preserve categorized cause evidence before rc.35 reduces it to a string.
      const kind = failureKind(error);
      if (kind === 'transient') throw new SmokeFailure(kind, `SmokeTransientTransportError: ${String(error)}`);
      throw error;
    }
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // rc.35 keys connections by fetch identity, so attempts cannot reuse them.
    return await Promise.race([
      discover(url, {
        ...options,
        signal: controller.signal,
        transport: { ...options.transport, requestTimeoutMs, trustedFetchFn: scopedFetch },
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    // Also close pending response bodies / late SDK calls after success or error.
    // SDK promises can still unwind; this does not claim to cancel JavaScript.
    controller.abort(new Error('Smoke attempt finished'));
  }
}

function assertDiscovery(result: DiscoveryResult): void {
  const schemaIssues = result.profile?.capabilities_schema_issues;
  if (schemaIssues?.length) throw new SmokeFailure('semantic', `Capability schema errors: ${JSON.stringify(schemaIssues)}`);
  const failed = result.steps.filter(step => !step.passed && !step.skipped);
  const failures = failed.map(step => ({
    kind: step.task === 'getAgentInfo' || step.task === 'get_adcp_capabilities'
      ? failureKind(step.error) : 'semantic' as FailureKind,
    message: `${step.step}: ${step.error ?? step.details ?? 'failed'}`,
  }));
  if (result.profile?.capabilities_probe_error) failures.push({
    kind: failureKind(result.profile.capabilities_probe_error),
    message: result.profile.capabilities_probe_error,
  });
  if (failures.length) {
    // Mixed semantic/auth + transient failures must never turn into a retry.
    const kind = failures.some(f => f.kind === 'semantic') ? 'semantic' :
      failures.some(f => f.kind === 'auth') ? 'auth' : 'transient';
    throw new SmokeFailure(kind, failures.map(f => f.message).join('; '));
  }
  assert(result.steps.some(step => step.task === 'getAgentInfo' && step.passed && !step.skipped), 'No passed discovery step');
  assert(result.profile?.tools.length, 'Discovery returned no tools');
  const versions = result.profile.adcp_supported_versions;
  assert(versions === undefined
    ? ['v2', 'v3'].includes(result.profile.adcp_version ?? '')
    : versions.length > 0 && versions.every(version => /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/.test(version)),
  'Discovery returned no supported version');
}

type ResolverOptions = Parameters<Resolver>[1];

/** Storyboard-resolution options for the release the agent echoed. */
export type ResolverForRelease = (release: string) => ResolverOptions;

const MAJOR_RE = /^([1-9]\d*)\./;

/**
 * A 3.0 pin cannot carry `adcp_version`, so the SDK sends only
 * `adcp_major_version: 3` and the agent may serve and echo its highest 3.x
 * release (docs/reference/versioning.mdx, "Server resolves"). The SDK
 * validates the capabilities against that echo. This checks that the agent
 * may serve it, and resolves storyboards from the served release's bundle:
 * the pin's bundle does not know specialisms that later releases added.
 */
function servedResolverOptions(
  result: DiscoveryResult,
  options: TestOptions,
  resolverOptions: ResolverOptions,
  resolverFor: ResolverForRelease | undefined,
): ResolverOptions {
  const echoed = (result.profile?.raw_capabilities as { adcp_version?: unknown } | undefined)?.adcp_version;
  if (echoed === undefined) return resolverOptions;
  // The SDK falls back to the pin for an echo it cannot validate against, so
  // its schema issues are context for the failures below.
  const issues = result.profile?.capabilities_schema_issues;
  const context = issues?.length ? `; capability schema errors: ${JSON.stringify(issues)}` : '';
  const pinned = options.wireAdcpVersion ?? options.adcpVersion;
  const pinMajor = pinned?.match(MAJOR_RE)?.[1];
  if (typeof echoed !== 'string' || (pinMajor !== undefined && echoed.match(MAJOR_RE)?.[1] !== pinMajor)) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${JSON.stringify(echoed)} to a ${pinned} pin; majors must agree${context}`);
  }
  if (!result.profile?.adcp_supported_versions?.includes(echoed)) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${echoed}, which its supported_versions do not list${context}`);
  }
  if (!resolverFor) return resolverOptions;
  try {
    return resolverFor(echoed);
  } catch (error) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${echoed}, but no hosted bundle is available to resolve its storyboards: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkProbe(
  url: string,
  options: TestOptions,
  resolverOptions: ResolverOptions,
  anonymous: boolean,
  {
    discover = (endpoint, opts) => boundedDiscovery(endpoint, opts),
    resolve = resolveStoryboardsForCapabilities,
    resolverFor,
  }: { discover?: Discovery; resolve?: Resolver; resolverFor?: ResolverForRelease } = {},
): Promise<'public' | 'authenticated' | 'auth-required'> {
  for (let attempt = 1; ; attempt++) {
    let result: DiscoveryResult;
    let served: ResolverOptions;
    try {
      // One discovery per attempt; reuse its profile.
      result = await discover(url, options);
      served = servedResolverOptions(result, options, resolverOptions, resolverFor);
      assertDiscovery(result);
    } catch (error) {
      const kind = failureKind(error);
      if (anonymous && kind === 'auth') return 'auth-required';
      if (kind !== 'transient' || attempt === MAX_ATTEMPTS) throw error;
      continue;
    }
    const profile = result.profile!;
    const resolved = resolve({
      supported_protocols: profile.supported_protocols ?? [],
      specialisms: profile.specialisms ?? [],
      major_versions: profile.adcp_major_versions,
      supported_versions: profile.adcp_supported_versions,
    }, served);
    assert(resolved.storyboards.length > 0, 'No applicable storyboards');
    assert(resolved.bundles.length > 0, 'No applicable bundles');
    return anonymous ? 'public' : 'authenticated';
  }
}
