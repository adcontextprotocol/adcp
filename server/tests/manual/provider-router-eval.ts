/**
 * Live synthetic router comparison. Output contains aggregate metrics and
 * categorical per-case evidence, never prompts or model response text. This
 * never reads production messages, retries a provider call, or changes routing.
 *
 * Example:
 * DOTENV_CONFIG_PATH=.env.local npx tsx --import dotenv/config \
 *   server/tests/manual/provider-router-eval.ts --soft-max-usd=1 --repetitions=1
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ModelConfig } from '../../src/config/models.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../src/addie/model-providers/model-provider.js';
import { UnexpectedModelIdentityError } from '../../src/addie/model-providers/model-provider.js';
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
  shouldDispatchWithinSoftBudget,
  accountRouterCallCostUsd,
  runRouterEvalMatrix,
  SYNTHETIC_ROUTER_CORPUS,
  type RouterEvalResult,
} from '../../src/addie/testing/provider-router-eval.js';

type ProviderName = 'anthropic' | 'openai' | 'google';
type Profile = 'prompt_parity' | 'native_structured';

const RATES: Record<ProviderName, { input: number; output: number; source: string }> = {
  anthropic: { input: 1, output: 5, source: 'Anthropic Haiku 4.5 standard, checked 2026-08-25' },
  openai: { input: 0.2, output: 1.2, source: 'OpenAI gpt-5.6-luna standard, checked 2026-08-25' },
  google: { input: 0.75, output: 3.75, source: 'Google Gemini 3.7 Flash introductory standard, checked 2026-08-25' },
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

class ProductionRouterAnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = Object.freeze({
    streaming: false,
    structuredOutput: false,
    reasoning: false,
    reasoningEfforts: Object.freeze(['provider_default'] as const),
    customTools: false,
    providerWebSearch: false,
    imageInput: false,
    documentInput: false,
  });
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  prepare(request: ModelRequest): PreparedModelInvocation {
    if (request.outputSchema) throw new Error('Production Anthropic router has no structured-output profile');
    if (request.messages.length !== 1 || request.messages[0].content.length !== 1 || request.messages[0].content[0].type !== 'text') {
      throw new Error('Production Anthropic router eval requires exactly one text message');
    }
    const providerRequest = Object.freeze({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages: Object.freeze([{ role: 'user' as const, content: request.messages[0].content[0].text }]),
    });
    return Object.freeze({ provider: this.id, model: request.model, capabilities: this.capabilities, providerRequest });
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    const response = await this.client.messages.create(
      prepared.providerRequest as never,
      { maxRetries: 0, signal: options.signal },
    );
    const first = response.content[0];
    const text = first?.type === 'text' ? first.text : '';
    const finishReason = response.stop_reason === 'max_tokens'
      ? 'length'
      : response.stop_reason === 'refusal'
        ? 'refusal'
        : response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence'
          ? 'stop'
          : (() => { throw new Error(`Unsupported Anthropic router stop reason: ${response.stop_reason}`); })();
    if (response.model !== request.model && !response.model.startsWith(`${request.model}-`)) {
      throw new UnexpectedModelIdentityError('anthropic', request.model, response.model);
    }
    yield { type: 'response_start', provider: this.id, model: response.model, id: response.id };
    if (text) yield { type: 'text_delta', index: 0, text };
    yield {
      type: 'response_complete',
      response: {
        provider: this.id,
        model: response.model,
        id: response.id,
        content: text ? [{ type: 'text', text }] : [],
        finishReason,
        providerFinishReason: response.stop_reason ?? 'missing',
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      },
    };
  }
}

const providerNames = (argument('providers') ?? 'anthropic,openai,google').split(',') as ProviderName[];
const profiles = (argument('profiles') ?? 'prompt_parity,native_structured').split(',') as Profile[];
const repetitions = Number(argument('repetitions') ?? '3');
const softMaxUsd = Number(argument('soft-max-usd'));
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('--repetitions must be 1..10');
if (!Number.isFinite(softMaxUsd) || softMaxUsd <= 0) throw new Error('--soft-max-usd is required and must be positive');
if (providerNames.some((name) => !['anthropic', 'openai', 'google'].includes(name))) throw new Error('Unknown --providers value');
if (profiles.some((name) => !['prompt_parity', 'native_structured'].includes(name))) throw new Error('Unknown --profiles value');
if (new Set(providerNames).size !== providerNames.length) throw new Error('--providers must not contain duplicates');
if (new Set(profiles).size !== profiles.length) throw new Error('--profiles must not contain duplicates');

const providers: Partial<Record<ProviderName, { provider: ModelProvider; model: string }>> = {};
if (providerNames.includes('anthropic')) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  if (ModelConfig.fast !== 'claude-haiku-4-5') throw new Error('Router eval pins Anthropic to claude-haiku-4-5');
  providers.anthropic = { provider: new ProductionRouterAnthropicProvider(process.env.ANTHROPIC_API_KEY), model: ModelConfig.fast };
}
if (providerNames.includes('openai')) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  providers.openai = { provider: new OpenAIResponsesProvider(process.env.OPENAI_API_KEY), model: OPENAI_ROUTER_MODEL };
}
if (providerNames.includes('google')) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
  providers.google = { provider: new GoogleGenerateContentProvider(process.env.GEMINI_API_KEY), model: GOOGLE_ROUTER_MODEL };
}

const requestedCells = providerNames.flatMap((provider) => profiles.map((profile) => ({ provider, profile })));
const excludedCells = requestedCells
  .filter((cell) => cell.provider === 'anthropic' && cell.profile === 'native_structured')
  .map((cell) => ({ ...cell, reason: 'anthropic_router_has_no_native_structured_profile' as const }));
const plannedCells = requestedCells.filter((cell) => !(cell.provider === 'anthropic' && cell.profile === 'native_structured'));
if (plannedCells.length === 0) throw new Error('Requested provider/profile matrix has no supported cells');
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
  'server/src/addie/model-providers/openai-responses-provider.ts',
  'server/src/addie/model-providers/google-generate-content-provider.ts',
  'server/tests/manual/provider-router-eval.ts',
];
const sourceBundleSha256 = sha256(sourceFiles.map((file) => [file, readFileSync(file, 'utf8')]));
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workingTreeDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
const projectedReservedCost = plannedCells.reduce((total, cell) => {
  const rate = RATES[cell.provider];
  const reservedOutput = cell.provider === 'google' ? 1_200 : 300;
  const selected = providers[cell.provider]!;
  const reasoningEffort = cell.provider === 'openai' ? 'none' as const : cell.provider === 'google' ? 'low' as const : undefined;
  const reservedInput = MODEL_ROUTER_CORPUS.reduce((tokens, testCase) => {
    const request = buildRouterEvalRequest(selected.model, cell.profile, testCase, reasoningEffort);
    return tokens + Buffer.byteLength(JSON.stringify(selected.provider.prepare(request).providerRequest), 'utf8');
  }, 0);
  return total + repetitions * ((reservedInput * rate.input + MODEL_ROUTER_CORPUS.length * reservedOutput * rate.output) / 1_000_000);
}, 0);
if (projectedReservedCost > softMaxUsd) {
  throw new Error(`Projected reserved cost $${projectedReservedCost.toFixed(4)} exceeds --soft-max-usd=$${softMaxUsd.toFixed(4)}`);
}

const dispatchedInvocations: Array<Record<string, unknown>> = [];
let accountedSpendUsd = 0;
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
      const prepared = selected.provider.prepare(evalRequest);
      const reserveInputTokens = Buffer.byteLength(
        JSON.stringify(prepared.providerRequest),
        'utf8',
      );
      const reserveOutputTokens = cell.provider === 'google' ? 1_200 : 300;
      const reserveUsd = (reserveInputTokens * rate.input + reserveOutputTokens * rate.output) / 1_000_000;
      if (!shouldDispatchWithinSoftBudget(accountedSpendUsd, reserveUsd, softMaxUsd)) {
        return {
          caseId: testCase.id,
          provider: cell.provider,
          requestedModel: selected.model,
          profile: cell.profile,
          status: 'not_dispatched_budget',
          latencyMs: 0,
          scores: {
            actionExact: false, toolsExact: false, privilegeLeak: false, invalidToolSet: false,
            confidenceExact: false, depthExact: false, emojiExact: false,
          },
          applicable: {
            tools: testCase.expected.action === 'respond',
            confidence: testCase.expected.confidence !== undefined,
            depth: testCase.expected.requiresDepth !== undefined,
            emoji: testCase.expected.emoji !== undefined,
          },
        };
      }
      const result = await evaluateRouterCase(
        selected.provider,
        selected.model,
        cell.profile,
        testCase,
        {
          reasoningEffort,
          timeoutMs: 120_000,
          beforeDispatch: (actualPrepared) => {
            dispatchedInvocations.push({
              repetition,
              caseId: testCase.id,
              provider: cell.provider,
              profile: cell.profile,
              reasoningEffort: reasoningEffort ?? 'provider_default',
              providerRequest: actualPrepared.providerRequest,
            });
          },
        },
      );
      if (result.usage) accountedSpendUsd += accountRouterCallCostUsd(result.usage, rate);
      return result;
  },
});
const results = matrixRun.results;
const budgetExposureUnknown = matrixRun.abortedAfter !== null;
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
  const actualCostUsd = (summary.inputTokens * rate.input + summary.outputTokens * rate.output) / 1_000_000;
  return {
    provider: cell.provider,
    requestedModel: providers[cell.provider]!.model,
    returnedModels: [...new Set(cellResults.map((result) => result.returnedModel).filter(Boolean))],
    profile: cell.profile,
    reasoningEffort: cell.provider === 'openai' ? 'none' : cell.provider === 'google' ? 'low' : 'provider_default',
    pricingSource: rate.source,
    ...summary,
    actualCostUsd,
    cases: cellResults.map((result) => ({
      caseId: result.caseId,
      status: result.status,
      returnedModel: result.returnedModel,
      scores: result.scores,
      latencyMs: result.latencyMs,
      usage: result.usage,
    })),
  };
});

const exactInvocationBundle = plannedCells.flatMap((cell) => {
  const selected = providers[cell.provider]!;
  const reasoningEffort = cell.provider === 'openai' ? 'none' as const : cell.provider === 'google' ? 'low' as const : undefined;
  return MODEL_ROUTER_CORPUS.map((testCase) => ({
    provider: cell.provider,
    profile: cell.profile,
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
  accountedSpendUsd,
  report,
}, null, 2));
