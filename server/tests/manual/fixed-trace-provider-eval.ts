/**
 * Live synthetic fixed-trace replay across normalized providers.
 *
 * Production handlers and production messages are never loaded into the
 * executor: every tool result comes from the immutable fixed-trace fixtures.
 * The required shared soft budget admits each exact prepared request before
 * dispatch and halts after unknown spend exposure.
 *
 * Example:
 * DOTENV_CONFIG_PATH=.env.local npm run eval:addie-fixed-traces -- \
 *   --soft-max-usd=1 --output=.context/evals/fixed-traces.json
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ModelConfig } from '../../src/config/models.js';
import { CODE_VERSION, computeRouterRulesHash } from '../../src/addie/config-version.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  type FixedTraceBudgetPricing,
} from '../../src/addie/eval/fixed-trace-budget.js';
import {
  fixedTraceToolSchemaSha256,
  runFixedTraceCase,
  type FixedTraceProviderStageConfig,
  type FixedTraceRunnerConfig,
} from '../../src/addie/eval/fixed-trace-runner.js';
import {
  FIXED_TRACE_SUITE,
  FIXED_TRACE_SUITE_VERSION,
  fixedTraceSuiteSha256,
  summarizeFixedTraceRun,
} from '../../src/addie/eval/fixed-trace-suite.js';
import {
  FIXED_TRACE_JUDGE_PROMPT_VERSION,
  FIXED_TRACE_MIN_INDEPENDENT_JUDGES,
  runIndependentFixedTraceJudges,
  summarizeFixedTraceJudges,
  type FixedTraceJudgeConfig,
} from '../../src/addie/eval/fixed-trace-judge.js';
import {
  FIXED_TRACE_ROLLOUT_POLICY_VERSION,
  FIXED_TRACE_ROLLOUT_THRESHOLDS,
  evaluateFixedTraceRollout,
} from '../../src/addie/eval/fixed-trace-rollout.js';
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
import { ADMIN_TOOLS } from '../../src/addie/mcp/admin-tools.js';
import { BILLING_TOOLS } from '../../src/addie/mcp/billing-tools.js';
import { KNOWLEDGE_TOOLS } from '../../src/addie/mcp/knowledge-search.js';
import { MEETING_TOOLS } from '../../src/addie/mcp/meeting-tools.js';
import { MEMBER_TOOLS } from '../../src/addie/mcp/member-tools.js';
import type { AddieTool } from '../../src/addie/types.js';

type ProviderName = ModelProviderId;

interface ProviderPlan {
  name: ProviderName;
  router: Omit<FixedTraceProviderStageConfig, 'provider'> & { provider: ModelProvider };
  generation: Omit<FixedTraceProviderStageConfig, 'provider'> & { provider: ModelProvider };
  judge: FixedTraceJudgeConfig;
}

const MEETING_FULL_ADMINISTRATION_FIXTURE_NAMES = [
  'schedule_meeting',
  'list_upcoming_meetings',
  'get_my_meetings',
  'get_meeting_details',
  'rsvp_to_meeting',
  'cancel_meeting',
  'cancel_meeting_series',
  'update_meeting',
  'add_meeting_attendee',
  'update_topic_subscriptions',
  'manage_committee_topics',
] as const;

const TOOL_NAMES = new Set([
  'search_docs',
  'get_doc',
  'get_my_profile',
  'find_duplicate_orgs',
  'send_invoice',
  'confirm_send_invoice',
  ...MEETING_FULL_ADMINISTRATION_FIXTURE_NAMES,
]);

// The confirmed long meeting trace needs four sequential requested tools and
// one final response. It is deliberately narrower than the synthetic loop's
// 11-tool-union ceiling, which protects the evaluator from runaway replay.
const MEETING_FULL_REQUEST_GENERATION_TURNS = 5;

const PRICING = {
  anthropicRouter: {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    source: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
  },
  anthropicGeneration: {
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    source: 'Repository Anthropic pricing table: Claude Sonnet 5 standard, refreshed August 2026.',
  },
  openai: {
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    source: 'OpenAI gpt-5.6-luna standard, checked 2026-08-25.',
  },
  google: {
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 3.75,
    source: 'Google Gemini 3.7 Flash introductory standard, checked 2026-08-25.',
  },
} satisfies Record<string, FixedTraceBudgetPricing>;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
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
    'server/src/addie/eval/fixed-trace-judge.ts',
    'server/src/addie/eval/fixed-trace-runner.ts',
    'server/src/addie/eval/fixed-trace-rollout.ts',
    'server/tests/manual/fixed-trace-provider-eval.ts',
  ])].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8').update('\0').update(readFileSync(file)).update('\0');
  }
  return { sha256: hash.digest('hex'), files };
}

function canonicalToolDefinitions(): AddieTool[] {
  const definitions = [
    ...KNOWLEDGE_TOOLS,
    ...MEMBER_TOOLS,
    ...ADMIN_TOOLS,
    ...BILLING_TOOLS,
    ...MEETING_TOOLS,
  ].filter((tool) => TOOL_NAMES.has(tool.name));
  const byName = new Map<string, AddieTool>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) throw new Error(`Duplicate fixed-trace tool: ${definition.name}`);
    byName.set(definition.name, definition);
  }
  const missing = [...TOOL_NAMES].filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`Missing fixed-trace tools: ${missing.join(', ')}`);
  return [...TOOL_NAMES].map((name) => byName.get(name)!);
}

function stage(
  provider: ModelProvider,
  model: string,
  reasoningEffort: ModelReasoningEffort,
  maxOutputTokens: number,
  maxIterations: number,
  pricing: FixedTraceBudgetPricing,
): FixedTraceProviderStageConfig {
  return {
    provider,
    model,
    reasoningEffort,
    maxOutputTokens,
    timeoutMs: 120_000,
    maxIterations,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    pricing,
  };
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
    const budgetedGeneration = new BudgetedFixedTraceProvider(
      generation,
      budget,
      PRICING.anthropicGeneration,
    );
    plans.push({
      name: 'anthropic',
      router: stage(
        new BudgetedFixedTraceProvider(router, budget, PRICING.anthropicRouter),
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
        MEETING_FULL_REQUEST_GENERATION_TURNS,
        PRICING.anthropicGeneration,
      ),
      judge: {
        provider: budgetedGeneration,
        model: ModelConfig.primary,
        reasoningEffort: 'provider_default',
        maxOutputTokens: 900,
        timeoutMs: 60_000,
        pricing: PRICING.anthropicGeneration,
      },
    });
  }
  if (names.includes('openai')) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
    const provider = new OpenAIResponsesProvider(process.env.OPENAI_API_KEY);
    const budgetedProvider = new BudgetedFixedTraceProvider(provider, budget, PRICING.openai);
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
        MEETING_FULL_REQUEST_GENERATION_TURNS,
        PRICING.openai,
      ),
      judge: {
        provider: budgetedProvider,
        model: OPENAI_ROUTER_MODEL,
        reasoningEffort: 'none',
        maxOutputTokens: 300,
        timeoutMs: 60_000,
        pricing: PRICING.openai,
      },
    });
  }
  if (names.includes('google')) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
    const provider = new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY);
    const budgetedProvider = new BudgetedFixedTraceProvider(provider, budget, PRICING.google);
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
        MEETING_FULL_REQUEST_GENERATION_TURNS,
        PRICING.google,
      ),
      judge: {
        provider: budgetedProvider,
        model: GOOGLE_ROUTER_MODEL,
        reasoningEffort: 'low',
        maxOutputTokens: 600,
        timeoutMs: 60_000,
        pricing: PRICING.google,
      },
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
const judgeProviderNames = (argument('judge-providers') ?? 'anthropic,openai,google').split(',') as ProviderName[];
if (judgeProviderNames.some((name) => !['anthropic', 'openai', 'google'].includes(name))) {
  throw new Error('Unknown --judge-providers value');
}
if (new Set(judgeProviderNames).size !== judgeProviderNames.length) {
  throw new Error('--judge-providers must contain unique providers');
}
for (const candidate of providerNames) {
  if (judgeProviderNames.filter((judge) => judge !== candidate).length < FIXED_TRACE_MIN_INDEPENDENT_JUDGES) {
    throw new Error(`Candidate ${candidate} requires at least two non-candidate --judge-providers`);
  }
}
const softMaxUsd = Number(argument('soft-max-usd'));
if (!Number.isFinite(softMaxUsd) || softMaxUsd <= 0) {
  throw new Error('--soft-max-usd is required and must be positive');
}
const outputArgument = argument('output');
if (!outputArgument?.trim()) throw new Error('--output is required');
const outputPath = resolve(outputArgument);

const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const gitDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const sources = sourceBundle();
const promptConfigVersion = sha256(JSON.stringify({
  codeVersion: CODE_VERSION,
  routerRulesHash: computeRouterRulesHash(),
  rules: loadRules(),
  responseStyle: loadResponseStyle(),
}));
const toolDefinitions = canonicalToolDefinitions();
const toolSchemaSha256 = fixedTraceToolSchemaSha256(toolDefinitions);
const budget = new FixedTraceBudget(softMaxUsd);
const allProviderNames = [...new Set([...providerNames, ...judgeProviderNames])];
const allPlans = providerPlans(allProviderNames, budget);
const plans = providerNames.map((name) => allPlans.find((plan) => plan.name === name)!);
const runStartedAt = new Date().toISOString();
const runRootId = `fixed-trace-${runStartedAt}-${randomUUID()}`;
const candidateRuns = [];

for (const plan of plans) {
  const baseConfig: FixedTraceRunnerConfig = {
    runId: `${runRootId}-${plan.name}`,
    sourceBundleSha256: sources.sha256,
    gitCommit,
    gitDirty,
    promptConfigVersion,
    toolDefinitions,
    router: plan.router,
    generation: plan.generation,
  };
  const observations = [];
  for (const trace of FIXED_TRACE_SUITE) {
    const traceConfig = trace.category === 'truncation'
      ? {
          ...baseConfig,
          generation: { ...baseConfig.generation, maxOutputTokens: 32 },
        }
      : baseConfig;
    observations.push(await runFixedTraceCase(trace, traceConfig, toolSchemaSha256));
  }
  const evaluated = summarizeFixedTraceRun(observations);
  candidateRuns.push({
    provider: plan.name,
    requestedConfig: {
      router: {
        provider: plan.router.provider.id,
        model: plan.router.model,
        reasoningEffort: plan.router.reasoningEffort,
        maxOutputTokens: plan.router.maxOutputTokens,
        timeoutMs: plan.router.timeoutMs,
        maxIterations: plan.router.maxIterations,
        pricing: plan.router.pricing,
      },
      generation: {
        provider: plan.generation.provider.id,
        model: plan.generation.model,
        reasoningEffort: plan.generation.reasoningEffort,
        maxOutputTokens: plan.generation.maxOutputTokens,
        truncationMaxOutputTokens: 32,
        timeoutMs: plan.generation.timeoutMs,
        maxIterations: plan.generation.maxIterations,
        pricing: plan.generation.pricing,
      },
    },
    ...evaluated,
    observations,
  });
}

const judgedRuns = [];
for (const run of candidateRuns) {
  const judgeConfigs = judgeProviderNames
    .filter((name) => name !== run.provider)
    .map((name) => allPlans.find((plan) => plan.name === name)!.judge);
  const judgments = await runIndependentFixedTraceJudges(
    FIXED_TRACE_SUITE,
    run.observations,
    judgeConfigs,
  );
  const judgeSummary = summarizeFixedTraceJudges(
    FIXED_TRACE_SUITE,
    run.observations,
    judgments,
  );
  judgedRuns.push({
    ...run,
    requestedConfig: {
      ...run.requestedConfig,
      judges: judgeConfigs.map((judge) => ({
        provider: judge.provider.id,
        model: judge.model,
        reasoningEffort: judge.reasoningEffort,
        maxOutputTokens: judge.maxOutputTokens,
        timeoutMs: judge.timeoutMs,
        maxIterations: 1,
        transportRetries: 0,
        samplingMode: 'provider_no_sampling_control',
        temperature: null,
        pricing: judge.pricing,
      })),
    },
    judgeSummary,
    judgments,
  });
}

const budgetState = budget.snapshot();
const runs = judgedRuns.map((run) => ({
  ...run,
  rollout: evaluateFixedTraceRollout(run.summary, run.judgeSummary, budgetState),
}));
const artifact = {
  artifactVersion: 'fixed_trace_provider_eval_v3',
  runRootId,
  runStartedAt,
  runCompletedAt: new Date().toISOString(),
  traceSuiteVersion: FIXED_TRACE_SUITE_VERSION,
  traceSuiteSha256: fixedTraceSuiteSha256(),
  traceCount: FIXED_TRACE_SUITE.length,
  sourceBundleSha256: sources.sha256,
  sourceBundleFiles: sources.files,
  gitCommit,
  gitDirty,
  addieCodeVersion: CODE_VERSION,
  promptConfigVersion,
  toolSchemaSha256,
  requestedProviders: providerNames,
  requestedJudgeProviders: judgeProviderNames,
  judgePromptVersion: FIXED_TRACE_JUDGE_PROMPT_VERSION,
  rolloutPolicyVersion: FIXED_TRACE_ROLLOUT_POLICY_VERSION,
  rolloutThresholds: FIXED_TRACE_ROLLOUT_THRESHOLDS,
  budget: budgetState,
  budgetNote: 'Soft admission target: exact prepared-request bytes and the full output allowance are reserved before each dispatch. Remote work may continue after a client timeout; any dispatched call without terminal usage marks exposure unknown and blocks every later dispatch.',
  complete: runs.every((run) => run.summary.complete && run.judgeSummary.complete),
  comparisonEligible: runs.every((run) => run.summary.comparisonEligible && run.judgeSummary.comparisonEligible)
    && !budgetState.exposureUnknown
    && !budgetState.admissionClosed,
  rolloutPass: runs.every((run) => run.rollout.pass),
  runs,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  outputPath,
  runRootId,
  providers: providerNames,
  judgeProviders: judgeProviderNames,
  comparisonEligible: artifact.comparisonEligible,
  rolloutPass: artifact.rolloutPass,
  budget: budgetState,
}, null, 2));
