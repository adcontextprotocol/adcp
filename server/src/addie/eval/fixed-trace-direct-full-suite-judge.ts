import { createHash } from 'node:crypto';
import { collectModelResponse, InvalidModelEventStreamError } from '../model-providers/events.js';
import type { ModelFinishReason, ModelOutputSchema, ModelProvider, ModelProviderId, ModelReasoningEffort, ModelRequest, ModelResponse, ModelUsage } from '../model-providers/model-provider.js';
import { datedPricingProfileIdentity, datedPricingProfilesForFixedTrace } from './dated-pricing-cohort.js';
import { fixedTraceDirectFullSuiteResponsePricingPolicy, fixedTraceEstimatedCostUsd } from './fixed-trace-budget.js';
import { assertFixedTraceBlindedModelJudgePacket } from './fixed-trace-model-judge-control-plane.js';
import { FIXED_TRACE_JUDGE_PROMPT_VERSION } from './fixed-trace-judge.js';
import type { FixedTraceCompletedJudgeSummary } from './fixed-trace-judge.js';
import type { FixedTraceProviderStageConfig } from './fixed-trace-runner.js';
import type { FixedTraceCase, FixedTraceObservation } from './fixed-trace-suite.js';

export const FIXED_TRACE_DIRECT_FULL_SUITE_JUDGE_OUTPUT_SCHEMA: ModelOutputSchema = Object.freeze({
  name: 'addie_fixed_trace_blinded_judgment_v2',
  description: 'A blinded fixed-trace judgment.',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['pass', 'finding'] as string[],
    properties: {
      pass: { type: 'boolean' },
      finding: { type: 'string', maxLength: 240 },
    },
  },
  });

/** Whole-cell admission counts each blinded judge request at this hard ceiling. */
export const FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_PREPARED_REQUEST_BYTES = 65_536;

export interface FixedTraceDirectFullSuiteJudgment {
  readonly traceId: string;
  readonly judgeProvider: ModelProviderId;
  readonly judgeModel: string;
  readonly status: 'pass' | 'fail' | 'missing' | 'malformed' | 'timeout_after_dispatch' | 'unknown_exposure' | 'not_dispatched_budget';
  readonly finding: string | null;
  readonly latencyMs: number;
  readonly estimatedCostUsd: number | null;
  readonly requestedProvider: ModelProviderId;
  readonly requestedModel: string;
  readonly requestedReasoningEffort: ModelReasoningEffort;
  readonly returnedProvider: ModelProviderId | null;
  readonly returnedModel: string | null;
  /** The normalized provider response has no effort field; never fabricate one. */
  readonly returnedReasoningEffort: null;
  /** All four categories are normalized to explicit non-negative integers. */
  readonly usage: ModelUsage | null;
  readonly finishReason: ModelFinishReason | null;
  readonly providerFinishReason: string | null;
  readonly promptSha256: string;
  /** Hash of the exact invocation admitted at the SDK dispatch boundary. */
  readonly providerRequestSha256: string | null;
  readonly promptConfigVersion: string;
  readonly judgeConfigSha256: string;
  readonly pricingProfileId: string;
  readonly pricingProfileSha256: string;
  readonly pricingSource: string;
  readonly pricingPolicy: Readonly<{
    expectedProvider: ModelProviderId;
    expectedModel: string;
    modelResolutionPolicy: string;
  }>;
  readonly dispatched: boolean;
  /** Settlement classification independent of verdict parsing. */
  readonly exposure: 'settled' | 'unknown' | 'not_dispatched';
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function snapshotUsage(usage: unknown): ModelUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  // Input/output are required normalized adapter evidence. Cache categories
  // are normalized to zero only when the adapter does not expose them.
  const inputTokens = record.inputTokens;
  const outputTokens = record.outputTokens;
  const cacheReadTokens = record.cacheReadTokens ?? 0;
  const cacheWriteTokens = record.cacheWriteTokens ?? 0;
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) return null;
  return Object.freeze({
    inputTokens: inputTokens as number, outputTokens: outputTokens as number,
    cacheReadTokens: cacheReadTokens as number, cacheWriteTokens: cacheWriteTokens as number,
  });
}

function judgeModel(provider: ModelProviderId): string {
  return provider === 'anthropic' ? 'claude-haiku-4-5'
    : provider === 'google' ? 'gemini-3.7-flash'
      : 'gpt-5.6-luna';
}

function judgePrompt(): string {
  return `${FIXED_TRACE_JUDGE_PROMPT_VERSION}: Judge the candidate output only against the supplied task and scoring context. Return the required JSON; do not infer any candidate identity.`;
}

export interface FixedTraceDirectFullSuiteJudgePlan {
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly reasoningEffort: 'provider_default';
  readonly maxOutputTokens: 300;
  readonly timeoutMs: 30_000;
  readonly maxIterations: 1;
  readonly transportRetries: 0;
  readonly samplingMode: 'provider_no_sampling_control';
  readonly temperature: null;
  readonly promptConfigVersion: string;
  readonly promptSha256: string;
  readonly outputSchemaSha256: string;
  readonly judgeConfigSha256: string;
  readonly pricingProfileId: string;
  readonly pricingProfileSha256: string;
  readonly pricingSource: string;
  readonly pricingPolicy: Readonly<{
    expectedProvider: ModelProviderId;
    expectedModel: string;
    modelResolutionPolicy: string;
  }>;
}

/** Immutable judge controls used both in the outer plan and every judgment. */
export function fixedTraceDirectFullSuiteJudgePlan(provider: ModelProviderId): FixedTraceDirectFullSuiteJudgePlan {
  const model = judgeModel(provider);
  const pricing = datedPricingProfilesForFixedTrace().find((entry) => entry.provider === provider && entry.model === model);
  if (!pricing) throw new Error('Fixed trace direct full-suite judge pricing is unavailable');
  const policy = fixedTraceDirectFullSuiteResponsePricingPolicy(provider, model, pricing);
  const base = {
    provider, model, reasoningEffort: 'provider_default' as const,
    maxOutputTokens: 300 as const, timeoutMs: 30_000 as const, maxIterations: 1 as const,
    transportRetries: 0 as const, samplingMode: 'provider_no_sampling_control' as const, temperature: null,
    promptConfigVersion: FIXED_TRACE_JUDGE_PROMPT_VERSION,
    promptSha256: sha256({ promptConfigVersion: FIXED_TRACE_JUDGE_PROMPT_VERSION, system: judgePrompt() }),
    outputSchemaSha256: sha256(FIXED_TRACE_DIRECT_FULL_SUITE_JUDGE_OUTPUT_SCHEMA),
    pricingProfileId: pricing.profileId, pricingProfileSha256: datedPricingProfileIdentity(pricing).digest,
    pricingSource: pricing.source,
    pricingPolicy: Object.freeze({ expectedProvider: policy.expectedProvider, expectedModel: policy.expectedModel, modelResolutionPolicy: policy.modelResolutionPolicy }),
  };
  return Object.freeze({ ...base, judgeConfigSha256: sha256(base) });
}

function stageFor(provider: ModelProvider): FixedTraceProviderStageConfig {
  const plan = fixedTraceDirectFullSuiteJudgePlan(provider.id);
  const model = plan.model;
  const pricing = datedPricingProfilesForFixedTrace().find((entry) => entry.provider === provider.id && entry.model === model);
  if (!pricing) throw new Error('Fixed trace direct full-suite judge pricing is unavailable');
  return Object.freeze({
    provider, model, reasoningEffort: plan.reasoningEffort, maxOutputTokens: plan.maxOutputTokens,
    timeoutMs: plan.timeoutMs, maxIterations: plan.maxIterations, transportRetries: plan.transportRetries,
    samplingMode: plan.samplingMode, temperature: plan.temperature, pricing,
  });
}

function packet(trace: FixedTraceCase, observation: FixedTraceObservation) {
  const outputCondition = observation.terminalStatus === 'complete' && observation.output.trim()
    ? 'complete' as const
    : ['malformed', 'truncated', 'empty'].includes(observation.terminalStatus)
      ? 'malformed' as const
      : 'missing' as const;
  const result = {
    packetId: createHash('sha256').update(`${observation.metadata.runId}\0${trace.id}`, 'utf8').digest('hex'),
    prompt: trace.request.message,
    candidateOutput: outputCondition === 'complete' ? observation.output : null,
    outputCondition,
    scoringContext: JSON.stringify({
      requiredTextAny: trace.expectation.requiredTextAny ?? [],
      bannedText: trace.expectation.bannedText ?? [],
      maxWords: trace.expectation.maxWords ?? null,
      expectedTerminal: trace.expectation.terminalStatuses,
    }),
  };
  assertFixedTraceBlindedModelJudgePacket(result);
  return result;
}

function text(response: ModelResponse): string {
  return response.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('');
}

interface CapturedJudgeResponse {
  started: Readonly<{ provider: ModelProviderId; model: string }> | null;
  terminal: ModelResponse | null;
}

/** Observe the unmodified stream before the normal collector validates it. */
async function* observeJudgeResponse(
  events: AsyncIterable<import('../model-providers/model-provider.js').NormalizedModelEvent>,
  captured: CapturedJudgeResponse,
): AsyncIterable<import('../model-providers/model-provider.js').NormalizedModelEvent> {
  for await (const event of events) {
    if (event.type === 'response_start') {
      captured.started = Object.freeze({ provider: event.provider, model: event.model });
    } else if (event.type === 'response_complete') {
      captured.terminal = Object.freeze(structuredClone(event.response));
    }
    yield event;
  }
}

function verdict(value: string): { pass: boolean; finding: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.pass !== 'boolean' || typeof record.finding !== 'string' || record.finding.length > 240) return null;
    return { pass: record.pass, finding: record.finding };
  } catch { return null; }
}

/**
 * Validate the one invocation the adapter is about to hand to its SDK.  Do
 * not call `prepare()` here: adapters prepare inside `respond()` immediately
 * before dispatch, and that value is the only request artifact may attest to.
 */
function assertJudgeDispatchInvocation(
  prepared: import('../model-providers/model-provider.js').PreparedModelInvocation,
  request: ModelRequest,
  plan: FixedTraceDirectFullSuiteJudgePlan,
): void {
  if (
    prepared.provider !== plan.provider
    || prepared.model !== plan.model
    || sha256(prepared.requestMetadata) !== sha256(request.requestMetadata)
  ) throw new Error('Fixed trace direct full-suite judge dispatch invocation differs from immutable identity/config');
  if (
    request.model !== plan.model
    || request.maxOutputTokens !== plan.maxOutputTokens
    || request.reasoning !== undefined
    || sha256(request.outputSchema) !== plan.outputSchemaSha256
    || sha256({ promptConfigVersion: plan.promptConfigVersion, system: request.system.map((block) => block.text).join('') }) !== plan.promptSha256
  ) throw new Error('Fixed trace direct full-suite judge request differs from immutable plan');
  if (Buffer.byteLength(JSON.stringify(prepared.providerRequest), 'utf8') > FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_PREPARED_REQUEST_BYTES) {
    throw new Error('Fixed trace direct full-suite judge dispatch request exceeds prepared request byte ceiling');
  }
}

/** Execute exactly the supplied provider-excluding judge slots for one blinded packet. */
export async function judgeFixedTraceDirectFullSuiteObservation(input: Readonly<{
  trace: FixedTraceCase;
  observation: FixedTraceObservation;
  judges: Readonly<Record<ModelProviderId, ModelProvider>>;
  requiredJudgeProviders: readonly ModelProviderId[];
}>): Promise<readonly FixedTraceDirectFullSuiteJudgment[]> {
  if (input.requiredJudgeProviders.length !== 2 || new Set(input.requiredJudgeProviders).size !== 2) {
    throw new Error('Fixed trace direct full-suite comparison requires exactly two distinct judge providers');
  }
  const blinded = packet(input.trace, input.observation);
  const results: FixedTraceDirectFullSuiteJudgment[] = [];
  for (const judgeProvider of input.requiredJudgeProviders) {
    const provider = input.judges[judgeProvider];
    if (!provider || provider.id !== judgeProvider) throw new Error('Fixed trace direct full-suite judge provider identity drift');
    const stage = stageFor(provider);
    const judgePlan = fixedTraceDirectFullSuiteJudgePlan(judgeProvider);
    const request: ModelRequest = {
      model: stage.model,
      system: [{ text: judgePrompt() }],
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(blinded) }] }],
      tools: [], outputSchema: FIXED_TRACE_DIRECT_FULL_SUITE_JUDGE_OUTPUT_SCHEMA,
      maxOutputTokens: stage.maxOutputTokens,
      requestMetadata: { purpose: 'fixed_trace_blinded_judge', trace_id: input.trace.id },
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    let dispatched = false;
    let timedOut = false;
    let providerRequestSha256: string | null = null;
    const captured: CapturedJudgeResponse = { started: null, terminal: null };
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, stage.timeoutMs);
    try {
      const response = await collectModelResponse(observeJudgeResponse(
        stage.provider.respond(request, {
          signal: controller.signal,
          beforeDispatch: (prepared) => {
            // Preserve evidence even when admission rejects this boundary
            // invocation; it was observed but never sent to the SDK.
            providerRequestSha256 = sha256(prepared.providerRequest);
            assertJudgeDispatchInvocation(prepared, request, judgePlan);
            dispatched = true;
          },
        }),
        captured,
      ), stage.provider.id);
      const usage = snapshotUsage(response.usage);
      const parsed = response.finishReason === 'stop' ? verdict(text(response)) : null;
      const identityExact = response.provider === stage.provider.id && response.model === stage.model;
      const settled = dispatched && identityExact && usage !== null;
      results.push(Object.freeze({
        traceId: input.trace.id, judgeProvider, judgeModel: stage.model,
        status: !settled ? 'unknown_exposure' : !parsed ? 'malformed' : parsed.pass ? 'pass' : 'fail',
        finding: parsed?.finding ?? null, latencyMs: Date.now() - startedAt,
        estimatedCostUsd: settled ? fixedTraceEstimatedCostUsd(usage, stage.pricing) : null, requestedProvider: stage.provider.id,
        requestedModel: stage.model, requestedReasoningEffort: stage.reasoningEffort,
        returnedProvider: response.provider, returnedModel: response.model, returnedReasoningEffort: null,
        usage, finishReason: response.finishReason, providerFinishReason: response.providerFinishReason,
        promptSha256: judgePlan.promptSha256, providerRequestSha256,
        promptConfigVersion: FIXED_TRACE_JUDGE_PROMPT_VERSION, judgeConfigSha256: judgePlan.judgeConfigSha256,
        pricingProfileId: judgePlan.pricingProfileId, pricingProfileSha256: judgePlan.pricingProfileSha256,
        pricingSource: judgePlan.pricingSource, pricingPolicy: judgePlan.pricingPolicy, dispatched, exposure: settled ? 'settled' : 'unknown',
      }));
    } catch (error) {
      if (error instanceof InvalidModelEventStreamError && (captured.terminal !== null || captured.started !== null)) {
        const response = captured.terminal;
        const returned = response ?? captured.started;
        results.push(Object.freeze({
          traceId: input.trace.id, judgeProvider, judgeModel: stage.model, status: 'unknown_exposure', finding: null,
          latencyMs: Date.now() - startedAt, estimatedCostUsd: null,
          requestedProvider: stage.provider.id, requestedModel: stage.model, requestedReasoningEffort: stage.reasoningEffort,
          returnedProvider: returned?.provider ?? null, returnedModel: returned?.model ?? null, returnedReasoningEffort: null,
          usage: response ? snapshotUsage(response.usage) : null,
          finishReason: response?.finishReason ?? null, providerFinishReason: response?.providerFinishReason ?? null,
          promptSha256: judgePlan.promptSha256, providerRequestSha256,
          promptConfigVersion: FIXED_TRACE_JUDGE_PROMPT_VERSION, judgeConfigSha256: judgePlan.judgeConfigSha256,
          pricingProfileId: judgePlan.pricingProfileId, pricingProfileSha256: judgePlan.pricingProfileSha256,
          pricingSource: judgePlan.pricingSource, pricingPolicy: judgePlan.pricingPolicy, dispatched, exposure: 'unknown',
        }));
        continue;
      }
      const budget = error instanceof Error && error.name === 'FixedTraceBudgetAdmissionError';
      results.push(Object.freeze({
        traceId: input.trace.id, judgeProvider, judgeModel: stage.model,
        status: budget ? 'not_dispatched_budget' : dispatched && timedOut ? 'timeout_after_dispatch' : dispatched ? 'unknown_exposure' : 'missing',
        finding: null, latencyMs: Date.now() - startedAt, estimatedCostUsd: null,
        requestedProvider: stage.provider.id, requestedModel: stage.model,
        requestedReasoningEffort: stage.reasoningEffort, returnedProvider: null, returnedModel: null, returnedReasoningEffort: null,
        usage: null, finishReason: null, providerFinishReason: null,
        promptSha256: judgePlan.promptSha256, providerRequestSha256,
        promptConfigVersion: FIXED_TRACE_JUDGE_PROMPT_VERSION, judgeConfigSha256: judgePlan.judgeConfigSha256,
        pricingProfileId: judgePlan.pricingProfileId, pricingProfileSha256: judgePlan.pricingProfileSha256,
        pricingSource: judgePlan.pricingSource, pricingPolicy: judgePlan.pricingPolicy, dispatched,
        exposure: dispatched ? 'unknown' : 'not_dispatched',
      }));
    } finally { clearTimeout(timeout); }
  }
  return Object.freeze(results);
}

export function summarizeFixedTraceDirectFullSuiteJudgments(
  judgments: readonly FixedTraceDirectFullSuiteJudgment[],
  expectedCases: number,
): FixedTraceCompletedJudgeSummary {
  const expectedJudgments = expectedCases * 2;
  const judged = judgments.filter((judgment) => judgment.status === 'pass' || judgment.status === 'fail');
  const grouped = new Map<string, FixedTraceDirectFullSuiteJudgment[]>();
  for (const judgment of judgments) grouped.set(judgment.traceId, [...(grouped.get(judgment.traceId) ?? []), judgment]);
  const consensus = [...grouped.values()].filter((group) => group.length === 2 && group.every((entry) => entry.status === 'pass' || entry.status === 'fail'));
  const consensusPasses = consensus.filter((group) => group.every((entry) => entry.status === 'pass')).length;
  const disagreements = consensus.filter((group) => group[0]!.status !== group[1]!.status).length;
  const costs = judgments.map((judgment) => judgment.estimatedCostUsd);
  const latencies = judgments.map((judgment) => judgment.latencyMs).filter((latency) => Number.isFinite(latency) && latency >= 0).sort((left, right) => left - right);
  return Object.freeze({
    status: 'completed_diagnostic', expectedCases, expectedJudgments, observedJudgments: judgments.length,
    judgedJudgments: judged.length, expectedRecordCountObserved: judgments.length === expectedJudgments,
    judgmentCoverageRate: expectedJudgments === 0 ? null : judged.length / expectedJudgments,
    consensusPassRate: expectedCases === 0 ? null : consensusPasses / expectedCases,
    disagreementRate: expectedCases === 0 ? null : disagreements / expectedCases,
    latencyP95Ms: latencies.length === expectedJudgments ? latencies[Math.max(0, Math.ceil(latencies.length * .95) - 1)]! : null,
    totalEstimatedCostUsd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
    comparisonEligible: false,
  });
}
