/**
 * Live synthetic router comparison. Output contains aggregate metrics and
 * categorical per-case evidence, never prompts or model response text. This
 * never reads production messages, retries a provider call, or changes routing.
 *
 * Example:
 * DOTENV_CONFIG_PATH=.env.local npx tsx --import dotenv/config \
 *   server/tests/manual/provider-router-eval.ts --soft-max-usd=1 --repetitions=1
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ModelConfig } from '../../src/config/models.js';
import type { ModelProvider } from '../../src/addie/model-providers/model-provider.js';
import { AnthropicRouterProvider } from '../../src/addie/model-providers/anthropic-router-provider.js';
import {
  OpenAIResponsesProvider,
  OPENAI_ROUTER_MODEL,
} from '../../src/addie/model-providers/openai-responses-provider.js';
import {
  GoogleGenerateContentProvider,
  GOOGLE_ROUTER_MODEL,
} from '../../src/addie/model-providers/google-generate-content-provider.js';
import {
  evaluateRouterCase,
  buildRouterEvalRequest,
  MODEL_ROUTER_CORPUS,
  summarizeRouterEval,
  RouterEvalBudget,
  runRouterEvalMatrix,
  SYNTHETIC_ROUTER_CORPUS,
  type RouterEvalResult,
} from '../../src/addie/testing/provider-router-eval.js';
import {
  pricingProfileForCandidate,
  cohortReturnedModelMatches,
  resolveCurrentEvaluationPricingCohort,
  type DatedPricingProfile,
  type EvaluationPricingCandidateId,
} from '../../src/addie/eval/dated-pricing-cohort.js';

type ProviderName = 'anthropic' | 'openai' | 'google';
type Profile = 'prompt_parity' | 'native_structured';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const providerNames = (argument('providers') ?? 'anthropic,openai,google').split(',') as ProviderName[];
const profiles = (argument('profiles') ?? 'prompt_parity,native_structured').split(',') as Profile[];
const repetitions = Number(argument('repetitions') ?? '3');
const softMaxUsd = Number(argument('soft-max-usd'));
const validateOnly = process.argv.includes('--validate-only');
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('--repetitions must be 1..10');
if (!Number.isFinite(softMaxUsd) || softMaxUsd <= 0) throw new Error('--soft-max-usd is required and must be positive');
if (providerNames.some((name) => !['anthropic', 'openai', 'google'].includes(name))) throw new Error('Unknown --providers value');
if (profiles.some((name) => !['prompt_parity', 'native_structured'].includes(name))) throw new Error('Unknown --profiles value');
if (new Set(providerNames).size !== providerNames.length) throw new Error('--providers must not contain duplicates');
if (new Set(profiles).size !== profiles.length) throw new Error('--profiles must not contain duplicates');

const cohortCandidateForProvider: Record<ProviderName, EvaluationPricingCandidateId> = {
  anthropic: 'anthropic-router',
  openai: 'openai-router-generator',
  google: 'google-router-generator',
};
const cohortResult = resolveCurrentEvaluationPricingCohort(
  new Date(),
  providerNames.map((provider) => cohortCandidateForProvider[provider]),
);
if (cohortResult.status !== 'available') {
  throw new Error(`Dated pricing cohort unavailable: ${cohortResult.reasons.map((entry) => `${entry.candidateId}:${entry.reason}`).join(', ')}`);
}
const RATES: Record<ProviderName, DatedPricingProfile> = {
  anthropic: providerNames.includes('anthropic')
    ? pricingProfileForCandidate(cohortResult.cohort, 'anthropic-router')
    : undefined as never,
  openai: providerNames.includes('openai')
    ? pricingProfileForCandidate(cohortResult.cohort, 'openai-router-generator')
    : undefined as never,
  google: providerNames.includes('google')
    ? pricingProfileForCandidate(cohortResult.cohort, 'google-router-generator')
    : undefined as never,
};
const requestedCells = providerNames.flatMap((provider) => profiles.map((profile) => ({ provider, profile })));
const excludedCells = requestedCells
  .filter((cell) => cell.provider === 'anthropic' && cell.profile === 'native_structured')
  .map((cell) => ({ ...cell, reason: 'anthropic_router_has_no_native_structured_profile' as const }));
const plannedCells = requestedCells.filter((cell) => !(cell.provider === 'anthropic' && cell.profile === 'native_structured'));
if (plannedCells.length === 0) throw new Error('Requested provider/profile matrix has no supported cells');

// This is intentionally before credential reads and provider construction.
// It validates the candidate cohort only; it cannot establish a provider
// request bundle or authorize a live comparison.
if (validateOnly) {
  console.log(JSON.stringify({
    diagnosticOnly: true,
    validated: {
      providers: providerNames,
      profiles,
      repetitions,
      softMaxUsd,
      pricingCohortDigest: cohortResult.cohort.digest,
      requestedCells,
      plannedCells,
      excludedCells,
    },
  }));
  process.exit(0);
}

const providers: Partial<Record<ProviderName, { provider: ModelProvider; model: string }>> = {};
if (providerNames.includes('anthropic')) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  if (ModelConfig.fast !== 'claude-haiku-4-5') throw new Error('Router eval pins Anthropic to claude-haiku-4-5');
  providers.anthropic = {
    provider: new AnthropicRouterProvider(process.env.ANTHROPIC_API_KEY, { maxRetries: 0 }),
    model: ModelConfig.fast,
  };
}
if (providerNames.includes('openai')) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  providers.openai = { provider: new OpenAIResponsesProvider(process.env.OPENAI_API_KEY), model: OPENAI_ROUTER_MODEL };
}
if (providerNames.includes('google')) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
  providers.google = { provider: new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY), model: GOOGLE_ROUTER_MODEL };
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const sourceFiles = [
  'package.json',
  'package-lock.json',
  'server/src/addie/router.ts',
  'server/src/addie/tool-sets.ts',
  'server/src/addie/testing/provider-router-eval.ts',
  'server/src/addie/model-providers/model-provider.ts',
  'server/src/addie/model-providers/capabilities.ts',
  'server/src/addie/model-providers/events.ts',
  'server/src/addie/model-providers/anthropic-router-provider.ts',
  'server/src/addie/model-providers/openai-responses-provider.ts',
  'server/src/addie/model-providers/google-generate-content-provider.ts',
  'server/src/addie/eval/dated-pricing-cohort.ts',
  'server/tests/manual/provider-router-eval.ts',
];
const sourceBundleSha256 = sha256(sourceFiles.map((file) => [file, readFileSync(file, 'utf8')]));
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workingTreeDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const projectedReservedCost = plannedCells.reduce((total, cell) => {
  const reservedOutput = cell.provider === 'google' ? 1_200 : 300;
  const selected = providers[cell.provider]!;
  const reasoningEffort = cell.provider === 'openai' ? 'none' as const : cell.provider === 'google' ? 'low' as const : undefined;
  const perRepetition = MODEL_ROUTER_CORPUS.reduce((usd, testCase) => {
    const request = buildRouterEvalRequest(selected.model, cell.profile, testCase, reasoningEffort);
    return usd + RouterEvalBudget.reservationUsd(
      selected.provider.prepare(request),
      reservedOutput,
      RATES[cell.provider],
    );
  }, 0);
  return total + repetitions * perRepetition;
}, 0);
if (projectedReservedCost > softMaxUsd) {
  throw new Error(`Projected reserved cost $${projectedReservedCost.toFixed(4)} exceeds --soft-max-usd=$${softMaxUsd.toFixed(4)}`);
}

const dispatchedInvocations: Array<Record<string, unknown>> = [];
const budget = new RouterEvalBudget(softMaxUsd);
const settledCosts = new WeakMap<RouterEvalResult, number>();
const matrixRun = await runRouterEvalMatrix({
  repetitions,
  cases: MODEL_ROUTER_CORPUS,
  cells: plannedCells,
  execute: async ({ repetition, testCase, cell }) => {
      const selected = providers[cell.provider]!;
      const rate = RATES[cell.provider];
      const reasoningEffort = cell.provider === 'openai'
        ? 'none' as const
        : cell.provider === 'google'
          ? 'low' as const
          : undefined;
      const evalRequest = buildRouterEvalRequest(selected.model, cell.profile, testCase, reasoningEffort);
      const reserveOutputTokens = cell.provider === 'google' ? 1_200 : 300;
      let reservation: ReturnType<RouterEvalBudget['reserve']> | null = null;
      const result = await evaluateRouterCase(
        selected.provider,
        selected.model,
        cell.profile,
        testCase,
        {
          reasoningEffort,
          timeoutMs: 120_000,
          beforeDispatch: (actualPrepared) => {
            if (actualPrepared.provider !== rate.provider || actualPrepared.model !== rate.model) {
              throw new Error(`Dated pricing prepared invocation drift: expected ${rate.provider}/${rate.model}, received ${actualPrepared.provider}/${actualPrepared.model}`);
            }
            reservation = budget.reserve(actualPrepared, reserveOutputTokens, rate);
            try {
              dispatchedInvocations.push({
                repetition,
                caseId: testCase.id,
                provider: cell.provider,
                profile: cell.profile,
                pricingProfileId: rate.profileId,
                pricingCohortDigest: cohortResult.cohort.digest,
                reasoningEffort: reasoningEffort ?? 'provider_default',
                providerRequest: actualPrepared.providerRequest,
              });
              budget.markDispatched(reservation);
            } catch (error) {
              budget.cancel(reservation);
              reservation = null;
              throw error;
            }
          },
        },
      );
      if (!reservation) return result;
      if (!result.usage) {
        budget.markExposureUnknown(reservation);
        return result;
      }
      if (!result.returnedModel || !cohortReturnedModelMatches(rate, result.returnedModel)) {
        budget.markExposureUnknown(reservation);
        throw new Error(`Dated pricing returned-model drift: expected ${rate.provider}/${rate.model}, received ${result.returnedModel ?? 'missing'}`);
      }
      try {
        settledCosts.set(result, budget.complete(reservation, result.usage, rate));
      } catch (error) {
        budget.markExposureUnknown(reservation);
        throw error;
      }
      return result;
  },
});
const results = matrixRun.results;
const budgetSnapshot = budget.snapshot();
const budgetExposureUnknown = budgetSnapshot.exposureUnknown;
const runAbortedAfter = matrixRun.abortedAfter && {
  repetition: matrixRun.abortedAfter.repetition,
  caseId: matrixRun.abortedAfter.testCase.id,
  provider: matrixRun.abortedAfter.cell.provider,
  profile: matrixRun.abortedAfter.cell.profile,
};

const report = plannedCells.map((cell) => {
  const cellResults = results.filter((result) => result.provider === cell.provider && result.profile === cell.profile);
  const summary = summarizeRouterEval(cellResults, repetitions * MODEL_ROUTER_CORPUS.length);
  const rate = RATES[cell.provider];
  const actualCostUsd = cellResults.reduce((total, result) => total + (settledCosts.get(result) ?? 0), 0);
  return {
    provider: cell.provider,
    requestedModel: providers[cell.provider]!.model,
    returnedModels: [...new Set(cellResults.map((result) => result.returnedModel).filter(Boolean))],
    profile: cell.profile,
    reasoningEffort: cell.provider === 'openai' ? 'none' : cell.provider === 'google' ? 'low' : 'provider_default',
    pricingSource: rate.sourceEvidence.url,
    pricingCheckedAt: rate.sourceEvidence.retrievedAt,
    pricingCohortDigest: cohortResult.cohort.digest,
    pricingProfileId: rate.profileId,
    cacheAccounting: {
      cacheRead: rate.cacheReadAccounting,
      cacheWrite: rate.cacheWriteAccounting,
    },
    ...summary,
    actualCostUsd,
    cases: cellResults.map((result) => ({
      caseId: result.caseId,
      status: result.status,
      returnedModel: result.returnedModel,
      scores: result.scores,
      latencyMs: result.latencyMs,
      usage: result.usage,
      actualCostUsd: settledCosts.get(result) ?? 0,
    })),
  };
});
const reportedSpendUsd = report.reduce((total, cell) => total + cell.actualCostUsd, 0);
if (Math.abs(reportedSpendUsd - budgetSnapshot.accountedSpendUsd) > Number.EPSILON * Math.max(1, reportedSpendUsd, budgetSnapshot.accountedSpendUsd)) {
  throw new Error('Router evaluation pricing evidence does not reconcile with its reservation ledger');
}

const exactInvocationBundle = plannedCells.flatMap((cell) => {
  const selected = providers[cell.provider]!;
  const reasoningEffort = cell.provider === 'openai' ? 'none' as const : cell.provider === 'google' ? 'low' as const : undefined;
  const rate = RATES[cell.provider];
  return MODEL_ROUTER_CORPUS.map((testCase) => ({
    provider: cell.provider,
    profile: cell.profile,
    pricingProfileId: rate.profileId,
    pricingCohortDigest: cohortResult.cohort.digest,
    caseId: testCase.id,
    request: selected.provider.prepare(
      buildRouterEvalRequest(selected.model, cell.profile, testCase, reasoningEffort),
    ).providerRequest,
  }));
});

console.log(JSON.stringify({
  corpus: 'synthetic_router_v1',
  corpusSize: MODEL_ROUTER_CORPUS.length,
  corpusSha256: sha256(MODEL_ROUTER_CORPUS),
  quickMatchExclusions: SYNTHETIC_ROUTER_CORPUS.filter((testCase) => testCase.modelEligible === false).map((testCase) => testCase.id),
  invocationBundleSha256: sha256(exactInvocationBundle),
  orderedDispatchBundleSha256: sha256(dispatchedInvocations),
  sourceBundleSha256,
  gitCommit,
  workingTreeDirty,
  repetitions,
  requestedCells,
  excludedCells,
  matrix: {
    requested: matrixRun.requested,
    observed: matrixRun.observed,
    omitted: matrixRun.omitted,
    complete: matrixRun.complete,
    comparisonEligible: matrixRun.comparisonEligible,
  },
  softMaxUsd,
  projectedReservedCostUsd: projectedReservedCost,
  budgetPolicy: 'soft_admission_target',
  budgetNote: 'The target gates dispatch using a per-call reserve; it is not a hard spend cap. Remote work may continue after a client timeout. The run halts after any dispatched call whose provider omits usage.',
  budgetExposureUnknown,
  runAbortedAfter,
  budget: budgetSnapshot,
  accountedSpendUsd: budgetSnapshot.accountedSpendUsd,
  report,
}, null, 2));
