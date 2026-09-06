/**
 * Immutable, credential-free price evidence for the prospective Addie model
 * evaluation. This is accounting input only: it does not construct a provider
 * or authorize a dispatch.
 */
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { ModelConfig } from '../../config/models.js';
import { resolveKnownClaudePricingModel } from '../claude-pricing.js';
import {
  GOOGLE_ROUTER_MODEL,
  isGoogleRouterModelRevision,
} from '../model-providers/google-generate-content-provider.js';
import {
  OPENAI_ROUTER_MODEL,
  openaiReturnedModelIdentityMatches,
} from '../model-providers/openai-responses-provider.js';
import type { ModelProviderId } from '../model-providers/model-provider.js';

const COHORT_DIGEST_DOMAIN = 'adcp:addie:dated-prospective-pricing-cohort:v1\0';
const CHECKED_AT = '2026-09-05T23:55:26.000Z';

export type EvaluationPricingCandidateId =
  | 'anthropic-router'
  | 'anthropic-generation'
  | 'openai-router-generator'
  | 'google-router-generator';
export type CacheAccounting = 'additive' | 'subset' | 'unsupported';

export interface OfficialPricingSource {
  readonly provider: ModelProviderId;
  readonly url: string;
  readonly retrievedAt: string;
  readonly unit: 'USD per 1M tokens';
  readonly serviceTier: 'standard';
  readonly currency: 'USD';
  readonly evidence: string;
}

export interface DatedPricingRecord {
  readonly candidateId: EvaluationPricingCandidateId;
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly serviceTier: 'standard';
  /** First instant this reviewed cohort, rather than an inferred provider rate, is usable. */
  readonly effectiveFrom: string;
  /** Exclusive upper bound; null only where the official evidence has no expiry. */
  readonly effectiveBefore: string | null;
  readonly profileId: string;
  readonly rates: {
    readonly inputUsdPerMillionTokens: number;
    readonly outputUsdPerMillionTokens: number;
    readonly cacheReadUsdPerMillionTokens: number | null;
    readonly cacheWriteUsdPerMillionTokens: number | null;
    readonly cacheReadAccounting: CacheAccounting;
    readonly cacheWriteAccounting: CacheAccounting;
  };
  readonly source: OfficialPricingSource;
  /** The pre-existing fixed-trace ledger description, retained for artifact compatibility. */
  readonly sourceLabel: string;
  readonly identityDependency: 'not_required' | 'exact_returned_model_identity_enforced';
}

export interface DatedPricingProfile {
  readonly candidateId: EvaluationPricingCandidateId;
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly serviceTier: 'standard';
  readonly profileId: string;
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  readonly cacheReadUsdPerMillionTokens: number | null;
  readonly cacheWriteUsdPerMillionTokens: number | null;
  readonly cacheReadAccounting: CacheAccounting;
  readonly cacheWriteAccounting: CacheAccounting;
  readonly source: string;
  readonly sourceEvidence: OfficialPricingSource;
  readonly effectiveFrom: string;
  readonly effectiveBefore: string | null;
  readonly identityDependency: DatedPricingRecord['identityDependency'];
}

export interface DatedPricingUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type DatedPricingUnavailabilityReason =
  | 'candidate_model_drift'
  | 'returned_model_identity_unproven'
  | 'pricing_record_missing'
  | 'pricing_record_invalid'
  | 'pricing_outside_effective_interval';

export interface DatedPricingCohort {
  readonly checkedAt: string;
  readonly requestedAt: string;
  readonly digest: string;
  readonly profiles: readonly DatedPricingProfile[];
}

export type ResolveDatedPricingCohortResult =
  | { readonly status: 'available'; readonly cohort: DatedPricingCohort }
  | {
    readonly status: 'unavailable';
    readonly reasons: readonly { readonly candidateId: EvaluationPricingCandidateId; readonly reason: DatedPricingUnavailabilityReason }[];
  };

/** Candidate ownership is part of the reviewed cohort, not live configuration. */
const CANDIDATE_PROVIDERS: Readonly<Record<EvaluationPricingCandidateId, ModelProviderId>> = Object.freeze({
  'anthropic-router': 'anthropic',
  'anthropic-generation': 'anthropic',
  'openai-router-generator': 'openai',
  'google-router-generator': 'google',
});

const OFFICIAL_PRICING_RECORDS: readonly DatedPricingRecord[] = deepFreeze([
  {
    candidateId: 'anthropic-router', provider: 'anthropic', model: 'claude-haiku-4-5',
    serviceTier: 'standard', effectiveFrom: CHECKED_AT, effectiveBefore: null,
    profileId: 'anthropic-standard-2026-09:claude-haiku-4-5',
    rates: {
      inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5,
      cacheReadUsdPerMillionTokens: 0.1, cacheWriteUsdPerMillionTokens: 1.25,
      cacheReadAccounting: 'additive', cacheWriteAccounting: 'additive',
    },
    source: {
      provider: 'anthropic', url: 'https://platform.claude.com/docs/en/about-claude/pricing',
      retrievedAt: CHECKED_AT, unit: 'USD per 1M tokens', serviceTier: 'standard', currency: 'USD',
      evidence: 'Claude API standard rates; cache reads are 0.1x and five-minute writes are 1.25x base input.',
    },
    sourceLabel: 'Anthropic pricing page: Claude Haiku 4.5, checked 2026-09-05.',
    identityDependency: 'not_required',
  },
  {
    candidateId: 'anthropic-generation', provider: 'anthropic', model: 'claude-sonnet-5',
    serviceTier: 'standard', effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveBefore: null,
    profileId: 'anthropic-standard-2026-09:claude-sonnet-5',
    rates: {
      inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10,
      cacheReadUsdPerMillionTokens: 0.2, cacheWriteUsdPerMillionTokens: 2.5,
      cacheReadAccounting: 'additive', cacheWriteAccounting: 'additive',
    },
    source: {
      provider: 'anthropic', url: 'https://platform.claude.com/docs/en/about-claude/pricing',
      retrievedAt: CHECKED_AT, unit: 'USD per 1M tokens', serviceTier: 'standard', currency: 'USD',
      evidence: 'Claude Sonnet 5 standard rate; five-minute cache writes are 1.25x base input and reads are 0.1x.',
    },
    sourceLabel: 'Anthropic pricing page: Claude Sonnet 5 standard (5-minute cache write), checked 2026-09-05.',
    identityDependency: 'not_required',
  },
  {
    candidateId: 'openai-router-generator', provider: 'openai', model: 'gpt-5.6-luna',
    serviceTier: 'standard', effectiveFrom: CHECKED_AT, effectiveBefore: null,
    profileId: 'openai-gpt-5.6-luna-standard-2026-09-05',
    rates: {
      inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2,
      cacheReadUsdPerMillionTokens: 0.02, cacheWriteUsdPerMillionTokens: null,
      cacheReadAccounting: 'subset', cacheWriteAccounting: 'unsupported',
    },
    source: {
      provider: 'openai', url: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
      retrievedAt: CHECKED_AT, unit: 'USD per 1M tokens', serviceTier: 'standard', currency: 'USD',
      evidence: 'Responses API model card lists input, cached-input, and output rates. The adapter exposes cache-write usage, but no official normalized cache-write accounting relationship is established here, so that category is unavailable.',
    },
    sourceLabel: 'OpenAI gpt-5.6-luna standard, checked 2026-09-05.',
    // origin/main@712ddc676 routes this same typed predicate through the
    // Responses adapter before it emits a normalized result.
    identityDependency: 'exact_returned_model_identity_enforced',
  },
  {
    candidateId: 'google-router-generator', provider: 'google', model: 'gemini-3.7-flash',
    serviceTier: 'standard', effectiveFrom: CHECKED_AT, effectiveBefore: '2027-01-01T00:00:00.000Z',
    profileId: 'google-gemini-3.7-flash-through-2026-12-31',
    rates: {
      inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 3.75,
      cacheReadUsdPerMillionTokens: 0.075, cacheWriteUsdPerMillionTokens: null,
      cacheReadAccounting: 'subset', cacheWriteAccounting: 'unsupported',
    },
    source: {
      provider: 'google', url: 'https://ai.google.dev/gemini-api/docs/pricing',
      retrievedAt: CHECKED_AT, unit: 'USD per 1M tokens', serviceTier: 'standard', currency: 'USD',
      evidence: 'Paid standard introductory rates through December 31, 2026; output includes thinking tokens and the adapter exposes only cached-content reads, not a cache-write token category.',
    },
    sourceLabel: 'Google Gemini 3.7 Flash introductory standard, checked 2026-09-05.',
    identityDependency: 'not_required',
  },
]);

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function safeDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isSafeInteger(instant) && new Date(instant).toISOString() === value ? instant : null;
}

function safeRequestedAt(value: unknown): string | null {
  try {
    const instant = Date.prototype.getTime.call(value);
    return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
  } catch {
    return null;
  }
}

/** Read only own data descriptors so hostile arrays cannot run a getter while being validated. */
function ownArrayValues(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) return null;
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) return null;
    values.push(descriptor.value);
  }
  return values;
}

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) throw new Error('record is not a plain data object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('record has an unexpected prototype');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) throw new Error(`record field ${key} is missing or accessor-backed`);
  return descriptor.value;
}

function assertOfficialSource(source: unknown, provider: ModelProviderId): asserts source is OfficialPricingSource {
  const sourceProvider = ownData(source, 'provider');
  const url = ownData(source, 'url');
  const retrievedAt = ownData(source, 'retrievedAt');
  const unit = ownData(source, 'unit');
  const serviceTier = ownData(source, 'serviceTier');
  const currency = ownData(source, 'currency');
  const evidence = ownData(source, 'evidence');
  if (sourceProvider !== provider || unit !== 'USD per 1M tokens' || serviceTier !== 'standard' || currency !== 'USD'
    || typeof evidence !== 'string' || !evidence.trim() || safeDate(retrievedAt) === null || typeof url !== 'string') throw new Error('official source fields are invalid');
  const allowedHost: Record<ModelProviderId, string> = {
    anthropic: 'platform.claude.com', openai: 'developers.openai.com', google: 'ai.google.dev',
  };
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('official source URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== allowedHost[provider] || parsed.username || parsed.password || parsed.hash) {
    throw new Error('official source URL is not provider-owned HTTPS');
  }
}

function assertRecord(record: unknown): asserts record is DatedPricingRecord {
  const candidateId = ownData(record, 'candidateId');
  const provider = ownData(record, 'provider');
  const model = ownData(record, 'model');
  const serviceTier = ownData(record, 'serviceTier');
  const effectiveFrom = ownData(record, 'effectiveFrom');
  const effectiveBefore = ownData(record, 'effectiveBefore');
  const profileId = ownData(record, 'profileId');
  const rates = ownData(record, 'rates');
  const source = ownData(record, 'source');
  const sourceLabel = ownData(record, 'sourceLabel');
  const identityDependency = ownData(record, 'identityDependency');
  if (!['anthropic-router', 'anthropic-generation', 'openai-router-generator', 'google-router-generator'].includes(candidateId as string)
    || !['anthropic', 'openai', 'google'].includes(provider as string)
    || typeof model !== 'string' || !model.trim() || serviceTier !== 'standard'
    || typeof profileId !== 'string' || !profileId.trim() || typeof sourceLabel !== 'string' || !sourceLabel.trim()
    || !['not_required', 'exact_returned_model_identity_enforced'].includes(identityDependency as string)) throw new Error('pricing record identity is invalid');
  if (CANDIDATE_PROVIDERS[candidateId as EvaluationPricingCandidateId] !== provider) {
    throw new Error('pricing record candidate provider is invalid');
  }
  const start = safeDate(effectiveFrom);
  const end = effectiveBefore === null ? null : safeDate(effectiveBefore);
  if (start === null || (effectiveBefore !== null && end === null) || (end !== null && end <= start)) throw new Error('pricing effective interval is invalid');
  assertOfficialSource(source, provider as ModelProviderId);
  const values = [
    ownData(rates, 'inputUsdPerMillionTokens'), ownData(rates, 'outputUsdPerMillionTokens'),
    ownData(rates, 'cacheReadUsdPerMillionTokens'), ownData(rates, 'cacheWriteUsdPerMillionTokens'),
  ];
  const readAccounting = ownData(rates, 'cacheReadAccounting');
  const writeAccounting = ownData(rates, 'cacheWriteAccounting');
  if (!Number.isFinite(values[0]) || (values[0] as number) < 0 || !Number.isFinite(values[1]) || (values[1] as number) < 0
    || !['additive', 'subset', 'unsupported'].includes(readAccounting as string)
    || !['additive', 'subset', 'unsupported'].includes(writeAccounting as string)) throw new Error('pricing token categories are invalid');
  for (const [value, accounting] of [[values[2], readAccounting], [values[3], writeAccounting]] as const) {
    if ((accounting === 'unsupported') !== (value === null)
      || (value !== null && (!Number.isFinite(value) || (value as number) < 0))) throw new Error('pricing cache category is invalid');
  }
}

function profileFrom(record: DatedPricingRecord): DatedPricingProfile {
  return deepFreeze({
    candidateId: record.candidateId, provider: record.provider, model: record.model, serviceTier: record.serviceTier, profileId: record.profileId,
    ...record.rates, source: record.sourceLabel, sourceEvidence: { ...record.source },
    effectiveFrom: record.effectiveFrom, effectiveBefore: record.effectiveBefore,
    identityDependency: record.identityDependency,
  });
}

/** Validates a copied registry before it can become a cohort; no caller object is retained. */
export function buildDatedPricingCohort(
  records: unknown,
  requestedAt: unknown,
): ResolveDatedPricingCohortResult {
  const requestedAtIso = safeRequestedAt(requestedAt);
  const recordValues = ownArrayValues(records);
  if (!requestedAtIso || !recordValues) {
    return { status: 'unavailable', reasons: deepFreeze([{ candidateId: 'anthropic-router', reason: 'pricing_record_invalid' }]) };
  }
  try {
    const copied = recordValues.map((record) => {
      assertRecord(record);
      return profileFrom(record);
    });
    const keys = new Set<string>();
    for (const profile of copied) {
      const key = `${profile.provider}\0${profile.model}\0${profile.serviceTier ?? 'standard'}\0${profile.effectiveFrom}\0${profile.effectiveBefore ?? ''}`;
      if (keys.has(key)) throw new Error('duplicate price record');
      keys.add(key);
    }
    const at = Date.parse(requestedAtIso);
    const reasons = copied
      .filter((profile) => at < Date.parse(profile.effectiveFrom)
        || (profile.effectiveBefore !== null && at >= Date.parse(profile.effectiveBefore)))
      .map((profile) => ({ candidateId: profile.candidateId, reason: 'pricing_outside_effective_interval' as const }));
    if (reasons.length) return { status: 'unavailable', reasons: deepFreeze(reasons.sort(byCandidate)) };
    const profiles = copied.sort(byCandidate);
    const digest = cohortDigest(profiles);
    return { status: 'available', cohort: deepFreeze({ checkedAt: CHECKED_AT, requestedAt: requestedAtIso, digest, profiles }) };
  } catch {
    return { status: 'unavailable', reasons: deepFreeze([{ candidateId: 'anthropic-router', reason: 'pricing_record_invalid' }]) };
  }
}

function byCandidate<T extends { candidateId: string }>(left: T, right: T): number {
  return left.candidateId.localeCompare(right.candidateId);
}

function cohortDigest(profiles: readonly DatedPricingProfile[]): string {
  const canonical = profiles.map((profile) => ({
    candidateId: profile.candidateId, provider: profile.provider, model: profile.model, profileId: profile.profileId,
    effectiveFrom: profile.effectiveFrom, effectiveBefore: profile.effectiveBefore, identityDependency: profile.identityDependency, rates: {
      input: profile.inputUsdPerMillionTokens, output: profile.outputUsdPerMillionTokens,
      cacheRead: profile.cacheReadUsdPerMillionTokens, cacheWrite: profile.cacheWriteUsdPerMillionTokens,
      cacheReadAccounting: profile.cacheReadAccounting, cacheWriteAccounting: profile.cacheWriteAccounting,
    }, source: profile.sourceEvidence,
  }));
  return `sha256:${createHash('sha256').update(COHORT_DIGEST_DOMAIN, 'utf8').update(JSON.stringify(canonical), 'utf8').digest('hex')}`;
}

/** Review-only profiles for fixed-trace artifact validation; this grants no provider admission. */
export function datedPricingProfilesForFixedTrace(): readonly DatedPricingProfile[] {
  const result = buildDatedPricingCohort(OFFICIAL_PRICING_RECORDS, new Date(CHECKED_AT));
  if (result.status !== 'available') throw new Error('built-in dated pricing registry is invalid');
  return result.cohort.profiles;
}

/** Immutable evidence copies for audit and deterministic downstream planning. */
export function officialDatedPricingRecordsForAudit(): readonly DatedPricingRecord[] {
  return deepFreeze(structuredClone(OFFICIAL_PRICING_RECORDS));
}

/** Exact candidates are derived from the live configuration and adapter constants. */
export function currentEvaluationPricingCandidates(): readonly Readonly<{
  candidateId: EvaluationPricingCandidateId;
  provider: ModelProviderId;
  model: string;
}>[] {
  return deepFreeze([
    { candidateId: 'anthropic-router', provider: 'anthropic', model: ModelConfig.fast },
    { candidateId: 'anthropic-generation', provider: 'anthropic', model: ModelConfig.primary },
    { candidateId: 'openai-router-generator', provider: 'openai', model: OPENAI_ROUTER_MODEL },
    { candidateId: 'google-router-generator', provider: 'google', model: GOOGLE_ROUTER_MODEL },
  ]);
}

/**
 * Returns a complete cohort only if every current candidate is interval-valid
 * and its returned-model identity prerequisite is independently proven.
 */
export function resolveCurrentEvaluationPricingCohort(
  requestedAt: Date = new Date(),
  candidateIds: readonly EvaluationPricingCandidateId[] = currentEvaluationPricingCandidates().map((candidate) => candidate.candidateId),
): ResolveDatedPricingCohortResult {
  const candidateValues = ownArrayValues(candidateIds);
  const allowed = new Set<EvaluationPricingCandidateId>([
    'anthropic-router', 'anthropic-generation', 'openai-router-generator', 'google-router-generator',
  ]);
  if (!candidateValues || candidateValues.length === 0
    || candidateValues.some((candidate) => typeof candidate !== 'string' || !allowed.has(candidate as EvaluationPricingCandidateId))
    || new Set(candidateValues).size !== candidateValues.length) {
    return { status: 'unavailable', reasons: deepFreeze([{ candidateId: 'anthropic-router', reason: 'pricing_record_invalid' }]) };
  }
  const selected = new Set(candidateValues as EvaluationPricingCandidateId[]);
  const selectedRecords = [...selected].map((candidateId) => (
    OFFICIAL_PRICING_RECORDS.find((record) => record.candidateId === candidateId)
  ));
  const missing = selectedRecords
    .map((record, index) => record === undefined
      ? { candidateId: candidateValues[index] as EvaluationPricingCandidateId, reason: 'pricing_record_missing' as const }
      : null)
    .filter((reason): reason is { candidateId: EvaluationPricingCandidateId; reason: 'pricing_record_missing' } => reason !== null);
  if (missing.length) return { status: 'unavailable', reasons: deepFreeze(missing.sort(byCandidate)) };
  const base = buildDatedPricingCohort(selectedRecords, requestedAt);
  if (base.status !== 'available') return base;
  const current = currentEvaluationPricingCandidates();
  const reasons: Array<{ candidateId: EvaluationPricingCandidateId; reason: DatedPricingUnavailabilityReason }> = [];
  for (const candidate of current) {
    if (!selected.has(candidate.candidateId)) continue;
    const profile = base.cohort.profiles.find((item) => item.candidateId === candidate.candidateId);
    if (!profile || profile.provider !== candidate.provider || profile.model !== candidate.model) {
      reasons.push({ candidateId: candidate.candidateId, reason: 'candidate_model_drift' });
      continue;
    }
    if (profile.identityDependency === 'exact_returned_model_identity_enforced' && (
      !openaiReturnedModelIdentityMatches(profile.model, profile.model)
      || openaiReturnedModelIdentityMatches(profile.model, `${profile.model}-unreviewed-alias`)
    )) {
      reasons.push({ candidateId: candidate.candidateId, reason: 'returned_model_identity_unproven' });
    }
  }
  if (reasons.length) return { status: 'unavailable', reasons: deepFreeze(reasons.sort(byCandidate)) };
  return { status: 'available', cohort: deepFreeze({ ...base.cohort, profiles: base.cohort.profiles.filter((profile) => selected.has(profile.candidateId)) }) };
}

export function pricingProfileForCandidate(
  cohort: DatedPricingCohort,
  candidateId: EvaluationPricingCandidateId,
): DatedPricingProfile {
  const profile = cohort.profiles.find((entry) => entry.candidateId === candidateId);
  if (!profile) throw new Error(`Dated pricing cohort is missing ${candidateId}`);
  return profile;
}

function decimalFraction(rate: number): readonly [number, number] {
  const text = String(rate);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('pricing rate is not a finite decimal');
  const decimals = text.split('.')[1]?.length ?? 0;
  const denominator = 10 ** decimals;
  const numerator = Number(text.replace('.', ''));
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) throw new Error('pricing rate exceeds exact accounting range');
  return [numerator, denominator];
}

/** Exact integer-micro accounting for a cohort profile; fractional micros round up once. */
export function datedPricingCostMicros(profile: DatedPricingProfile, usage: DatedPricingUsage): number {
  const token = (value: unknown, name: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`);
    return value as number;
  };
  const input = token(usage.inputTokens, 'input token count');
  const output = token(usage.outputTokens, 'output token count');
  const read = token(usage.cacheReadTokens ?? 0, 'cache-read token count');
  const write = token(usage.cacheWriteTokens ?? 0, 'cache-write token count');
  if (profile.cacheReadAccounting === 'unsupported' && read > 0) throw new Error('Cache-read pricing is unavailable');
  if (profile.cacheWriteAccounting === 'unsupported' && write > 0) throw new Error('Cache-write pricing is unavailable');
  if (profile.cacheReadAccounting === 'subset' && read > input) throw new Error('Subset cache-read usage exceeds input');
  if (profile.cacheWriteAccounting === 'subset' && write > input - (profile.cacheReadAccounting === 'subset' ? read : 0)) {
    throw new Error('Subset cache-write usage exceeds input');
  }
  const categories: Array<readonly [number, number | null]> = [
    [input - (profile.cacheReadAccounting === 'subset' ? read : 0) - (profile.cacheWriteAccounting === 'subset' ? write : 0), profile.inputUsdPerMillionTokens],
    [output, profile.outputUsdPerMillionTokens], [read, profile.cacheReadUsdPerMillionTokens], [write, profile.cacheWriteUsdPerMillionTokens],
  ];
  let denominator = 1;
  const fractions = categories.map(([count, rate]) => {
    if (rate === null && count !== 0) throw new Error('Cache pricing is unavailable');
    const [numerator, nextDenominator] = decimalFraction(rate ?? 0);
    denominator = Math.max(denominator, nextDenominator);
    return [count, numerator, nextDenominator] as const;
  });
  const total = fractions.reduce((sum, [count, numerator, rateDenominator]) => {
    const contribution = count * numerator * (denominator / rateDenominator);
    if (!Number.isSafeInteger(contribution) || !Number.isSafeInteger(sum + contribution)) throw new Error('Pricing cost exceeds exact accounting range');
    return sum + contribution;
  }, 0);
  return Math.ceil(total / denominator);
}

/** Existing adapter-specific identity rules remain the only alias authority. */
export function cohortReturnedModelMatches(profile: DatedPricingProfile, returnedModel: string): boolean {
  if (profile.provider === 'anthropic') return resolveKnownClaudePricingModel(returnedModel) === profile.model;
  if (profile.provider === 'google') return profile.model === GOOGLE_ROUTER_MODEL && isGoogleRouterModelRevision(returnedModel);
  return openaiReturnedModelIdentityMatches(profile.model, returnedModel);
}
