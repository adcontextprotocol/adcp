import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDatedPricingCohort,
  cohortReturnedModelMatches,
  datedPricingCostMicros,
  datedPricingProfilesForFixedTrace,
  officialDatedPricingRecordsForAudit,
  pricingProfileForCandidate,
  resolveCurrentEvaluationPricingCohort,
} from '../../../src/addie/eval/dated-pricing-cohort.js';

const AT = new Date('2026-09-05T23:55:26.000Z');

function records() {
  return structuredClone(officialDatedPricingRecordsForAudit());
}

describe('dated prospective evaluation pricing cohort', () => {
  it('derives exact configured candidates and admits OpenAI only through the merged literal-identity boundary', () => {
    const all = resolveCurrentEvaluationPricingCohort(AT);
    expect(all.status).toBe('available');
    if (all.status !== 'available') return;
    expect(pricingProfileForCandidate(all.cohort, 'openai-router-generator').identityDependency)
      .toBe('exact_returned_model_identity_enforced');

    const available = resolveCurrentEvaluationPricingCohort(AT, ['anthropic-router', 'anthropic-generation', 'google-router-generator']);
    expect(available.status).toBe('available');
    if (available.status !== 'available') return;
    expect(available.cohort.profiles.map((profile) => [profile.candidateId, profile.model])).toEqual([
      ['anthropic-generation', 'claude-sonnet-5'],
      ['anthropic-router', 'claude-haiku-4-5'],
      ['google-router-generator', 'gemini-3.7-flash'],
    ]);
    const sonnet = pricingProfileForCandidate(available.cohort, 'anthropic-generation');
    expect(sonnet).toMatchObject({
      inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10,
      cacheWriteUsdPerMillionTokens: 2.5, cacheReadUsdPerMillionTokens: 0.2,
      effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveBefore: null,
    });
    expect(sonnet.sourceEvidence.url).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
    expect(sonnet.sourceEvidence.retrievedAt).toBe('2026-09-05T23:55:26.000Z');
    expect(officialDatedPricingRecordsForAudit().map((record) => record.source.url)).toEqual([
      'https://platform.claude.com/docs/en/about-claude/pricing',
      'https://platform.claude.com/docs/en/about-claude/pricing',
      'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
      'https://ai.google.dev/gemini-api/docs/pricing',
    ]);
  });

  it('uses an inclusive lower bound and exclusive effective-before bound', () => {
    const source = records().find((record) => record.candidateId === 'google-router-generator')!;
    expect(buildDatedPricingCohort([source], new Date(source.effectiveFrom)).status).toBe('available');
    expect(buildDatedPricingCohort([source], new Date(source.effectiveBefore!))).toEqual({
      status: 'unavailable',
      reasons: [{ candidateId: 'google-router-generator', reason: 'pricing_outside_effective_interval' }],
    });
    expect(buildDatedPricingCohort([source], new Date('2026-08-12T23:59:59.999Z')).status).toBe('unavailable');
    expect(resolveCurrentEvaluationPricingCohort(AT, []).status).toBe('unavailable');
    expect(resolveCurrentEvaluationPricingCohort(AT, ['anthropic-router', 'anthropic-router']).status).toBe('unavailable');
  });

  it('evaluates only selected records, so an expired unrelated record cannot block a valid cohort', () => {
    const afterGoogleExpiry = new Date('2027-01-01T00:00:00.000Z');
    const anthropic = resolveCurrentEvaluationPricingCohort(afterGoogleExpiry, ['anthropic-router']);
    expect(anthropic.status).toBe('available');
    expect(resolveCurrentEvaluationPricingCohort(afterGoogleExpiry, ['google-router-generator'])).toEqual({
      status: 'unavailable',
      reasons: [{ candidateId: 'google-router-generator', reason: 'pricing_outside_effective_interval' }],
    });
  });

  it('fails closed for missing fields, unowned URLs, malformed intervals, duplicate records, and invalid rates', () => {
    const sample = records()[0]!;
    const invalids: unknown[][] = [
      [{ ...sample, source: { ...sample.source, url: 'https://example.test/pricing' } }],
      [{ ...sample, source: { ...sample.source, url: 'http://platform.claude.com/docs' } }],
      [{ ...sample, effectiveBefore: sample.effectiveFrom }],
      [{ ...sample, rates: { ...sample.rates, inputUsdPerMillionTokens: Number.NaN } }],
      [{ ...sample, rates: { ...sample.rates, outputUsdPerMillionTokens: -1 } }],
      [{ ...sample, rates: { ...sample.rates, cacheReadAccounting: 'unsupported' } }],
      [{ ...sample, source: { ...sample.source, currency: 'EUR' } }],
      [{ ...sample, model: '' }],
      [{ ...sample, provider: 'google' }],
      [sample, structuredClone(sample)],
    ];
    for (const invalid of invalids) {
      expect(buildDatedPricingCohort(invalid, AT).status).toBe('unavailable');
    }
    const missing = structuredClone(sample) as Record<string, unknown>;
    delete missing.source;
    expect(buildDatedPricingCohort([missing], AT).status).toBe('unavailable');
  });

  it('rejects accessors, foreign prototypes, and proxy inputs without invoking them', () => {
    const sample = records()[0]!;
    const accessor = Object.create(null);
    Object.assign(accessor, sample);
    Object.defineProperty(accessor, 'model', { enumerable: true, get: () => { throw new Error('getter invoked'); } });
    expect(buildDatedPricingCohort([accessor], AT).status).toBe('unavailable');
    expect(buildDatedPricingCohort([new (class RecordLike {})()], AT).status).toBe('unavailable');
    expect(buildDatedPricingCohort(new Proxy([sample], {}), AT).status).toBe('unavailable');
    expect(buildDatedPricingCohort([new Proxy(sample, {})], AT).status).toBe('unavailable');
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, '0', { enumerable: true, get: () => { throw new Error('array getter invoked'); } });
    getterArray.length = 1;
    expect(buildDatedPricingCohort(getterArray, AT).status).toBe('unavailable');
    expect(resolveCurrentEvaluationPricingCohort(AT, new Proxy(['anthropic-router'], {}))).toEqual({
      status: 'unavailable',
      reasons: [{ candidateId: 'anthropic-router', reason: 'pricing_record_invalid' }],
    });
  });

  it('uses only existing adapter alias rules for returned identities', () => {
    const profiles = datedPricingProfilesForFixedTrace();
    const anthropic = profiles.find((profile) => profile.candidateId === 'anthropic-router')!;
    const google = profiles.find((profile) => profile.candidateId === 'google-router-generator')!;
    const openai = profiles.find((profile) => profile.candidateId === 'openai-router-generator')!;
    expect(cohortReturnedModelMatches(anthropic, 'claude-haiku-4-5-20251001')).toBe(true);
    expect(cohortReturnedModelMatches(anthropic, 'claude-sonnet-5-20260801')).toBe(false);
    expect(cohortReturnedModelMatches(google, 'gemini-3.7-flash-20260801')).toBe(true);
    expect(cohortReturnedModelMatches(google, 'gemini-3.7-flash-20271231')).toBe(false);
    expect(cohortReturnedModelMatches(google, 'gemini-3.7-pro-20260801')).toBe(false);
    expect(cohortReturnedModelMatches(openai, 'gpt-5.6-luna-20260801')).toBe(false);
  });

  it('canonicalizes order, freezes snapshots, and domain-separates the digest', () => {
    const first = buildDatedPricingCohort(records(), AT);
    const reordered = buildDatedPricingCohort(records().reverse(), AT);
    expect(first.status).toBe('available');
    expect(reordered.status).toBe('available');
    if (first.status !== 'available' || reordered.status !== 'available') return;
    expect(first.cohort.digest).toBe(reordered.cohort.digest);
    expect(Object.isFrozen(first.cohort)).toBe(true);
    expect(Object.isFrozen(first.cohort.profiles)).toBe(true);
    expect(() => { (first.cohort.profiles[0] as { model: string }).model = 'forged'; }).toThrow();
    const unseparated = `sha256:${createHash('sha256').update(JSON.stringify(first.cohort.profiles)).digest('hex')}`;
    expect(first.cohort.digest).not.toBe(unseparated);
    const altered = records();
    altered[0]!.rates.inputUsdPerMillionTokens = 1.001;
    const changed = buildDatedPricingCohort(altered, AT);
    expect(changed.status).toBe('available');
    if (changed.status === 'available') expect(changed.cohort.digest).not.toBe(first.cohort.digest);
  });

  it('keeps fractional token rates in integer micros and rounds only the final total', () => {
    const profiles = datedPricingProfilesForFixedTrace();
    const google = profiles.find((profile) => profile.candidateId === 'google-router-generator')!;
    const sonnet = profiles.find((profile) => profile.candidateId === 'anthropic-generation')!;
    expect(datedPricingCostMicros(google, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 1 })).toBe(1);
    expect(datedPricingCostMicros(google, { inputTokens: 4, outputTokens: 0 })).toBe(3);
    expect(datedPricingCostMicros(sonnet, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 1 })).toBe(3);
    expect(() => datedPricingCostMicros(google, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1 })).toThrow('Cache-write');
    expect(() => datedPricingCostMicros(google, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 2 })).toThrow('Subset cache-read');
  });
});
