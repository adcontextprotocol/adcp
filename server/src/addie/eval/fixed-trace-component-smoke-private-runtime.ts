import { createHash, createHmac } from 'node:crypto';
import {
  createFixedTraceComponentSmokeOneShotGrantVerifier,
  type FixedTraceComponentSmokeOneShotTrustRoot,
} from './fixed-trace-component-smoke-private-authorization.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PREPARED_REQUEST_HMAC_DOMAIN,
  FIXED_TRACE_COMPONENT_SMOKE_RESPONSE_HMAC_DOMAIN,
  fixedTraceComponentSmokePrivateLedgerPlan,
  type FixedTraceComponentSmokeLedgerRefusal,
  type FixedTraceComponentSmokeReservation,
} from './fixed-trace-component-smoke-private-ledger.js';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/**
 * This is a deliberately private composition boundary. It has no route, job,
 * scheduler, environment, SDK, or provider construction import. A caller can
 * supply a signed grant and explicit, already-controlled dependencies, but
 * cannot supply a plan, cell, identity, limit, schedule, or retry policy.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_RUNTIME_DEFAULT_OFF = true as const;
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_RUNTIME_FAKE_ONLY = true as const;

type Plan = NonNullable<ReturnType<typeof fixedTraceComponentSmokePrivateLedgerPlan>>;
type PlanEntry = Plan[number];
type Usage = Readonly<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; latencyMs: number }>;
type Identity = Readonly<{ provider: string; model: string; effort: string }>;

export interface FixedTraceComponentSmokeFakeProviderRequest {
  readonly assignmentId: string;
  readonly probeId: string;
  readonly cellId: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly invocationOrdinal: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly sdkAutomaticRetries: 0;
}

/** A test double is the only adapter shape admitted by this runtime. */
export interface FixedTraceComponentSmokeFakeProvider {
  readonly fakeOnly: true;
  readonly automaticRetries: 0;
  invoke(request: Readonly<FixedTraceComponentSmokeFakeProviderRequest>): Promise<unknown>;
}

/** The runtime only receives operations, never a Pool or ambient DB client. */
export interface FixedTraceComponentSmokePrivateRuntimeLedger {
  reserveAndConsume(grant: object): Promise<unknown>;
  recordProviderIntent(input: object): Promise<unknown>;
  recordTerminal(input: object): Promise<unknown>;
  recordProviderAssignmentTerminal(input: object): Promise<unknown>;
  recordNonDispatchTerminal(input: object): Promise<unknown>;
  recordNotExecutedAfterHalt(input: object): Promise<unknown>;
  recordUnknownExposure(reservation: FixedTraceComponentSmokeReservation): Promise<unknown>;
}

export interface FixedTraceComponentSmokePrivateRuntimeDependencies {
  readonly trustRoot: FixedTraceComponentSmokeOneShotTrustRoot;
  readonly trustRootPin: string;
  /** The opaque signed envelope is verified only when run starts. */
  readonly signedGrant: unknown;
  /** Copied at construction and used only for domain-separated evidence HMACs. */
  readonly evidenceHmacKey: Buffer;
  readonly trustedNow: () => Date;
  readonly ledger: FixedTraceComponentSmokePrivateRuntimeLedger;
  readonly fakeProvider: FixedTraceComponentSmokeFakeProvider;
}

export type FixedTraceComponentSmokePrivateRuntimeResult = Readonly<{
  status: 'completed' | 'halted' | 'refused';
  reason?: FixedTraceComponentSmokeLedgerRefusal | 'invalid_grant' | 'private_composition_invalid' | 'persistence_uncertain';
  assignmentDispositions: number;
  providerInvocations: number;
}>;

type Recorded = Readonly<{ status: 'recorded' }>;
type Refused = Readonly<{ status: 'refused'; reason: string }>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('evidence JSON permits only safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('non-JSON evidence value');
}
function digestAttempt(reservation: FixedTraceComponentSmokeReservation, entry: PlanEntry, ordinal: number): string {
  return `attempt_${createHash('sha256').update(canonicalJson({
    domain: 'adcp:addie:fixed-trace-component-smoke:private-runtime-attempt:v1\0', reservationId: reservation.reservationId,
    assignmentId: entry.assignmentId, invocationOrdinal: ordinal,
  }), 'utf8').digest('hex').slice(0, 32)}`;
}
function hmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(domain, 'utf8').update(canonicalJson(snapshotFixedTraceJson(value, 'private runtime evidence')), 'utf8').digest('hex');
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function safeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'latencyMs', 'outputTokens'])) return null;
  const usage = value as Record<string, unknown>;
  return Object.values(usage).every((part) => Number.isSafeInteger(part) && (part as number) >= 0 && (part as number) <= 1_000_000)
    ? Object.freeze(usage) as Usage : null;
}
function safeIdentity(value: unknown): Identity | null {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['effort', 'model', 'provider'])) return null;
  const identity = value as Record<string, unknown>;
  return [identity.provider, identity.model, identity.effort].every((part) => typeof part === 'string' && part.length > 0 && part.length <= 128 && /^[a-z0-9._:-]+$/i.test(part))
    ? Object.freeze(identity) as Identity : null;
}
function parseRecorded(value: unknown): Recorded | Refused | null {
  try {
    const result = snapshotFixedTraceJson(value, 'private runtime ledger result') as Record<string, unknown>;
    if (exactKeys(result, ['status']) && result.status === 'recorded') return Object.freeze({ status: 'recorded' });
    if (exactKeys(result, ['reason', 'status']) && result.status === 'refused' && typeof result.reason === 'string') return Object.freeze({ status: 'refused', reason: result.reason });
  } catch { /* fail closed */ }
  return null;
}
function parseReservation(value: unknown, authorizationDigest: string): Readonly<{ status: 'reserved'; reservation: FixedTraceComponentSmokeReservation }> | Refused | null {
  try {
    const result = snapshotFixedTraceJson(value, 'private runtime reservation result') as Record<string, unknown>;
    if (exactKeys(result, ['reason', 'status']) && result.status === 'refused' && typeof result.reason === 'string') return Object.freeze({ status: 'refused', reason: result.reason });
    if (!exactKeys(result, ['reservation', 'status']) || result.status !== 'reserved' || !result.reservation || typeof result.reservation !== 'object') return null;
    const reservation = result.reservation as Record<string, unknown>;
    const expectedReservationId = `reservation_${createHash('sha256').update(canonicalJson({
      domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0', authorizationDigest,
    }), 'utf8').digest('hex').slice(0, 32)}`;
    return exactKeys(reservation, ['authorizationDigest', 'entryCount', 'providerDispatchEntryCount', 'reservationId', 'reservationMicrodollars'])
      && typeof reservation.authorizationDigest === 'string' && /^[a-f0-9]{64}$/.test(reservation.authorizationDigest)
      && typeof reservation.reservationId === 'string' && /^reservation_[a-f0-9]{32}$/.test(reservation.reservationId)
      && reservation.authorizationDigest === authorizationDigest && reservation.reservationId === expectedReservationId
      && reservation.entryCount === 168 && reservation.providerDispatchEntryCount === 126 && reservation.reservationMicrodollars === 2_819_484
      ? Object.freeze({ status: 'reserved' as const, reservation: Object.freeze(reservation) as unknown as FixedTraceComponentSmokeReservation }) : null;
  } catch { return null; }
}
function providerReceipt(value: unknown): { usage: Usage | null; identity: Identity | null; disposition: 'final_response' | 'tool_continuation_required' | null; status: 'succeeded' | 'provider_failed' | null; structurallyValid: boolean } {
  try {
    const receipt = snapshotFixedTraceJson(value, 'fake provider receipt') as Record<string, unknown>;
    if (!exactKeys(receipt, ['disposition', 'identity', 'status', 'usage'])) return { usage: null, identity: null, disposition: null, status: null, structurallyValid: false };
    const usage = safeUsage(receipt.usage); const identity = safeIdentity(receipt.identity);
    const disposition = receipt.disposition === 'final_response' || receipt.disposition === 'tool_continuation_required' ? receipt.disposition : null;
    const status = receipt.status === 'succeeded' || receipt.status === 'provider_failed' ? receipt.status : null;
    return { usage, identity, disposition, status, structurallyValid: usage !== null && identity !== null && disposition !== null && status !== null };
  } catch { return { usage: null, identity: null, disposition: null, status: null, structurallyValid: false }; }
}

/**
 * The returned object has no arguments: no production entry point can feed it
 * a mutable execution request. The only dispatch capability is this explicit,
 * fake-only dependency graph.
 */
export function createFixedTraceComponentSmokePrivateRuntime(
  dependencies: FixedTraceComponentSmokePrivateRuntimeDependencies,
): Readonly<{ run(): Promise<FixedTraceComponentSmokePrivateRuntimeResult> }> | null {
  const plan = fixedTraceComponentSmokePrivateLedgerPlan();
  const verifier = createFixedTraceComponentSmokeOneShotGrantVerifier(dependencies.trustRoot, dependencies.trustRootPin);
  if (!plan || !verifier || !Buffer.isBuffer(dependencies.evidenceHmacKey) || dependencies.evidenceHmacKey.length < 16
    || typeof dependencies.trustedNow !== 'function' || !dependencies.ledger || dependencies.fakeProvider?.fakeOnly !== true
    || dependencies.fakeProvider.automaticRetries !== 0 || typeof dependencies.fakeProvider.invoke !== 'function') return null;
  const evidenceHmacKey = Buffer.from(dependencies.evidenceHmacKey);

  return Object.freeze({ run: async (): Promise<FixedTraceComponentSmokePrivateRuntimeResult> => {
    let now: Date;
    try { now = dependencies.trustedNow(); } catch { return { status: 'refused', reason: 'private_composition_invalid', assignmentDispositions: 0, providerInvocations: 0 }; }
    const grant = verifier.verify(dependencies.signedGrant, now);
    if (!grant) return { status: 'refused', reason: 'invalid_grant', assignmentDispositions: 0, providerInvocations: 0 };
    let reserved: Readonly<{ status: 'reserved'; reservation: FixedTraceComponentSmokeReservation }> | Refused | null = null;
    try { reserved = parseReservation(await dependencies.ledger.reserveAndConsume(grant), grant.grantDigest); } catch { /* fail closed */ }
    if (!reserved) return { status: 'refused', reason: 'persistence_uncertain', assignmentDispositions: 0, providerInvocations: 0 };
    if (reserved.status === 'refused') return { status: 'refused', reason: reserved.reason as FixedTraceComponentSmokeLedgerRefusal, assignmentDispositions: 0, providerInvocations: 0 };
    const reservation = reserved.reservation;

    const finished = new Set<string>();
    // recordUnknownExposure atomically assigns a terminal denominator outcome
    // to every started assignment while it closes open intents. Keep that
    // exact set locally so post-halt omission writes address only unstarted
    // assignments.
    const started = new Set<string>();
    let invocations = 0;
    const haltRemainder = async (): Promise<FixedTraceComponentSmokePrivateRuntimeResult> => {
      for (const entry of plan) {
        if (finished.has(entry.assignmentId)) continue;
        let closed: Recorded | Refused | null = null;
        try { closed = parseRecorded(await dependencies.ledger.recordNotExecutedAfterHalt({ reservation, assignmentId: entry.assignmentId })); } catch { /* fail closed */ }
        if (!closed || closed.status !== 'recorded') return { status: 'refused', reason: 'persistence_uncertain', assignmentDispositions: finished.size, providerInvocations: invocations };
        finished.add(entry.assignmentId);
      }
      return { status: 'halted', assignmentDispositions: finished.size, providerInvocations: invocations };
    };
    const forceUnknownAndHalt = async (): Promise<FixedTraceComponentSmokePrivateRuntimeResult> => {
      let poisoned: Recorded | Refused | null = null;
      try { poisoned = parseRecorded(await dependencies.ledger.recordUnknownExposure(reservation!)); } catch { /* fail closed */ }
      if (!poisoned || poisoned.status !== 'recorded') return { status: 'refused', reason: 'persistence_uncertain', assignmentDispositions: finished.size, providerInvocations: invocations };
      for (const assignmentId of started) finished.add(assignmentId);
      return haltRemainder();
    };

    for (const entry of plan) {
      if (entry.disposition !== 'provider_dispatch') {
        let recorded: Recorded | Refused | null = null;
        try { recorded = parseRecorded(await dependencies.ledger.recordNonDispatchTerminal({ reservation, assignmentId: entry.assignmentId, status: entry.disposition })); } catch { /* fail closed */ }
        if (!recorded || recorded.status !== 'recorded') return forceUnknownAndHalt();
        finished.add(entry.assignmentId);
        continue;
      }
      for (let ordinal = 1; ordinal <= entry.maximumProviderInvocations; ordinal += 1) {
        const request = Object.freeze({ assignmentId: entry.assignmentId, probeId: entry.probeId, cellId: entry.cellId,
          provider: entry.provider, model: entry.model, effort: entry.effort, invocationOrdinal: ordinal,
          maxInputTokens: entry.maxInputTokens, maxOutputTokens: entry.maxOutputTokens, timeoutMs: entry.timeoutMs,
          sdkAutomaticRetries: 0 as const });
        let preparedRequestHmac: string;
        try { preparedRequestHmac = hmac(evidenceHmacKey, FIXED_TRACE_COMPONENT_SMOKE_PREPARED_REQUEST_HMAC_DOMAIN, request); } catch { return forceUnknownAndHalt(); }
        const attemptId = digestAttempt(reservation, entry, ordinal);
        let intended: Recorded | Refused | null = null;
        try { intended = parseRecorded(await dependencies.ledger.recordProviderIntent({ reservation, attemptId, assignmentId: entry.assignmentId, invocationOrdinal: ordinal, preparedRequestHmac })); } catch { /* fail closed */ }
        if (!intended || intended.status !== 'recorded') return forceUnknownAndHalt();
        started.add(entry.assignmentId);

        let rawResponse: unknown;
        let thrown = false;
        try { rawResponse = await dependencies.fakeProvider.invoke(request); invocations += 1; } catch { invocations += 1; thrown = true; }
        const receipt = thrown ? null : providerReceipt(rawResponse);
        let responseHmac: string | null = null;
        // Bind the exact fake-provider response to its one committed intent;
        // identical output on two assignments is still distinct evidence.
        if (!thrown) try { responseHmac = hmac(evidenceHmacKey, FIXED_TRACE_COMPONENT_SMOKE_RESPONSE_HMAC_DOMAIN, { attemptId, response: rawResponse }); } catch { return forceUnknownAndHalt(); }
        const identityMatches = receipt?.identity?.provider === entry.provider && receipt.identity.model === entry.model && receipt.identity.effort === entry.effort;
        const terminal = thrown
          ? { reservation, attemptId, status: 'timeout_after_dispatch' as const, responseDisposition: null, usage: null, returnedIdentity: null, responseHmac: null }
          : !receipt!.identity || !receipt!.usage || !receipt!.disposition || !receipt!.status
            ? receipt!.identity && receipt!.status ? { reservation, attemptId, status: 'missing_usage' as const, responseDisposition: null, usage: null, returnedIdentity: receipt!.identity, responseHmac }
              : { reservation, attemptId, status: 'malformed_response' as const, responseDisposition: null, usage: null, returnedIdentity: null, responseHmac }
            : !identityMatches
              ? { reservation, attemptId, status: 'identity_mismatch' as const, responseDisposition: null, usage: receipt!.usage, returnedIdentity: receipt!.identity, responseHmac }
              : { reservation, attemptId, status: receipt!.status, responseDisposition: receipt!.status === 'succeeded' ? receipt!.disposition : null, usage: receipt!.usage, returnedIdentity: receipt!.identity, responseHmac };
        let settled: Recorded | Refused | null = null;
        try { settled = parseRecorded(await dependencies.ledger.recordTerminal(terminal)); } catch { /* unresolved intent: fail closed */ }
        if (!settled || settled.status !== 'recorded') return forceUnknownAndHalt();
        // The ledger independently enforces this too, but the composition
        // boundary must never advance after a continuation has exhausted the
        // frozen assignment's final ordinal.
        if (terminal.status === 'succeeded' && terminal.responseDisposition === 'tool_continuation_required'
          && ordinal === entry.maximumProviderInvocations) return forceUnknownAndHalt();
        if (terminal.status !== 'succeeded' || terminal.responseDisposition === 'final_response') {
          let assignment: Recorded | Refused | null = null;
          try { assignment = parseRecorded(await dependencies.ledger.recordProviderAssignmentTerminal({ reservation, assignmentId: entry.assignmentId, status: terminal.status === 'succeeded' ? 'provider_completed' : 'provider_failed', finalInvocationOrdinal: ordinal })); } catch { /* fail closed */ }
          if (!assignment || assignment.status !== 'recorded') return forceUnknownAndHalt();
          finished.add(entry.assignmentId);
          started.delete(entry.assignmentId);
          if (terminal.status !== 'succeeded') return haltRemainder();
          break;
        }
      }
    }
    return finished.size === 168 && invocations <= 192
      ? { status: 'completed', assignmentDispositions: 168, providerInvocations: invocations }
      : forceUnknownAndHalt();
  } });
}
