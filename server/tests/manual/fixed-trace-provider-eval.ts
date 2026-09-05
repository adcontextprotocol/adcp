/**
 * Live synthetic fixed-trace replay across normalized providers.
 *
 * Production handlers and production messages are never loaded into the
 * executor: every tool result comes from the immutable fixed-trace fixtures.
 * The required shared soft budget admits each exact prepared request before
 * dispatch and halts after unknown spend exposure.
 *
 * `--architecture-arm=direct_generation` is intentionally admission-only.
 * Production builds an authorization-aware definition/handler intersection
 * before intent narrowing, but this harness neither captures that intersection
 * nor bounds it independently; fixture-local schemas must not stand in for it.
 * `oracle_route_diagnostic` may execute generation with fixture routing.
 * The hybrid-only `--suite=hybrid-evaluator` binds the separately reviewed
 * local-admission corpus without altering the legacy 32 traces. Every arm is
 * diagnostic-only in this foundation: independent judging,
 * comparison, and rollout are blocked until an evaluator-owned run-context
 * and raw-ledger coordinator can authenticate serialized artifacts.
 *
 * Example:
 * DOTENV_CONFIG_PATH=.env.local npm run eval:addie-fixed-traces -- \
 *   --soft-max-usd=1 --output=.context/evals/fixed-traces.json
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelConfig } from '../../src/config/models.js';
import { CODE_VERSION, computeRouterRulesHash } from '../../src/addie/config-version.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  fixedTraceResponsePricingPolicy,
} from '../../src/addie/eval/fixed-trace-budget.js';
import {
  type FixedTraceProviderStageConfig,
} from '../../src/addie/eval/fixed-trace-runner.js';
import {
  runFixedTraceDiagnosticArtifact,
  type FixedTraceDiagnosticProviderPlan,
} from '../../src/addie/eval/fixed-trace-diagnostic-run.js';
import { MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS } from '../../src/addie/eval/fixed-trace-tool-loop.js';
import { parseFixedTraceDiagnosticCliArguments } from '../../src/addie/eval/fixed-trace-diagnostic-cli.js';
import { reserveFixedTraceDiagnosticOutput } from '../../src/addie/eval/fixed-trace-diagnostic-output.js';
import { fixedTraceCommonToolDefinitions } from '../../src/addie/eval/fixed-trace-architecture.js';
import { canonicalFixedTraceToolDefinitions } from '../../src/addie/eval/fixed-trace-tools.js';
import {
  fixedTraceHybridPolicy,
  type FixedTraceArchitectureArmId,
} from '../../src/addie/eval/fixed-trace-architecture.js';
import {
  FIXED_TRACE_SUITE,
  FIXED_TRACE_HYBRID_EVALUATOR_SUITE,
  fixedTraceSuiteSha256,
  type FixedTracePricing,
} from '../../src/addie/eval/fixed-trace-suite.js';
import { AnthropicRouterProvider } from '../../src/addie/model-providers/anthropic-router-provider.js';
import { AnthropicModelProvider } from '../../src/addie/model-providers/anthropic-provider.js';
import type {
  ModelProvider,
  ModelProviderId,
  ModelReasoningEffort,
} from '../../src/addie/model-providers/model-provider.js';
import {
  OpenAIResponsesProvider,
  OPENAI_ROUTER_MODEL,
} from '../../src/addie/model-providers/openai-responses-provider.js';
import {
  GoogleGenerateContentProvider,
  GOOGLE_ROUTER_MODEL,
} from '../../src/addie/model-providers/google-generate-content-provider.js';
import { loadResponseStyle, loadRules } from '../../src/addie/rules/index.js';

type ProviderName = ModelProviderId;

type ProviderPlan = FixedTraceDiagnosticProviderPlan & { name: ProviderName };

const PRICING = {
  anthropicRouter: {
    profileId: 'anthropic-standard-2026-08:claude-haiku-4-5',
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    cacheReadUsdPerMillionTokens: 0.1,
    cacheWriteUsdPerMillionTokens: 1.25,
    cacheReadAccounting: 'additive',
    cacheWriteAccounting: 'additive',
    source: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
  },
  anthropicGeneration: {
    profileId: 'anthropic-standard-2026-08:claude-sonnet-5',
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cacheReadUsdPerMillionTokens: 0.3,
    cacheWriteUsdPerMillionTokens: 3.75,
    cacheReadAccounting: 'additive',
    cacheWriteAccounting: 'additive',
    source: 'Repository Anthropic pricing table: Claude Sonnet 5 standard, refreshed August 2026.',
  },
  openai: {
    profileId: 'openai-gpt-5.6-luna-standard-2026-08-25',
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    cacheReadUsdPerMillionTokens: 0.02,
    cacheWriteUsdPerMillionTokens: null,
    cacheReadAccounting: 'subset',
    cacheWriteAccounting: 'unsupported',
    source: 'OpenAI gpt-5.6-luna standard, checked 2026-08-25.',
  },
  google: {
    profileId: 'google-gemini-3.7-flash-through-2026-12-31',
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 3.75,
    cacheReadUsdPerMillionTokens: 0.075,
    cacheWriteUsdPerMillionTokens: 0.75,
    cacheReadAccounting: 'subset',
    cacheWriteAccounting: 'additive',
    source: 'Google Gemini 3.7 Flash introductory standard, checked 2026-08-25.',
  },
} satisfies Record<string, FixedTracePricing>;

const cliArguments = parseFixedTraceDiagnosticCliArguments(process.argv.slice(2));

function argument(name: string): string | undefined {
  return cliArguments[{ providers: 'providers', 'architecture-arm': 'architectureArm', suite: 'suite', 'soft-max-usd': 'softMaxUsd', output: 'output' }[name] as keyof typeof cliArguments] as string | undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceBundle(): { sha256: string; files: string[] } {
  const trackedFiles = execFileSync('git', [
    'ls-files', '-z', 'package.json', 'package-lock.json', 'server/src/addie',
    'server/src/config/models.ts', 'server/tests/manual/fixed-trace-provider-eval.ts',
  ], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const files = [...new Set([
    ...trackedFiles,
    'server/src/addie/eval/fixed-trace-budget.ts',
    'server/src/addie/eval/fixed-trace-architecture.ts',
    'server/src/addie/eval/fixed-trace-runner.ts',
    'server/tests/manual/fixed-trace-provider-eval.ts',
  ])].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8').update('\0').update(readFileSync(file)).update('\0');
  }
  return { sha256: hash.digest('hex'), files };
}

function stage(
  provider: ModelProvider,
  model: string,
  reasoningEffort: ModelReasoningEffort,
  maxOutputTokens: number,
  maxIterations: number,
  pricing: FixedTracePricing,
): FixedTraceProviderStageConfig {
  return {
    provider,
    model,
    reasoningEffort,
    maxOutputTokens,
    timeoutMs: 120_000,
    maxIterations,
    transportRetries: 0,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    pricing,
  };
}

function budgetedStageProvider(
  provider: ModelProvider,
  budget: FixedTraceBudget,
  model: string,
  pricing: FixedTracePricing,
): BudgetedFixedTraceProvider {
  return new BudgetedFixedTraceProvider(
    provider,
    budget,
    pricing,
    fixedTraceResponsePricingPolicy(provider.id, model, pricing),
  );
}

function providerPlans(
  names: readonly ProviderName[],
  budget: FixedTraceBudget,
): ProviderPlan[] {
  const plans: ProviderPlan[] = [];
  if (names.includes('anthropic')) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
    if (ModelConfig.fast !== 'claude-haiku-4-5') throw new Error('Fixed traces pin Anthropic routing to claude-haiku-4-5');
    if (ModelConfig.primary !== 'claude-sonnet-5') throw new Error('Fixed traces pin Anthropic generation to claude-sonnet-5');
    const router = new AnthropicRouterProvider(process.env.ANTHROPIC_API_KEY, { maxRetries: 0 });
    const generation = new AnthropicModelProvider(
      process.env.ANTHROPIC_API_KEY,
      undefined,
      { transportMaxRetries: 0 },
    );
    const budgetedGeneration = budgetedStageProvider(generation, budget, ModelConfig.primary, PRICING.anthropicGeneration);
    plans.push({
      name: 'anthropic',
      router: stage(
        budgetedStageProvider(router, budget, ModelConfig.fast, PRICING.anthropicRouter),
        ModelConfig.fast,
        'provider_default',
        300,
        1,
        PRICING.anthropicRouter,
      ),
      generation: stage(
        budgetedGeneration,
        ModelConfig.primary,
        'provider_default',
        900,
        MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS,
        PRICING.anthropicGeneration,
      ),
    });
  }
  if (names.includes('openai')) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
    const provider = new OpenAIResponsesProvider(process.env.OPENAI_API_KEY);
    const budgetedProvider = budgetedStageProvider(provider, budget, OPENAI_ROUTER_MODEL, PRICING.openai);
    plans.push({
      name: 'openai',
      router: stage(
        budgetedProvider,
        OPENAI_ROUTER_MODEL,
        'none',
        300,
        1,
        PRICING.openai,
      ),
      generation: stage(
        budgetedProvider,
        OPENAI_ROUTER_MODEL,
        'none',
        900,
        MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS,
        PRICING.openai,
      ),
    });
  }
  if (names.includes('google')) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
    const provider = new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY);
    const budgetedProvider = budgetedStageProvider(provider, budget, GOOGLE_ROUTER_MODEL, PRICING.google);
    plans.push({
      name: 'google',
      router: stage(
        budgetedProvider,
        GOOGLE_ROUTER_MODEL,
        'low',
        1_200,
        1,
        PRICING.google,
      ),
      generation: stage(
        budgetedProvider,
        GOOGLE_ROUTER_MODEL,
        'low',
        1_200,
        MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS,
        PRICING.google,
      ),
    });
  }
  return plans;
}

const providerNames = (argument('providers') ?? 'anthropic,openai,google').split(',') as ProviderName[];
if (providerNames.some((name) => !['anthropic', 'openai', 'google'].includes(name))) {
  throw new Error('Unknown --providers value');
}
if (new Set(providerNames).size !== providerNames.length || providerNames.length === 0) {
  throw new Error('--providers must contain one or more unique providers');
}
const architectureArm = (argument('architecture-arm') ?? 'two_stage_llm_router') as FixedTraceArchitectureArmId;
if (!(architectureArm in { two_stage_llm_router: true, direct_generation: true, deterministic_policy_llm_fallback_hybrid: true, oracle_route_diagnostic: true })) {
  throw new Error('Unknown --architecture-arm value');
}
const suiteName = argument('suite') ?? 'canonical';
if (suiteName !== 'canonical' && suiteName !== 'hybrid-evaluator') throw new Error('Unknown --suite value');
if (suiteName === 'hybrid-evaluator' && architectureArm !== 'deterministic_policy_llm_fallback_hybrid') {
  throw new Error('--suite=hybrid-evaluator requires --architecture-arm=deterministic_policy_llm_fallback_hybrid');
}
const traceSuite = suiteName === 'hybrid-evaluator'
  ? FIXED_TRACE_HYBRID_EVALUATOR_SUITE
  : FIXED_TRACE_SUITE;
const softMaxUsd = Number(argument('soft-max-usd'));
if (!Number.isFinite(softMaxUsd) || softMaxUsd <= 0) {
  throw new Error('--soft-max-usd is required and must be positive');
}
const outputArgument = argument('output');
if (!outputArgument?.trim()) throw new Error('--output is required');
const outputPath = resolve(outputArgument);
if (cliArguments.validateOnly) {
  console.log(JSON.stringify({
    diagnosticOnly: true,
    judgeDispatch: 'blocked_pending_trusted_evaluator_owned_coordinator',
    validated: {
      providers: providerNames,
      architectureArm,
      suite: suiteName,
      softMaxUsd,
      outputPath,
    },
  }));
  process.exit(0);
}
// This exclusive create happens before source inspection, credentials,
// provider construction, or dispatch. Never unlink it: an empty file is the
// truthful crash/incomplete marker if later setup fails.
const outputReservation = reserveFixedTraceDiagnosticOutput(outputPath);

const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const gitDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const sources = sourceBundle();
const promptConfigVersion = sha256(JSON.stringify({
  codeVersion: CODE_VERSION,
  routerRulesHash: computeRouterRulesHash(),
  rules: loadRules(),
  responseStyle: loadResponseStyle(),
}));
const toolDefinitions = architectureArm === 'oracle_route_diagnostic'
  ? canonicalFixedTraceToolDefinitions(traceSuite)
  : fixedTraceCommonToolDefinitions(architectureArm);
const budget = new FixedTraceBudget(softMaxUsd);
const plans = providerPlans(providerNames, budget);
const runStartedAt = new Date().toISOString();
const runRootId = `fixed-trace-${runStartedAt}-${randomUUID()}`;
const artifact = await runFixedTraceDiagnosticArtifact({
  plans,
  baseConfig: {
    sourceBundleSha256: sources.sha256,
    gitCommit,
    gitDirty,
    promptConfigVersion,
    traceSuite,
    traceSuiteSha256: fixedTraceSuiteSha256(traceSuite),
    toolDefinitions,
    toolDefinitionProvenance: architectureArm === 'oracle_route_diagnostic'
      ? 'fixture_local'
      : 'evaluator_owned_common_tool_universe',
    architectureArm,
    ...(architectureArm === 'deterministic_policy_llm_fallback_hybrid'
      ? { hybridPolicy: fixedTraceHybridPolicy() }
      : {}),
  },
  budget,
  outputReservation,
  runRootId,
  runStartedAt,
  sourceBundleFiles: sources.files,
  budgetNote: 'Soft admission target: exact prepared-request bytes and the full output allowance are reserved before each dispatch. Remote work may continue after a client timeout; any dispatched call without terminal usage marks exposure unknown and blocks every later dispatch.',
});
console.log(JSON.stringify({
  outputPath,
  runRootId,
  providers: providerNames,
  suite: suiteName,
  comparisonEligible: artifact.comparisonEligible,
  rolloutPass: artifact.rolloutPass,
  budget: artifact.budget,
}, null, 2));
