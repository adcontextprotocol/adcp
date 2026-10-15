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

// @adcp/sdk 15.8.1 (and 15.9.1) parses a `compliance_testing` capability
// block as protocol `compliance_testing`, but its tool cross-check keys
// comply_test_controller under `compliance`. Every agent that correctly
// declares the block therefore fails the step with exactly this message.
// Waive only that exact message, and only when the agent's response carries
// the block (the SDK also adds the protocol when the block is missing). Any
// other cross-check issue still fails.
const SDK_COMPLIANCE_CROSS_CHECK_STEP = 'Cross-validate protocols and tools';
const SDK_COMPLIANCE_CROSS_CHECK_ERROR = 'Tools suggest unreported protocols: compliance (has: [comply_test_controller])';

function isSdkComplianceCrossCheckFalsePositive(step: DiscoveryResult['steps'][number], result: DiscoveryResult): boolean {
  return step.step === SDK_COMPLIANCE_CROSS_CHECK_STEP
    && step.error === SDK_COMPLIANCE_CROSS_CHECK_ERROR
    && result.profile?.supported_protocols?.includes('compliance_testing') === true
    && typeof (result.profile.raw_capabilities as { compliance_testing?: unknown } | undefined)?.compliance_testing === 'object';
}

function assertDiscovery(result: DiscoveryResult): void {
  const schemaIssues = result.profile?.capabilities_schema_issues;
  if (schemaIssues?.length) throw new SmokeFailure('semantic', `Capability schema errors: ${JSON.stringify(schemaIssues)}`);
  const failed = result.steps.filter(step => !step.passed && !step.skipped
    && !isSdkComplianceCrossCheckFalsePositive(step, result));
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

/** Probe and storyboard-resolution options pinned to one release. */
export interface ReleaseProbe {
  options: TestOptions;
  resolverOptions: ResolverOptions;
}

/** Builds a probe pinned to the release the agent said it served. */
export type RepinProbe = (release: string) => ReleaseProbe;

const RELEASE_RE = /^([1-9]\d*)\.(\d+)(?:\.\d+)?(?:-([0-9A-Za-z.-]+))?$/;

/** Release-precision wire value (`3.0`, `3.2-rc.7`) for a pin or an echo. */
export function releasePrecision(version: unknown): string | undefined {
  const match = typeof version === 'string' ? version.match(RELEASE_RE) : null;
  return match ? `${match[1]}.${match[2]}${match[3] ? `-${match[3]}` : ''}` : undefined;
}

/** The release the agent echoed on `get_adcp_capabilities`, if any. */
function servedRelease(result: DiscoveryResult): string | undefined {
  const raw = result.profile?.raw_capabilities as { adcp_version?: unknown } | undefined;
  return releasePrecision(raw?.adcp_version);
}

/**
 * The SDK validates capabilities against the caller's pin, not the served
 * release. A 3.0 pin cannot carry `adcp_version`, so the SDK sends only
 * `adcp_major_version: 3` and the agent may serve its highest 3.x release
 * (docs/reference/versioning.mdx, "Server resolves"). The spec says buyers
 * validate against the echoed release, not their pin ("Server echoes").
 *
 * When the echo differs from the pin, the agent must advertise the echoed
 * release. The probe then discovers again pinned to it, so the SDK validates
 * strictly against that release, and resolves storyboards from that
 * release's bundle. The pinned probe must keep serving the same release.
 */
async function negotiateServedRelease(
  url: string,
  probe: ReleaseProbe,
  result: DiscoveryResult,
  discover: Discovery,
  repin: RepinProbe | undefined,
): Promise<{ probe: ReleaseProbe; result: DiscoveryResult }> {
  const served = servedRelease(result);
  const pinned = releasePrecision(probe.options.wireAdcpVersion ?? probe.options.adcpVersion);
  if (!served || !pinned || served === pinned || !repin) return { probe, result };
  const issues = result.profile?.capabilities_schema_issues;
  const context = issues?.length ? `; issues against the ${pinned} pin: ${JSON.stringify(issues)}` : '';
  if (served.split('.')[0] !== pinned.split('.')[0]) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${served} to a ${pinned} pin; majors must agree${context}`);
  }
  if (!result.profile?.adcp_supported_versions?.includes(served)) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${served}, which its supported_versions do not list${context}`);
  }
  let servedProbe: ReleaseProbe;
  try {
    servedProbe = repin(served);
  } catch (error) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${served}, but no hosted bundle is available to validate it: ${error instanceof Error ? error.message : String(error)}${context}`);
  }
  const servedResult = await discover(url, servedProbe.options);
  const reserved = servedRelease(servedResult);
  if (reserved !== undefined && reserved !== served) {
    throw new SmokeFailure('semantic', `Agent served AdCP ${served} to a ${pinned} pin, but ${reserved} when pinned to ${served}`);
  }
  return { probe: servedProbe, result: servedResult };
}

export async function checkProbe(
  url: string,
  options: TestOptions,
  resolverOptions: ResolverOptions,
  anonymous: boolean,
  {
    discover = (endpoint, opts) => boundedDiscovery(endpoint, opts),
    resolve = resolveStoryboardsForCapabilities,
    repin,
  }: { discover?: Discovery; resolve?: Resolver; repin?: RepinProbe } = {},
): Promise<'public' | 'authenticated' | 'auth-required'> {
  for (let attempt = 1; ; attempt++) {
    let result: DiscoveryResult;
    let probe: ReleaseProbe = { options, resolverOptions };
    try {
      // One discovery per negotiated release per attempt; reuse its profile.
      ({ probe, result } = await negotiateServedRelease(url, probe, await discover(url, options), discover, repin));
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
    }, probe.resolverOptions);
    assert(resolved.storyboards.length > 0, 'No applicable storyboards');
    assert(resolved.bundles.length > 0, 'No applicable bundles');
    return anonymous ? 'public' : 'authenticated';
  }
}
