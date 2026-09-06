import { createHash } from 'node:crypto';
import type { ModelRequest, ModelReasoningEffort } from '../model-providers/model-provider.js';
import { ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION } from '../request-tool-replay-binding.js';
import {
  fixedTraceComponentSmokeAdmission,
  isFixedTraceComponentSmokeAdmissionManifest,
} from './fixed-trace-component-smoke-admission.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY,
  fixedTraceComponentSmokePrivateAuthorityMatchesAdmission,
  fixedTraceComponentSmokePrivateAuthorityPlan,
  type FixedTraceComponentSmokePrivateAuthorityPlanEntry,
} from './fixed-trace-component-smoke-private-authority.js';
import type { FixedTraceComponentSmokeVerifiedGrant } from './fixed-trace-component-smoke-private-authorization.js';
import {
  PostgresFixedTraceComponentSmokePrivateLedger,
  type FixedTraceComponentSmokeReservation,
  type FixedTraceComponentSmokeTerminal,
} from './fixed-trace-component-smoke-private-ledger.js';
import { FIXED_TRACE_COMPONENT_SMOKE_PROBES } from './fixed-trace-smoke-overlays.js';

/**
 * This is intentionally an unprovisioned composition boundary.  There is no
 * exported production constructor, credential input, root input, route, job,
 * or ambient activation switch in this module.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_DEFAULT_OFF = true as const;
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_SDK_RETRIES = 0 as const;

type PlanEntry = FixedTraceComponentSmokePrivateAuthorityPlanEntry;
type Provider = 'anthropic' | 'openai' | 'google';
type Usage = NonNullable<FixedTraceComponentSmokeTerminal['usage']>;
type Identity = NonNullable<FixedTraceComponentSmokeTerminal['returnedIdentity']>;

export type FixedTraceComponentSmokeInertProviderReceipt = Readonly<{
  readonly status: 'succeeded' | 'provider_failed' | 'timeout_after_dispatch' | 'malformed_response' | 'identity_mismatch' | 'missing_usage';
  readonly responseDisposition: 'final_response' | 'tool_continuation_required' | null;
  readonly responseHmac: string | null;
  readonly returnedIdentity: Identity | null;
  readonly usage: Usage | null;
}>;

/** A JSON-only fixture. It contains no callback, credential, request, or raw provider response. */
export type FixedTraceComponentSmokeInertProviderFixtures = Readonly<Record<string, FixedTraceComponentSmokeInertProviderReceipt>>;

/** Test-only structural mirror of the durable ledger calls used by the coordinator. */
export type FixedTraceComponentSmokePrivateLiveTestLedger = Pick<PostgresFixedTraceComponentSmokePrivateLedger,
  'reserveAndConsume' | 'recordProviderIntent' | 'recordTerminal' | 'recordUnknownExposure'
  | 'recordNonDispatchTerminal' | 'recordProviderAssignmentTerminal'>;

interface LiveRunCapability { readonly __privateLiveRunCapability: never }
interface ProviderTransport {
  invoke(request: Readonly<ModelRequest>, options: Readonly<{
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxRetries: 0;
  }>): Promise<FixedTraceComponentSmokeInertProviderReceipt>;
}

interface PrivateProviderAdapter {
  invoke(capability: LiveRunCapability, entry: PlanEntry, request: Readonly<ModelRequest>): Promise<FixedTraceComponentSmokeInertProviderReceipt>;
}

const liveRunCapabilities = new WeakSet<object>();

function issueLiveRunCapability(): LiveRunCapability {
  const capability = Object.freeze({}) as LiveRunCapability;
  liveRunCapabilities.add(capability);
  return capability;
}
function hasLiveRunCapability(value: unknown): value is LiveRunCapability {
  return typeof value === 'object' && value !== null && liveRunCapabilities.has(value);
}
function isProvider(value: string): value is Provider {
  return value === 'anthropic' || value === 'openai' || value === 'google';
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
function safeReceipt(value: unknown): value is FixedTraceComponentSmokeInertProviderReceipt {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['responseDisposition', 'responseHmac', 'returnedIdentity', 'status', 'usage'])) return false;
  const receipt = value as Record<string, unknown>;
  const statuses = new Set(['succeeded', 'provider_failed', 'timeout_after_dispatch', 'malformed_response', 'identity_mismatch', 'missing_usage']);
  if (typeof receipt.status !== 'string' || !statuses.has(receipt.status)
    || (receipt.responseHmac !== null && (typeof receipt.responseHmac !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.responseHmac)))) return false;
  if (receipt.status === 'succeeded' && receipt.responseDisposition !== 'final_response' && receipt.responseDisposition !== 'tool_continuation_required') return false;
  if (receipt.status !== 'succeeded' && receipt.responseDisposition !== null) return false;
  const identity = receipt.returnedIdentity;
  const usage = receipt.usage;
  const validIdentity = identity !== null && typeof identity === 'object' && exactKeys(identity, ['effort', 'model', 'provider'])
    && Object.values(identity).every((part) => typeof part === 'string' && /^[a-z0-9._:-]{1,128}$/i.test(part));
  const validUsage = usage !== null && typeof usage === 'object' && exactKeys(usage, ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'latencyMs', 'outputTokens'])
    && Object.values(usage).every((part) => Number.isSafeInteger(part) && (part as number) >= 0 && (part as number) <= 1_000_000);
  if ((receipt.status === 'succeeded' || receipt.status === 'provider_failed' || receipt.status === 'identity_mismatch') && (!validIdentity || !validUsage)) return false;
  if (receipt.status === 'missing_usage' && !validIdentity) return false;
  if ((receipt.status === 'malformed_response' || receipt.status === 'missing_usage') && usage !== null) return false;
  if (receipt.status === 'timeout_after_dispatch' && (receipt.responseHmac !== null || identity !== null || usage !== null)) return false;
  if (receipt.status !== 'timeout_after_dispatch' && receipt.responseHmac === null) return false;
  return true;
}

/** The only adapter implementation is capability-gated at invocation time. */
class CapabilityGatedProviderAdapter implements PrivateProviderAdapter {
  constructor(private readonly provider: Provider, private readonly transport: ProviderTransport) {}

  async invoke(capability: LiveRunCapability, entry: PlanEntry, request: Readonly<ModelRequest>): Promise<FixedTraceComponentSmokeInertProviderReceipt> {
    if (!hasLiveRunCapability(capability) || entry.provider !== this.provider || request.model !== entry.model
      || request.maxOutputTokens !== entry.maxOutputTokens || request.reasoning?.effort !== entry.effort) {
      throw new Error('private component-smoke adapter refused an unbound invocation');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), entry.timeoutMs);
    try {
      const receipt = await this.transport.invoke(request, Object.freeze({
        signal: controller.signal, timeoutMs: entry.timeoutMs, maxRetries: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_SDK_RETRIES,
      }));
      if (!safeReceipt(receipt)) throw new Error('private component-smoke adapter received malformed categorical receipt');
      return deepFreeze(structuredClone(receipt));
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertPinnedComposition(): readonly PlanEntry[] {
  const admission = fixedTraceComponentSmokeAdmission();
  if (!isFixedTraceComponentSmokeAdmissionManifest(admission)
    || !fixedTraceComponentSmokePrivateAuthorityMatchesAdmission(admission)
    || admission.fingerprints.aggregateAdmission !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint
    || admission.fingerprints.requestAssemblyPolicyVersion !== ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION
    || admission.cardinality.caseCellAssignments !== 168
    || admission.cardinality.maximumProviderInvocations !== 192
    || admission.pricing.reservationMicrodollars !== 2_819_484) {
    throw new Error('private component-smoke admission pin drift');
  }
  return fixedTraceComponentSmokePrivateAuthorityPlan();
}

function requestFor(entry: PlanEntry): Readonly<ModelRequest> {
  const probe = FIXED_TRACE_COMPONENT_SMOKE_PROBES.find((candidate) => candidate.id === entry.probeId);
  if (!probe || !isProvider(entry.provider)) throw new Error('private component-smoke request plan drift');
  const tools = probe.toolDescriptors.map((tool) => ({
    name: tool.definition.name as string,
    description: tool.definition.description as string,
    inputSchema: structuredClone(tool.definition.input_schema) as ModelRequest['tools'][number]['inputSchema'],
  }));
  const request: ModelRequest = {
    model: entry.model,
    system: [{ text: 'Fixed-trace private component-smoke synthetic request.' }],
    messages: [
      ...probe.visibleFacts.threadContext.map((message) => ({ role: message.user === 'member' ? 'user' as const : 'assistant' as const, content: [{ type: 'text' as const, text: message.text }] })),
      { role: 'user' as const, content: [{ type: 'text' as const, text: probe.visibleFacts.message }] },
    ],
    tools,
    reasoning: { effort: entry.effort as ModelReasoningEffort },
    maxOutputTokens: entry.maxOutputTokens,
    requestMetadata: { fixedTraceAdmissionFingerprint: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint },
  };
  return deepFreeze(request);
}
function fixtureKey(request: Readonly<ModelRequest>): string {
  return `${request.requestMetadata?.fixedTraceAdmissionFingerprint}:${request.model}:${request.reasoning?.effort ?? 'provider_default'}`;
}
function attemptId(reservation: FixedTraceComponentSmokeReservation, entry: PlanEntry, ordinal: number): string {
  return `attempt_${createHash('sha256').update(JSON.stringify({ domain: 'adcp:addie:fixed-trace-component-smoke:live-attempt:v1\\0', reservationId: reservation.reservationId, assignmentId: entry.assignmentId, ordinal })).digest('hex').slice(0, 32)}`;
}

/**
 * This private coordinator is deliberately unconstructible in production in
 * this PR. A later exact trust-root provisioning change can be reviewed for a
 * module-local construction path; no caller can supply one today.
 */
class PrivateLiveCoordinator {
  constructor(
    private readonly capability: LiveRunCapability,
    private readonly ledger: PostgresFixedTraceComponentSmokePrivateLedger,
    private readonly adapters: ReadonlyMap<Provider, PrivateProviderAdapter>,
    private readonly preparedRequestHmac: (request: Readonly<ModelRequest>) => string,
    private readonly grant: FixedTraceComponentSmokeVerifiedGrant,
  ) {}

  private async closeAmbiguity(reservation: FixedTraceComponentSmokeReservation): Promise<void> {
    await this.ledger.recordUnknownExposure(reservation);
  }

  async run(): Promise<Readonly<{ status: 'completed' | 'halted'; providerInvocations: number }>> {
    const plan = assertPinnedComposition();
    const reserved = await this.ledger.reserveAndConsume(this.grant);
    if (reserved.status !== 'reserved') return Object.freeze({ status: 'halted', providerInvocations: 0 });
    let providerInvocations = 0;
    for (const entry of plan) {
      if (entry.disposition !== 'provider_dispatch') {
        const terminal = await this.ledger.recordNonDispatchTerminal({ reservation: reserved.reservation, assignmentId: entry.assignmentId, status: entry.disposition });
        if (terminal.status !== 'recorded') { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
        continue;
      }
      const adapter = isProvider(entry.provider) ? this.adapters.get(entry.provider) : undefined;
      if (!adapter) { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
      const request = requestFor(entry);
      let finalOrdinal = 0;
      for (let ordinal = 1; ordinal <= entry.maximumProviderInvocations; ordinal += 1) {
        const hmac = this.preparedRequestHmac(request);
        if (!/^[a-f0-9]{64}$/.test(hmac)) { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
        const intent = await this.ledger.recordProviderIntent({ reservation: reserved.reservation, attemptId: attemptId(reserved.reservation, entry, ordinal), assignmentId: entry.assignmentId, invocationOrdinal: ordinal, preparedRequestHmac: hmac });
        if (intent.status !== 'recorded') { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
        let receipt: FixedTraceComponentSmokeInertProviderReceipt;
        try { receipt = await adapter.invoke(this.capability, entry, request); providerInvocations += 1; }
        catch { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
        const terminal = await this.ledger.recordTerminal({ reservation: reserved.reservation, attemptId: attemptId(reserved.reservation, entry, ordinal), ...receipt });
        if (terminal.status !== 'recorded') { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
        finalOrdinal = ordinal;
        if (receipt.status !== 'succeeded') {
          const outcome = await this.ledger.recordProviderAssignmentTerminal({ reservation: reserved.reservation, assignmentId: entry.assignmentId,
            status: 'provider_failed', finalInvocationOrdinal: finalOrdinal });
          if (outcome.status !== 'recorded') await this.closeAmbiguity(reserved.reservation);
          await this.closeAmbiguity(reserved.reservation);
          return Object.freeze({ status: 'halted', providerInvocations });
        }
        if (receipt.responseDisposition === 'final_response') break;
      }
      const outcome = await this.ledger.recordProviderAssignmentTerminal({ reservation: reserved.reservation, assignmentId: entry.assignmentId,
        status: 'provider_completed', finalInvocationOrdinal: finalOrdinal });
      if (outcome.status !== 'recorded') { await this.closeAmbiguity(reserved.reservation); return Object.freeze({ status: 'halted', providerInvocations }); }
    }
    return Object.freeze({ status: 'completed', providerInvocations });
  }
}

/** Production remains unprovisioned until an exact, separately reviewed trust-root change. */
export function createFixedTraceComponentSmokePrivateLiveCoordinator(): null { return null; }

/**
 * Test-only execution harness. Its sole transport is the inert JSON fixture
 * map below; it has no SDK construction, provider endpoint, credential, or
 * production grant verification path. The real coordinator remains private.
 */
export function createFixedTraceComponentSmokePrivateLiveCoordinatorForTest(input: Readonly<{
  readonly ledger: FixedTraceComponentSmokePrivateLiveTestLedger;
  readonly grant: FixedTraceComponentSmokeVerifiedGrant;
  readonly fixtures: FixedTraceComponentSmokeInertProviderFixtures;
}>) {
  const copied = structuredClone(input.fixtures) as FixedTraceComponentSmokeInertProviderFixtures;
  if (Object.values(copied).some((receipt) => !safeReceipt(receipt))) throw new Error('invalid inert provider fixture');
  const capability = issueLiveRunCapability();
  const adapters = new Map<Provider, PrivateProviderAdapter>();
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    adapters.set(provider, new CapabilityGatedProviderAdapter(provider, {
      async invoke(request) {
        const receipt = copied[fixtureKey(request)];
        if (!receipt) throw new Error('missing inert provider fixture');
        return receipt;
      },
    }));
  }
  const coordinator = new PrivateLiveCoordinator(capability, input.ledger as PostgresFixedTraceComponentSmokePrivateLedger, adapters,
    (request) => createHash('sha256').update(JSON.stringify(request)).digest('hex'), input.grant);
  return Object.freeze({ runForTest: () => coordinator.run() });
}

/**
 * Test-only inert adapter fixture harness. It cannot accept a transport or a
 * credential, and it never creates a coordinator, grant, ledger, or request
 * dispatcher. The capability stays module-private even to this harness.
 */
export function createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures: FixedTraceComponentSmokeInertProviderFixtures) {
  const copied = structuredClone(fixtures) as FixedTraceComponentSmokeInertProviderFixtures;
  if (Object.values(copied).some((receipt) => !safeReceipt(receipt))) throw new Error('invalid inert provider fixture');
  const capability = issueLiveRunCapability();
  const adapters = new Map<Provider, PrivateProviderAdapter>();
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    adapters.set(provider, new CapabilityGatedProviderAdapter(provider, {
      async invoke(request) {
        const receipt = copied[fixtureKey(request)];
        if (!receipt) throw new Error('missing inert provider fixture');
        return receipt;
      },
    }));
  }
  return Object.freeze({
    requestForTest(assignmentId: string): Readonly<ModelRequest> {
      const entry = assertPinnedComposition().find((candidate) => candidate.assignmentId === assignmentId);
      if (!entry || entry.disposition !== 'provider_dispatch') throw new Error('unadmitted provider assignment');
      return requestFor(entry);
    },
    async invokeForTest(assignmentId: string): Promise<FixedTraceComponentSmokeInertProviderReceipt> {
      const entry = assertPinnedComposition().find((candidate) => candidate.assignmentId === assignmentId);
      if (!entry || entry.disposition !== 'provider_dispatch' || !isProvider(entry.provider)) throw new Error('unadmitted provider assignment');
      return adapters.get(entry.provider)!.invoke(capability, entry, requestFor(entry));
    },
  });
}
