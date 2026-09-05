import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_MIN_INDEPENDENT_JUDGES,
  buildFixedTraceJudgeRequest,
  judgeFixedTraceObservation,
  runIndependentFixedTraceJudges,
  summarizeFixedTraceJudges,
  type FixedTraceJudgeConfig,
} from "../../../src/addie/eval/fixed-trace-judge.js";
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  fixedTraceResponsePricingPolicy,
} from "../../../src/addie/eval/fixed-trace-budget.js";
import {
  FIXED_TRACE_SUITE,
  FIXED_TRACE_SUITE_VERSION,
  type FixedTraceModelStageMetadata,
  type FixedTraceObservation,
} from "../../../src/addie/eval/fixed-trace-suite.js";
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelProviderId,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from "../../../src/addie/model-providers/model-provider.js";

const CAPABILITIES: ModelProviderCapabilities = {
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  reasoningEfforts: ["provider_default", "none", "low"],
  customTools: false,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
};

const PRICING = {
  profileId: "openai-gpt-5.6-luna-2026-08-26",
  inputUsdPerMillionTokens: 0.2,
  outputUsdPerMillionTokens: 1.2,
  cacheReadUsdPerMillionTokens: 0.02,
  cacheWriteUsdPerMillionTokens: null,
  cacheReadAccounting: "subset" as const,
  cacheWriteAccounting: "unsupported" as const,
  source:
    "Repository reviewed OpenAI Luna standard pricing, checked 2026-08-26.",
};

class ScriptedJudgeProvider implements ModelProvider {
  readonly capabilities = CAPABILITIES;
  dispatches = 0;

  constructor(
    readonly id: ModelProviderId,
    private readonly output: string | string[],
    private readonly finishReason: "stop" | "length" = "stop",
    private readonly includeProviderState = false,
  ) {}

  prepare(request: ModelRequest): PreparedModelInvocation {
    return {
      provider: this.id,
      model: request.model,
      capabilities: this.capabilities,
      requestMetadata: request.requestMetadata,
      providerRequest: {
        model: request.model,
        messages: request.messages,
        max: request.maxOutputTokens,
      },
    };
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    this.dispatches++;
    const outputs = Array.isArray(this.output) ? this.output : [this.output];
    const providerState = {
      type: "provider_state" as const,
      provider: this.id,
      kind: "thinking",
    };
    const response = {
      provider: this.id,
      model: request.model,
      id: `${this.id}-judge-response`,
      content: [
        ...(this.includeProviderState ? [providerState] : []),
        ...outputs.map((text) => ({ type: "text" as const, text })),
      ],
      finishReason: this.finishReason,
      providerFinishReason: this.finishReason,
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    yield {
      type: "response_start",
      provider: this.id,
      model: request.model,
      id: response.id,
    };
    if (this.includeProviderState)
      yield { type: "provider_state", index: 0, state: providerState };
    for (const [index, text] of outputs.entries()) {
      yield {
        type: "text_delta",
        index: index + (this.includeProviderState ? 1 : 0),
        text,
      };
    }
    yield { type: "response_complete", response };
  }
}

function stage(provider: ModelProviderId): FixedTraceModelStageMetadata {
  return {
    source: "provider",
    dispatched: true,
    requestedProvider: provider,
    requestedModel: `${provider}-candidate-secret-model`,
    returnedProvider: provider,
    returnedModel: `${provider}-candidate-secret-model`,
    modelResolution: "exact",
    promptSha256: "a".repeat(64),
    providerRequestSha256: "b".repeat(64),
    reasoningEffort: "none",
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations: 1,
    transportRetries: 0,
    samplingMode: "provider_no_sampling_control",
    temperature: null,
    usageKnown: true,
    usage: { inputTokens: 1, outputTokens: 1 },
    estimatedCostUsd: 0.001,
    pricingSource: "synthetic",
    latencyMs: 10,
  };
}

function observation(
  traceId: string,
  provider: ModelProviderId = "anthropic",
): FixedTraceObservation {
  return {
    traceId,
    metadata: {
      runId: "candidate-secret-run-id",
      traceSuiteVersion: FIXED_TRACE_SUITE_VERSION,
      traceSuiteSha256: "c".repeat(64),
      sourceBundleSha256: "d".repeat(64),
      gitCommit: "0123456789abcdef",
      gitDirty: false,
      addieCodeVersion: "test",
      promptConfigVersion: "test",
      toolSchemaSha256: "e".repeat(64),
      router: stage(provider),
      generation: stage(provider),
    },
    terminalStage: "generation",
    terminalStatus: "complete",
    boundaryReason: null,
    localReplacementReason: null,
    finishReason: "stop",
    output: "AdCP uses typed tasks between buyer and seller agents.",
    flagged: false,
    route: { action: "respond", toolSets: ["knowledge"] },
    tools: [
      {
        name: "search_docs",
        description: "Search synthetic official documentation.",
        input: { query: "task model" },
        effect: "read",
        policyDisposition: "allowed",
        resultStatus: "ok",
        simulated: true,
      },
    ],
  };
}

function config(provider: ModelProvider): FixedTraceJudgeConfig {
  return {
    provider,
    model:
      provider.id === "openai" ? "gpt-5.6-luna" : `${provider.id}-judge-model`,
    reasoningEffort: provider.id === "google" ? "low" : "none",
    maxOutputTokens: 200,
    timeoutMs: 30_000,
    pricing: PRICING,
  };
}

describe("fixed-trace independent judge", () => {
  const trace = FIXED_TRACE_SUITE.find(
    (candidate) => candidate.id === "knowledge-task-model",
  )!;

  it("builds a blinded request without candidate model, provider, or run identity", () => {
    const candidate = observation(trace.id);
    const request = buildFixedTraceJudgeRequest(trace, candidate, {
      model: "judge-model",
      reasoningEffort: "none",
      maxOutputTokens: 200,
    });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("candidate-secret");
    expect(serialized).not.toContain("anthropic");
    expect(serialized).not.toContain(
      "Official task lifecycle: if work is asynchronous",
    );
    expect(serialized).toContain("candidate_answer");
    expect(serialized).toContain("Search synthetic official documentation.");
    expect(serialized).toContain("task model");
    expect(request.requestMetadata).toEqual({
      purpose: "fixed_trace_blinded_judge",
      trace_id: trace.id,
    });
    expect(request.outputSchema).toMatchObject({
      name: "fixed_trace_judge_verdict",
      strict: true,
      schema: {
        required: ["pass", "score", "reason", "finding"],
        additionalProperties: false,
      },
    });
  });

  it("accepts a strict, internally consistent verdict with complete provenance", async () => {
    const provider = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":4,"reason":"correct","finding":"The answer matches the executed tool evidence."}',
    );
    const result = await judgeFixedTraceObservation(
      trace,
      observation(trace.id),
      config(provider),
    );
    expect(result).toMatchObject({
      status: "judged",
      failureReason: null,
      verdict: {
        pass: true,
        score: 4,
        reason: "correct",
        finding: "The answer matches the executed tool evidence.",
      },
      metadata: {
        candidateIdentityMetadataExposed: false,
        requestedProvider: "openai",
        returnedProvider: "openai",
        usageKnown: true,
        maxIterations: 1,
        transportRetries: 0,
        samplingMode: "provider_no_sampling_control",
        temperature: null,
      },
    });
    expect(result.metadata.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.metadata.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.metadata.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.metadata.estimatedCostUsd).toBeCloseTo(0.000044);
  });

  it("joins a valid verdict split across provider text blocks", async () => {
    const provider = new ScriptedJudgeProvider("openai", [
      '{"pass":true,',
      '"score":3,"reason":"correct","finding":"The answer is supported."}',
    ]);
    await expect(
      judgeFixedTraceObservation(
        trace,
        observation(trace.id),
        config(provider),
      ),
    ).resolves.toMatchObject({
      status: "judged",
      verdict: { pass: true, score: 3, reason: "correct" },
    });
  });

  it("accepts a verdict accompanied only by authenticated provider thinking state", async () => {
    const provider = new ScriptedJudgeProvider(
      "anthropic",
      '{"pass":true,"score":4,"reason":"correct","finding":"The answer is supported."}',
      "stop",
      true,
    );
    await expect(
      judgeFixedTraceObservation(
        trace,
        observation(trace.id, "openai"),
        config(provider),
      ),
    ).resolves.toMatchObject({
      status: "judged",
      verdict: { pass: true, score: 4, reason: "correct" },
    });
  });

  it("rejects inconsistent or truncated judge output", async () => {
    const inconsistent = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":2,"reason":"correct"}',
    );
    const truncated = new ScriptedJudgeProvider(
      "google",
      '{"pass":true',
      "length",
    );
    await expect(
      judgeFixedTraceObservation(
        trace,
        observation(trace.id),
        config(inconsistent),
      ),
    ).resolves.toMatchObject({
      status: "invalid",
      failureReason: "judge_output_invalid",
    });
    await expect(
      judgeFixedTraceObservation(
        trace,
        observation(trace.id),
        config(truncated),
      ),
    ).resolves.toMatchObject({
      status: "invalid",
      failureReason: "judge_output_truncated",
    });
  });

  it("requires a bounded audit finding in every verdict", async () => {
    const missing = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":4,"reason":"correct"}',
    );
    const blank = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":4,"reason":"correct","finding":""}',
    );
    const oversized = new ScriptedJudgeProvider(
      "openai",
      JSON.stringify({
        pass: true,
        score: 4,
        reason: "correct",
        finding: "x".repeat(241),
      }),
    );
    for (const provider of [missing, blank, oversized]) {
      await expect(
        judgeFixedTraceObservation(
          trace,
          observation(trace.id),
          config(provider),
        ),
      ).resolves.toMatchObject({
        status: "invalid",
        failureReason: "judge_output_invalid",
      });
    }
  });

  it("refuses a same-provider judge before dispatch", async () => {
    const provider = new ScriptedJudgeProvider(
      "anthropic",
      '{"pass":true,"score":4,"reason":"correct"}',
    );
    const result = await judgeFixedTraceObservation(
      trace,
      observation(trace.id),
      config(provider),
    );
    expect(result).toMatchObject({
      status: "skipped",
      failureReason: "judge_not_independent",
    });
    expect(provider.dispatches).toBe(0);
  });

  it("also excludes a returned fallback provider from the judge panel", async () => {
    const candidate = observation(trace.id);
    candidate.metadata.generation.returnedProvider = "google";
    candidate.metadata.generation.returnedModel =
      "google-fallback-secret-model";
    candidate.metadata.generation.modelResolution = "provider_canonicalized";
    const provider = new ScriptedJudgeProvider(
      "google",
      '{"pass":true,"score":4,"reason":"correct"}',
    );
    const result = await judgeFixedTraceObservation(
      trace,
      candidate,
      config(provider),
    );
    expect(result).toMatchObject({
      status: "skipped",
      failureReason: "judge_not_independent",
    });
    expect(provider.dispatches).toBe(0);
  });

  it("attributes a budget rejection without dispatching the judge", async () => {
    const delegate = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":4,"reason":"correct"}',
    );
    const budget = new FixedTraceBudget(0.000001);
    const provider = new BudgetedFixedTraceProvider(
      delegate,
      budget,
      PRICING,
      fixedTraceResponsePricingPolicy("openai", "gpt-5.6-luna", PRICING),
    );
    const result = await judgeFixedTraceObservation(
      trace,
      observation(trace.id),
      config(provider),
    );
    expect(result).toMatchObject({
      status: "not_dispatched_budget",
      failureReason: "judge_budget_rejected",
      metadata: { usageKnown: false, estimatedCostUsd: 0 },
    });
    expect(result.metadata.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(delegate.dispatches).toBe(0);
  });

  it("requires and summarizes two distinct non-candidate judge providers", async () => {
    const candidate = observation(trace.id);
    const openai = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":4,"reason":"correct","finding":"The answer is supported."}',
    );
    const google = new ScriptedJudgeProvider(
      "google",
      '{"pass":true,"score":3,"reason":"correct","finding":"The answer is supported."}',
    );
    const judgments = await runIndependentFixedTraceJudges(
      [trace],
      [candidate],
      [config(openai), config(google)],
    );
    expect(judgments).toHaveLength(FIXED_TRACE_MIN_INDEPENDENT_JUDGES);
    expect(
      summarizeFixedTraceJudges([trace], [candidate], judgments),
    ).toMatchObject({
      expectedCases: 1,
      expectedJudgments: 2,
      observedJudgments: 2,
      judgedJudgments: 2,
      complete: true,
      judgmentCoverageRate: 1,
      consensusPassRate: 1,
      disagreementRate: 0,
      comparisonEligible: true,
    });
  });

  it("rejects an incomplete independent judge panel before any judge dispatch", async () => {
    const openai = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":4,"reason":"correct"}',
    );
    await expect(
      runIndependentFixedTraceJudges(
        [trace],
        [observation(trace.id)],
        [config(openai)],
      ),
    ).rejects.toThrow("requires at least two independent judge providers");
    expect(openai.dispatches).toBe(0);
  });

  it("records disagreement as a failed consensus without hiding completed coverage", async () => {
    const candidate = observation(trace.id);
    const openai = new ScriptedJudgeProvider(
      "openai",
      '{"pass":true,"score":3,"reason":"correct","finding":"The answer is supported."}',
    );
    const google = new ScriptedJudgeProvider(
      "google",
      '{"pass":false,"score":2,"reason":"incomplete","finding":"The answer omits a required criterion."}',
    );
    const judgments = await runIndependentFixedTraceJudges(
      [trace],
      [candidate],
      [config(openai), config(google)],
    );
    expect(
      summarizeFixedTraceJudges([trace], [candidate], judgments),
    ).toMatchObject({
      judgmentCoverageRate: 1,
      consensusPassRate: 0,
      disagreementRate: 1,
      comparisonEligible: true,
    });
  });
});
