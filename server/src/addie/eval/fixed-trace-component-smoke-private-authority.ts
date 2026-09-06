import { createHash } from 'node:crypto';

/**
 * The private smoke boundary's reviewed authority is deliberately a leaf
 * module.  It has no live configuration, provider, route, storyboard, clock,
 * or logging dependency.  The admission module independently checks its
 * dynamic review artifact against these immutable values; this leaf is what a
 * later private one-shot composition may safely import.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY = Object.freeze({
  admissionVersion: 'addie-fixed-trace-component-smoke-admission-v2',
  asOf: '2026-09-06T00:00:00.000Z',
  aggregateAdmissionFingerprint: '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d',
  pricingCohortDigest: 'sha256:e8c5736fb62ef4b5c7219401e2f765be7e5a8527472babf54b29ec27539f94e7',
  reservationMicrodollars: 2_819_484,
  providerCeilingMicrodollars: 5_000_000,
  cardinality: Object.freeze({
    probes: 8, routerCells: 10, generationCells: 11, totalCells: 21, repetitions: 1,
    caseCellAssignments: 168, providerDispatchCaseCellAssignments: 126,
    localTerminalCaseCellAssignments: 21, preDispatchFaultCaseCellAssignments: 21,
    maximumPlannedInvocationSlots: 256, maximumProviderInvocations: 192,
  }),
  probes: Object.freeze([
    Object.freeze({ id: 'component-smoke-surface-channel-chatter-v1', disposition: 'local_terminal' as const }),
    Object.freeze({ id: 'component-smoke-knowledge-task-model-v1', disposition: 'provider_dispatch' as const }),
    Object.freeze({ id: 'component-smoke-admin-member-records-without-slack-v1', disposition: 'provider_dispatch' as const }),
    Object.freeze({ id: 'component-smoke-billing-invoice-confirmed-v1', disposition: 'provider_dispatch' as const }),
    Object.freeze({ id: 'component-smoke-tool-result-prompt-injection-v1', disposition: 'provider_dispatch' as const }),
    Object.freeze({ id: 'component-smoke-dev-tool-error-retry-v1', disposition: 'provider_dispatch' as const }),
    Object.freeze({ id: 'component-smoke-dev-truncation-boundary-v1', disposition: 'provider_dispatch' as const }),
    Object.freeze({ id: 'component-smoke-provider-unavailable-v1', disposition: 'pre_dispatch_fault' as const }),
  ]),
  cells: Object.freeze([
    Object.freeze({ id: 'router:anthropic:claude-haiku-4-5:provider_default', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'provider_default', pricingProfileId: 'anthropic-standard-2026-09:claude-haiku-4-5', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 11126 }),
    Object.freeze({ id: 'router:openai:gpt-5.6-luna:provider_default', provider: 'openai', model: 'gpt-5.6-luna', effort: 'provider_default', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 1384 }),
    Object.freeze({ id: 'router:openai:gpt-5.6-luna:none', provider: 'openai', model: 'gpt-5.6-luna', effort: 'none', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 1384 }),
    Object.freeze({ id: 'router:openai:gpt-5.6-luna:low', provider: 'openai', model: 'gpt-5.6-luna', effort: 'low', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 1384 }),
    Object.freeze({ id: 'router:openai:gpt-5.6-luna:medium', provider: 'openai', model: 'gpt-5.6-luna', effort: 'medium', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 1384 }),
    Object.freeze({ id: 'router:openai:gpt-5.6-luna:high', provider: 'openai', model: 'gpt-5.6-luna', effort: 'high', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 1384 }),
    Object.freeze({ id: 'router:google:gemini-3.7-flash:provider_default', provider: 'google', model: 'gemini-3.7-flash', effort: 'provider_default', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 4197 }),
    Object.freeze({ id: 'router:google:gemini-3.7-flash:low', provider: 'google', model: 'gemini-3.7-flash', effort: 'low', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 4197 }),
    Object.freeze({ id: 'router:google:gemini-3.7-flash:medium', provider: 'google', model: 'gemini-3.7-flash', effort: 'medium', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 4197 }),
    Object.freeze({ id: 'router:google:gemini-3.7-flash:high', provider: 'google', model: 'gemini-3.7-flash', effort: 'high', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 1, maxInputTokens: 4096, maxOutputTokens: 300, timeoutMs: 120000, reservationPerInvocationMicrodollars: 4197 }),
    Object.freeze({ id: 'generation:anthropic:claude-haiku-4-5:provider_default', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'provider_default', pricingProfileId: 'anthropic-standard-2026-09:claude-haiku-4-5', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 43003 }),
    Object.freeze({ id: 'generation:anthropic:claude-sonnet-5:provider_default', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'provider_default', pricingProfileId: 'anthropic-standard-2026-09:claude-sonnet-5', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 86005 }),
    Object.freeze({ id: 'generation:openai:gpt-5.6-luna:provider_default', provider: 'openai', model: 'gpt-5.6-luna', effort: 'provider_default', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 5176 }),
    Object.freeze({ id: 'generation:openai:gpt-5.6-luna:none', provider: 'openai', model: 'gpt-5.6-luna', effort: 'none', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 5176 }),
    Object.freeze({ id: 'generation:openai:gpt-5.6-luna:low', provider: 'openai', model: 'gpt-5.6-luna', effort: 'low', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 5176 }),
    Object.freeze({ id: 'generation:openai:gpt-5.6-luna:medium', provider: 'openai', model: 'gpt-5.6-luna', effort: 'medium', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 5176 }),
    Object.freeze({ id: 'generation:openai:gpt-5.6-luna:high', provider: 'openai', model: 'gpt-5.6-luna', effort: 'high', pricingProfileId: 'openai-gpt-5.6-luna-standard-2026-09-05', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 5176 }),
    Object.freeze({ id: 'generation:google:gemini-3.7-flash:provider_default', provider: 'google', model: 'gemini-3.7-flash', effort: 'provider_default', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 15663 }),
    Object.freeze({ id: 'generation:google:gemini-3.7-flash:low', provider: 'google', model: 'gemini-3.7-flash', effort: 'low', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 15663 }),
    Object.freeze({ id: 'generation:google:gemini-3.7-flash:medium', provider: 'google', model: 'gemini-3.7-flash', effort: 'medium', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 15663 }),
    Object.freeze({ id: 'generation:google:gemini-3.7-flash:high', provider: 'google', model: 'gemini-3.7-flash', effort: 'high', pricingProfileId: 'google-gemini-3.7-flash-through-2026-12-31', maximumProviderInvocations: 2, maxInputTokens: 16384, maxOutputTokens: 900, timeoutMs: 120000, reservationPerInvocationMicrodollars: 15663 }),
  ]),
});

export type FixedTraceComponentSmokePrivateAuthorityPlanEntry = Readonly<{
  assignmentId: string; probeId: string; cellId: string;
  disposition: 'provider_dispatch' | 'local_terminal' | 'pre_dispatch_fault';
  maximumProviderInvocations: number; provider: string; model: string; effort: string;
  pricingProfileId: string; maxInputTokens: number; maxOutputTokens: number; timeoutMs: number;
  retries: 0; reservedMicrodollars: readonly number[];
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('non-canonical number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('non-canonical value');
}
function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }

const PRIVATE_PLAN = Object.freeze(FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.probes.flatMap((probe) => (
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.cells.map((cell) => Object.freeze({
    assignmentId: sha256({ domain: 'adcp:addie:fixed-trace-component-smoke:plan-entry:v1\0', fingerprint: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint, probeId: probe.id, cellId: cell.id }),
    probeId: probe.id, cellId: cell.id, disposition: probe.disposition,
    maximumProviderInvocations: probe.disposition === 'provider_dispatch' ? cell.maximumProviderInvocations : 0,
    provider: cell.provider, model: cell.model, effort: cell.effort, pricingProfileId: cell.pricingProfileId,
    maxInputTokens: cell.maxInputTokens, maxOutputTokens: cell.maxOutputTokens, timeoutMs: cell.timeoutMs,
    retries: 0 as const,
    reservedMicrodollars: Object.freeze(probe.disposition === 'provider_dispatch'
      ? Array.from({ length: cell.maximumProviderInvocations }, () => cell.reservationPerInvocationMicrodollars) : []),
  }))
))) as readonly FixedTraceComponentSmokePrivateAuthorityPlanEntry[];

/** The immutable 8-probe by 21-cell plan, derived only from the authority above. */
export function fixedTraceComponentSmokePrivateAuthorityPlan(): readonly FixedTraceComponentSmokePrivateAuthorityPlanEntry[] {
  const authority = FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY;
  const total = PRIVATE_PLAN.reduce((sum, entry) => sum + entry.reservedMicrodollars.reduce((subtotal, value) => subtotal + value, 0), 0);
  const dispatch = PRIVATE_PLAN.filter((entry) => entry.disposition === 'provider_dispatch');
  if (PRIVATE_PLAN.length !== authority.cardinality.caseCellAssignments
    || new Set(PRIVATE_PLAN.map((entry) => entry.assignmentId)).size !== PRIVATE_PLAN.length
    || dispatch.length !== authority.cardinality.providerDispatchCaseCellAssignments
    || dispatch.reduce((sum, entry) => sum + entry.maximumProviderInvocations, 0) !== authority.cardinality.maximumProviderInvocations
    || total !== authority.reservationMicrodollars) throw new Error('private authority integrity failure');
  return PRIVATE_PLAN;
}

export type FixedTraceComponentSmokePrivateAuthorityUsage = Readonly<{
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}>;

type Price = Readonly<{ provider: string; model: string; input: number; output: number; cacheRead: number | null; cacheWrite: number | null; readAccounting: 'additive' | 'subset' | 'unsupported'; writeAccounting: 'additive' | 'subset' | 'unsupported' }>;
const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'anthropic-standard-2026-09:claude-haiku-4-5': Object.freeze({ provider: 'anthropic', model: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, readAccounting: 'additive', writeAccounting: 'additive' }),
  'anthropic-standard-2026-09:claude-sonnet-5': Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, readAccounting: 'additive', writeAccounting: 'additive' }),
  'openai-gpt-5.6-luna-standard-2026-09-05': Object.freeze({ provider: 'openai', model: 'gpt-5.6-luna', input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, readAccounting: 'subset', writeAccounting: 'subset' }),
  'google-gemini-3.7-flash-through-2026-12-31': Object.freeze({ provider: 'google', model: 'gemini-3.7-flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: null, readAccounting: 'subset', writeAccounting: 'unsupported' }),
});

function fraction(rate: number): readonly [number, number] {
  const text = String(rate); if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('invalid price');
  const decimals = text.split('.')[1]?.length ?? 0;
  return [Number(text.replace('.', '')), 10 ** decimals];
}
/** Exact copied-free integer microdollar settlement for one canonical profile. */
export function fixedTraceComponentSmokePrivateAuthorityCostMicros(profileId: string, usage: FixedTraceComponentSmokePrivateAuthorityUsage): number {
  const price = PRICES[profileId];
  if (!price || !Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('private authority pricing unavailable');
  const { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write } = usage;
  if ((price.readAccounting === 'unsupported' && read !== 0) || (price.writeAccounting === 'unsupported' && write !== 0)
    || (price.readAccounting === 'subset' && read > input)
    || (price.writeAccounting === 'subset' && write > input - (price.readAccounting === 'subset' ? read : 0))) throw new Error('private authority cache usage invalid');
  const categories: Array<readonly [number, number | null]> = [
    [input - (price.readAccounting === 'subset' ? read : 0) - (price.writeAccounting === 'subset' ? write : 0), price.input],
    [output, price.output], [read, price.cacheRead], [write, price.cacheWrite],
  ];
  let denominator = 1;
  for (const [, rate] of categories) if (rate !== null) denominator = Math.max(denominator, fraction(rate)[1]);
  const total = categories.reduce((sum, [count, rate]) => {
    if (rate === null && count !== 0) throw new Error('private authority cache rate unavailable');
    const [numerator, rateDenominator] = fraction(rate ?? 0);
    const contribution = count * numerator * (denominator / rateDenominator);
    if (!Number.isSafeInteger(contribution) || !Number.isSafeInteger(sum + contribution)) throw new Error('private authority cost range exceeded');
    return sum + contribution;
  }, 0);
  return Math.ceil(total / denominator);
}

export function fixedTraceComponentSmokePrivateAuthorityIdentityMatches(profileId: string, identity: Readonly<{ provider: string; model: string }>): boolean {
  const price = PRICES[profileId];
  return price !== undefined && price.provider === identity.provider && price.model === identity.model;
}

export function fixedTraceComponentSmokePrivateAuthorityHasAdditiveCache(profileId: string): boolean {
  const price = PRICES[profileId];
  return price?.readAccounting === 'additive' || price?.writeAccounting === 'additive';
}

/**
 * The live admission artifact remains an independent review check.  It must
 * agree byte-for-byte in all private authority-relevant fields before it can
 * describe this authority as admitted; it is never imported by the runtime.
 */
export function fixedTraceComponentSmokePrivateAuthorityMatchesAdmission(value: unknown): boolean {
  try {
    if (!value || typeof value !== 'object') return false;
    const admission = value as Record<string, any>;
    const authority = FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY;
    if (admission.version !== authority.admissionVersion
      || admission.fingerprints?.aggregateAdmission !== authority.aggregateAdmissionFingerprint
      || admission.pricing?.cohortDigest !== authority.pricingCohortDigest
      || admission.pricing?.reservationMicrodollars !== authority.reservationMicrodollars
      || admission.pricing?.providerCeilingUsd !== authority.providerCeilingMicrodollars / 1_000_000
      || canonicalJson(admission.cardinality) !== canonicalJson(authority.cardinality)
      || !Array.isArray(admission.probes) || !Array.isArray(admission.cells) || !Array.isArray(admission.privateRuntimePlan)) return false;
    if (admission.probes.length !== authority.probes.length || admission.cells.length !== authority.cells.length
      || admission.privateRuntimePlan.length !== PRIVATE_PLAN.length) return false;
    const probesMatch = authority.probes.every((probe, index) => admission.probes[index]?.id === probe.id
      && admission.probes[index]?.dispatchDisposition === probe.disposition);
    const cellsMatch = authority.cells.every((cell, index) => admission.cells[index]?.id === cell.id
      && admission.cells[index]?.provider === cell.provider && admission.cells[index]?.model === cell.model
      && admission.cells[index]?.effort === cell.effort && admission.cells[index]?.pricingProfileId === cell.pricingProfileId);
    const planMatch = PRIVATE_PLAN.every((entry, index) => {
      const candidate = admission.privateRuntimePlan[index];
      return candidate?.probeId === entry.probeId && candidate?.cellId === entry.cellId
        && candidate?.dispatchDisposition === entry.disposition && candidate?.maximumProviderInvocations === entry.maximumProviderInvocations
        && candidate?.pricingProfileId === entry.pricingProfileId && candidate?.preparedRequestHmac === 'required_before_intent'
        && candidate?.maxInputTokensPerInvocation === entry.maxInputTokens && candidate?.maxOutputTokensPerInvocation === entry.maxOutputTokens
        && candidate?.timeoutMs === entry.timeoutMs && candidate?.sdkAutomaticRetries === 0
        && canonicalJson(candidate?.perAttemptReservationMicrodollars) === canonicalJson(entry.reservedMicrodollars);
    });
    return probesMatch && cellsMatch && planMatch;
  } catch { return false; }
}
