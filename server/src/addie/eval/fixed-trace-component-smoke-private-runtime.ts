import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY,
  fixedTraceComponentSmokePrivateAuthorityCostMicros,
  fixedTraceComponentSmokePrivateAuthorityHasAdditiveCache,
  fixedTraceComponentSmokePrivateAuthorityIdentityMatches,
  fixedTraceComponentSmokePrivateAuthorityPlan,
  type FixedTraceComponentSmokePrivateAuthorityPlanEntry,
} from './fixed-trace-component-smoke-private-authority.js';

/** This module deliberately has no provisioned production construction path. */
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_RUNTIME_DEFAULT_OFF = true as const;
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_RUNTIME_FAKE_ONLY = true as const;

type PlanEntry = FixedTraceComponentSmokePrivateAuthorityPlanEntry;
type Usage = Readonly<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; latencyMs: number }>;
type Identity = Readonly<{ provider: string; model: string; effort: string }>;
type Receipt = Readonly<{
  status: 'succeeded' | 'provider_failed';
  disposition: 'final_response' | 'tool_continuation_required';
  identity: Identity;
  usage: Usage;
}>;

/**
 * A JSON-only test/simulation script. JSON.parse produces the internal copy;
 * this module never reads caller objects, invokes caller code, or dispatches.
 */
export type FixedTraceComponentSmokePrivateSimulationScript = string;

export type FixedTraceComponentSmokePrivateRuntimeResult = Readonly<{
  status: 'completed' | 'halted' | 'refused';
  reason?: 'invalid_simulation_script';
  assignmentDispositions: number;
  providerInvocations: number;
}>;

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
function parseReceipt(value: unknown): Receipt | null {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['disposition', 'identity', 'status', 'usage'])) return null;
  const receipt = value as Record<string, unknown>;
  const identity = safeIdentity(receipt.identity); const usage = safeUsage(receipt.usage);
  return identity && usage
    && (receipt.status === 'succeeded' || receipt.status === 'provider_failed')
    && (receipt.disposition === 'final_response' || receipt.disposition === 'tool_continuation_required')
    ? Object.freeze({ status: receipt.status, disposition: receipt.disposition, identity, usage }) : null;
}
function scriptResponses(script: FixedTraceComponentSmokePrivateSimulationScript | undefined, plan: readonly PlanEntry[]): Map<string, Receipt> | null {
  try {
    if (script === undefined) return new Map();
    if (typeof script !== 'string' || script.length > 1_000_000) return null;
    const copied = JSON.parse(script) as Record<string, unknown>;
    if (!exactKeys(copied, ['responses']) || !copied.responses || typeof copied.responses !== 'object' || Array.isArray(copied.responses)) return null;
    const expected = new Set(plan.filter((entry) => entry.disposition === 'provider_dispatch')
      .flatMap((entry) => Array.from({ length: entry.maximumProviderInvocations }, (_, index) => `${entry.assignmentId}:${index + 1}`)));
    const parsed = new Map<string, Receipt>();
    for (const [key, value] of Object.entries(copied.responses as Record<string, unknown>)) {
      if (!expected.has(key)) return null;
      const receipt = parseReceipt(value); if (!receipt) return null;
      parsed.set(key, receipt);
    }
    return parsed;
  } catch { return null; }
}
function defaultReceipt(entry: PlanEntry, ordinal: number): Receipt {
  return Object.freeze({
    status: 'succeeded',
    disposition: entry.maximumProviderInvocations === 2 && ordinal === 1 ? 'tool_continuation_required' : 'final_response',
    identity: Object.freeze({ provider: entry.provider, model: entry.model, effort: entry.effort }),
    usage: Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 }),
  });
}

/**
 * Production remains unconstructible until a separately reviewed custody
 * boundary can issue a non-forgeable capability. This function accepts no
 * dependencies, authority material, provider adapter, or executable callback.
 */
export function createFixedTraceComponentSmokePrivateRuntime(): null { return null; }

/**
 * Pure deterministic simulation only. It records no intent, HMAC, receipt,
 * grant, or provider action; production code cannot use it to authorize or
 * dispatch a model call.
 */
export function simulateFixedTraceComponentSmokePrivateRuntime(
  script?: FixedTraceComponentSmokePrivateSimulationScript,
): FixedTraceComponentSmokePrivateRuntimeResult {
  const plan = fixedTraceComponentSmokePrivateAuthorityPlan();
  const responses = scriptResponses(script, plan);
  if (!responses) return Object.freeze({ status: 'refused', reason: 'invalid_simulation_script', assignmentDispositions: 0, providerInvocations: 0 });
  let invocations = 0;
  let spentMicrodollars = 0;
  for (const entry of plan) {
    if (entry.disposition !== 'provider_dispatch') continue;
    for (let ordinal = 1; ordinal <= entry.maximumProviderInvocations; ordinal += 1) {
      const receipt = responses.get(`${entry.assignmentId}:${ordinal}`) ?? defaultReceipt(entry, ordinal);
      invocations += 1;
      if (receipt.identity.provider !== entry.provider || receipt.identity.model !== entry.model || receipt.identity.effort !== entry.effort
        || !fixedTraceComponentSmokePrivateAuthorityIdentityMatches(entry.pricingProfileId, receipt.identity)
        || receipt.status !== 'succeeded'
        || (receipt.disposition === 'tool_continuation_required' && ordinal === entry.maximumProviderInvocations)) {
        return Object.freeze({ status: 'halted', assignmentDispositions: 168, providerInvocations: invocations });
      }
      let costMicrodollars: number;
      try {
        const additiveCacheOverLimit = fixedTraceComponentSmokePrivateAuthorityHasAdditiveCache(entry.pricingProfileId)
          && (receipt.usage.cacheReadTokens > entry.maxInputTokens || receipt.usage.cacheWriteTokens > entry.maxInputTokens);
        if (receipt.usage.inputTokens > entry.maxInputTokens || additiveCacheOverLimit
          || receipt.usage.outputTokens > entry.maxOutputTokens || receipt.usage.latencyMs > entry.timeoutMs) {
          return Object.freeze({ status: 'halted', assignmentDispositions: 168, providerInvocations: invocations });
        }
        costMicrodollars = fixedTraceComponentSmokePrivateAuthorityCostMicros(entry.pricingProfileId, receipt.usage);
      } catch {
        return Object.freeze({ status: 'halted', assignmentDispositions: 168, providerInvocations: invocations });
      }
      const reservedForOrdinal = entry.reservedMicrodollars[ordinal - 1];
      if (reservedForOrdinal === undefined || costMicrodollars > reservedForOrdinal
        || spentMicrodollars + costMicrodollars > FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.reservationMicrodollars
        || spentMicrodollars + costMicrodollars > FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.providerCeilingMicrodollars) {
        return Object.freeze({ status: 'halted', assignmentDispositions: 168, providerInvocations: invocations });
      }
      spentMicrodollars += costMicrodollars;
      if (receipt.disposition === 'final_response') break;
    }
  }
  return invocations <= FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.cardinality.maximumProviderInvocations
    ? Object.freeze({ status: 'completed', assignmentDispositions: 168, providerInvocations: invocations })
    : Object.freeze({ status: 'halted', assignmentDispositions: 168, providerInvocations: invocations });
}
