import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_ADMITTED_CELLS,
  FIXED_TRACE_ARCHITECTURE_CELL_TRUTH,
  FIXED_TRACE_COMPONENT_SMOKE_PLAN,
  FIXED_TRACE_CONFIRMATORY_POWER_GATE,
  FIXED_TRACE_CONFIRMATORY_ADMISSION,
  FIXED_TRACE_HYBRID_CONTRAST_PREFLIGHT,
  FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS,
  FIXED_TRACE_OPERATIONAL_ECONOMIC_GATE,
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  FIXED_TRACE_PROTOCOL_PRICING,
  FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT,
  FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES,
  assertPromotionGradeDualJudgeFeasibility,
  assertFixedTraceEvaluationProtocol,
  estimateFixedTraceEvaluationProtocol,
  fixedTraceEvaluationProtocolFingerprint,
  providerExcludingCalibratedJudges,
  selectFixedTraceScreeningSurvivors,
  semanticJudgeCandidateProviders,
} from "../../../src/addie/eval/fixed-trace-evaluation-protocol.js";
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  assertFixedTracePartitionManifest,
} from "../../../src/addie/eval/fixed-trace-partition.js";
import { resolveModelCostPricing } from "../../../src/addie/model-cost-pricing.js";

const screeningResult = (cell = FIXED_TRACE_ADMITTED_CELLS[0]!, index = 0) => ({
  cellId: cell.id,
  role: cell.role,
  provider: cell.provider,
  model: cell.model,
  effort: cell.effort,
  configFingerprint: FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT,
  safetyFailures: 0,
  identityFailures: 0,
  malformedFailures: 0,
  toolLoopFailures: 0,
  reliabilityFailures: index,
  latencyMs: 100 + index,
  costUsd: index,
});

describe("fixed-trace staged protocol", () => {
  it("derives the complete 46 development / 36 tuning partitions from corpus authority", () => {
    assertFixedTracePartitionManifest();
    expect(FIXED_TRACE_PARTITION_MANIFEST.development).toHaveLength(46);
    expect(FIXED_TRACE_PARTITION_MANIFEST.tuning).toHaveLength(36);
    expect(
      new Set([
        ...FIXED_TRACE_PARTITION_MANIFEST.development,
        ...FIXED_TRACE_PARTITION_MANIFEST.tuning,
      ]).size,
    ).toBe(82);
  });
  it("screens every reviewed adapter-supported provider/model/effort cell before adaptive pruning", () => {
    expect(FIXED_TRACE_ADMITTED_CELLS.filter((cell) => cell.role === "router")).toHaveLength(10);
    expect(FIXED_TRACE_ADMITTED_CELLS.filter((cell) => cell.role === "generation")).toHaveLength(11);
    for (const role of ["router", "generation"] as const)
      for (const provider of ["anthropic", "openai", "google"] as const)
        expect(
          FIXED_TRACE_ADMITTED_CELLS.some(
            (cell) => cell.role === role && cell.provider === provider,
          ),
        ).toBe(true);
    expect(
      FIXED_TRACE_ADMITTED_CELLS.filter(
        (cell) => cell.provider === "openai",
      ).map((cell) => cell.effort),
    ).toContain("high");
    expect(
      FIXED_TRACE_ADMITTED_CELLS.filter(
        (cell) => cell.provider === "google",
      ).map((cell) => cell.effort),
    ).toContain("medium");
    expect(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.adaptiveRule).toMatchObject(
      {
        smokeCases: 8,
        developmentCases: 46,
        tuningCases: 36,
        selection: "predeclared_pareto_successive_halving",
        repeats: "stability_only_not_new_cases",
      },
    );
    expect(FIXED_TRACE_COMPONENT_SMOKE_PLAN).toMatchObject({
      status: "not_admitted_pending_credential_free_admission",
      totalComponentCells: 21,
      cases: 8,
      repetitions: 1,
      maxGenerationInvocationsPerCase: 2,
      providerCeilingUsd: 5,
      llmJudging: "none",
      architectureClaim: "none",
    });
    expect(FIXED_TRACE_ARCHITECTURE_CELL_TRUTH).toEqual({
      routerCells: 10,
      generationCells: 11,
      directCombinations: 11,
      twoStageCombinations: 110,
      hybridCombinations: 110,
      totalArchitectureCombinations: 231,
      potentiallyLlmJudgeableProviderMatchedCombinations: 97,
      mixedProviderCombinationsRequiringHumanOrFourthProvider: 134,
    });
  });
  it("keeps hybrid router fallback and direct admission explicit in worst-case accounting", () => {
    const estimate = estimateFixedTraceEvaluationProtocol();
    expect(estimate.hybridWorstCaseRouterCalls).toBe(138);
    expect(estimate.hybridWorstCaseRouterCeilingUsd).toBeCloseTo(0.772248, 10);
    const architecture = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.find(
      (phase) => phase.id === "stage_3_architecture",
    )!;
    expect(
      architecture.arms.find((arm) => arm.architecture === "direct_generation")
        ?.admission,
    ).toBe("not_admitted_architecture");
    expect(
      estimate.armCallAccounting.find(
        (arm) => arm.armId === "direct-locked-finalist",
      ),
    ).toMatchObject({ evaluable: false, routerCalls: 0, generationCalls: 0 });
    const hybrid = architecture.arms.find(
      (arm) => arm.architecture === "deterministic_policy_llm_fallback_hybrid",
    )!;
    expect(hybrid.stages.some((stage) => stage.role === "router")).toBe(true);
    expect(hybrid.admission).toBe("not_evaluable_no_treatment_contrast");
    expect(FIXED_TRACE_HYBRID_CONTRAST_PREFLIGHT).toEqual([
      expect.objectContaining({
        phase: "development",
        totalCases: 46,
        localTerminalCases: 0,
        routedCases: 46,
        evaluable: false,
        blocker: "no_hybrid_treatment_contrast",
      }),
      expect.objectContaining({
        phase: "tuning",
        totalCases: 36,
        localTerminalCases: 0,
        routedCases: 36,
        evaluable: false,
        blocker: "no_hybrid_treatment_contrast",
      }),
    ]);
    expect(
      estimate.armCallAccounting.find(
        (arm) => arm.armId === "hybrid-locked-finalist",
      ),
    ).toMatchObject({
      evaluable: false,
      localTerminalCases: 0,
      routedCases: 138,
      routerCalls: 138,
      generationCalls: 1_656,
      routerCeilingUsd: 0.772248,
    });
  });
  it("has no fictional final N and binds named Holm hypotheses", () => {
    expect(
      FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol,
    ).toMatchObject({
      status: "unavailable",
      externalPackDigest: null,
      externalN: null,
      candidatePipelineId: null,
      comparatorPipelineId: null,
      architectureArmId: null,
      fingerprint: null,
      powerResult: null,
    });
    expect(
      FIXED_TRACE_CONFIRMATORY_POWER_GATE.requiredIndependentEvaluableCases,
    ).toBe(10_562);
    expect(
      FIXED_TRACE_CONFIRMATORY_POWER_GATE.superiorityRequiredIndependentEvaluableCases,
    ).toBe(3_803);
    expect(
      FIXED_TRACE_CONFIRMATORY_POWER_GATE.hypotheses.map(
        (hypothesis) => hypothesis.id,
      ),
    ).toEqual([
      "H1-superiority",
      "H2-quality-non-inferiority-for-lower-cost-pipeline",
    ]);
    expect(FIXED_TRACE_CONFIRMATORY_POWER_GATE).toMatchObject({
      targetPower: 0.8,
      conservativeDiscordanceVarianceUpperBound: 1,
      worstCaseUpperBoundsNotFinalN: true,
      hypotheses: [
        {
          id: "H1-superiority",
          marginPercentagePoints: 0,
          exactTest: "exact_conditional_mcnemar_zero_margin_only",
        },
        {
          id: "H2-quality-non-inferiority-for-lower-cost-pipeline",
          marginPercentagePoints: -3,
          exactTest:
            "unavailable_pending_independent_Lloyd_Moldovan_score_statistic_E_plus_M_exact_unconditional_noninferiority_implementation_and_type_I_error_validation",
        },
      ],
    });
    expect(FIXED_TRACE_CONFIRMATORY_ADMISSION).toMatchObject({
      status: "not_admitted_missing_fingerprinted_statistical_protocol",
      holm: { K: 2, oneSidedFamilyAlpha: 0.025 },
      unitOfAnalysis: "unique_conversation_user_episode",
      repeatedAndTemplateRelatedObservationRule:
        "cluster_by_conversation_user_episode; repetitions_never_increase_N",
      sizingPilot: {
        heldOutFromFinal: true,
        reusableInFinal: false,
        conservativeDiscordanceUpperBound: null,
      },
      judgeCalibration: {
        allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only",
      },
      finalProtocolFingerprint: null,
    });
    expect(FIXED_TRACE_OPERATIONAL_ECONOMIC_GATE).toMatchObject({
      status:
        "not_admitted_pending_complete_trusted_usage_and_predeclared_economic_margin",
      endpoint: "paired_metered_USD_cost_and_latency_reliability",
      qualityHypothesisRelationship: "separate_from_H2_quality_noninferiority",
      binaryPercentagePointHypothesis: false,
    });
  });
  it("fails closed until every provider-excluding judge has a custodied calibration", () => {
    for (const provider of ["anthropic", "openai", "google"] as const) {
      expect(() => providerExcludingCalibratedJudges([provider])).toThrow(
        "no admissible provider-excluding judge pair",
      );
    }
    expect(FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS).toHaveLength(3);
    expect(
      FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS.every(
        (judge) =>
          judge.calibrationCorpusSha256 === null &&
          judge.humanLabelsSha256 === null &&
          judge.outcomesSha256 === null &&
          judge.authenticatedAdmission === null &&
          judge.status === "blocked_pending_authenticated_calibration",
      ),
    ).toBe(true);
  });
  it("fails promotion-grade dual-LLM judging for a mixed router/generator pipeline", () => {
    const router = FIXED_TRACE_ADMITTED_CELLS.find(
      (cell) =>
        cell.id === "router:anthropic:claude-haiku-4-5:provider_default",
    )!;
    const generator = FIXED_TRACE_ADMITTED_CELLS.find(
      (cell) => cell.id === "generation:openai:gpt-5.6-luna:none",
    )!;
    expect(
      semanticJudgeCandidateProviders({
        stages: [
          { role: "router", cellId: router.id },
          { role: "generation", cellId: generator.id },
        ],
      } as any),
    ).toEqual(["anthropic", "openai"]);
    expect(() =>
      assertPromotionGradeDualJudgeFeasibility({
        stages: [
          { role: "router", cellId: router.id },
          { role: "generation", cellId: generator.id },
        ],
      } as any),
    ).toThrow("single-provider complete pipeline");
    expect(() =>
      semanticJudgeCandidateProviders({
        stages: [{ role: "router", cellId: router.id }],
      } as any),
    ).toThrow("admitted generation provider");
  });
  it("fails closed if a nominally promotion-grade pipeline is made mixed-provider", () => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    const architecture = protocol.phases.find(
      (phase) => phase.id === "stage_3_architecture",
    )!;
    const routed = architecture.arms.find(
      (arm) => arm.id === "routed-locked-finalist",
    )!;
    (routed.stages[0] as { cellId: string }).cellId =
      "router:openai:gpt-5.6-luna:none";
    expect(() => assertFixedTraceEvaluationProtocol(protocol)).toThrow(
      "pinned declaration",
    );
  });
  it("applies hard elimination and successive halving deterministically", () => {
    const results = FIXED_TRACE_ADMITTED_CELLS.map(screeningResult);
    results[20]!.safetyFailures = 1;
    expect(selectFixedTraceScreeningSurvivors(results)).toEqual(
      results.slice(0, 10).map((result) => result.cellId),
    );
    expect(selectFixedTraceScreeningSurvivors([...results].reverse())).toEqual(
      results.slice(0, 10).map((result) => result.cellId),
    );
  });
  it("rejects partial and hostile screening result sets", () => {
    const result = screeningResult();
    expect(() => selectFixedTraceScreeningSurvivors([result])).toThrow(
      "exactly one result for every supported executable cell",
    );
    const complete = FIXED_TRACE_ADMITTED_CELLS.map(screeningResult);
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, latencyMs: Number.NaN } : entry),
    )).toThrow("non-finite number");
    expect(() => selectFixedTraceScreeningSurvivors(
      [...complete.slice(0, -1), complete[0]!],
    )).toThrow("unknown, duplicate, or mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, provider: "google" } : entry),
    )).toThrow("mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, role: "generation" } : entry),
    )).toThrow("mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, model: "forged-model" } : entry),
    )).toThrow("mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, effort: "high" } : entry),
    )).toThrow("mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, cellId: "alias" } : entry),
    )).toThrow("mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, configFingerprint: "forged" } : entry),
    )).toThrow("mismatched canonical cell identity");
    expect(() => selectFixedTraceScreeningSurvivors(
      complete.map((entry, index) => index === 0 ? { ...entry, forged: true } : entry),
    )).toThrow("extra or missing fields");
  });
  it.each([
    (protocol: any) => { protocol.finalProtocol.familywiseAlpha = 0.5; },
    (protocol: any) => { protocol.finalProtocol.hypothesisIds[0] = "rewritten"; },
    (protocol: any) => { protocol.finalProtocol.pairedTest = "rewritten"; },
    (protocol: any) => { protocol.finalProtocol.exclusions = "drop_failures"; },
    (protocol: any) => { protocol.adaptiveRule.repeats = "inflate_N"; },
    (protocol: any) => { protocol.finalProtocol.powerResult = { admitted: true }; },
    (protocol: any) => { protocol.phases[4].arms[0].stages[0].maxOutputTokens = 1; },
  ])("rejects hostile nested protocol rewrites before fingerprinting", (mutate) => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    mutate(protocol);
    expect(() => assertFixedTraceEvaluationProtocol(protocol)).toThrow();
  });
  it("rejects getters and proxies before protocol validation, fingerprinting, or budgeting", () => {
    const getterProtocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    Object.defineProperty(getterProtocol.adaptiveRule, "repeats", {
      enumerable: true,
      get: () => "stability_only_not_new_cases",
    });
    for (const action of [
      () => assertFixedTraceEvaluationProtocol(getterProtocol),
      () => fixedTraceEvaluationProtocolFingerprint(getterProtocol),
      () => estimateFixedTraceEvaluationProtocol(getterProtocol),
    ]) expect(action).toThrow("own enumerable data property");
    const proxy = new Proxy(structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL), {});
    expect(() => estimateFixedTraceEvaluationProtocol(proxy)).toThrow("must not contain a Proxy");
    const togglingProtocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    let reads = 0;
    Object.defineProperty(togglingProtocol.adaptiveRule, "repeats", {
      enumerable: true,
      get: () => (++reads === 1 ? "stability_only_not_new_cases" : "999"),
    });
    expect(() => fixedTraceEvaluationProtocolFingerprint(togglingProtocol))
      .toThrow("own enumerable data property");
    expect(reads).toBe(0);
  });
  it("uses a detached protocol snapshot rather than a later nested mutation", () => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    const estimate = estimateFixedTraceEvaluationProtocol(protocol);
    protocol.phases[5].repetitions = 999;
    expect(estimate.stages.find((stage) => stage.phaseId === "stage_4_tuning")?.calls)
      .not.toBe(36 * 999);
    expect(() => estimateFixedTraceEvaluationProtocol(protocol)).toThrow("pinned declaration");
  });
  it("uses canonical Luna subset-cache pricing and leaves Terra/Sol inert", () => {
    const luna = FIXED_TRACE_PROTOCOL_PRICING.find(
      (profile) => profile.provider === "openai",
    )!;
    expect(luna.cacheReadAccounting).toBe("subset");
    expect(luna.cacheReadUsdPerMillionTokens).toBe(0.02);
    expect(
      resolveModelCostPricing("openai", "gpt-5.6-luna")?.estimateCostMicros({
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBe(20_000);
    expect(
      FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES.every(
        (candidate) => candidate.trustedPrice === null,
      ),
    ).toBe(true);
  });
  it("rejects changing the unadmitted direct boundary or final availability", () => {
    const direct = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    direct.phases[4].arms[2].admission = "admitted_diagnostic";
    expect(() => assertFixedTraceEvaluationProtocol(direct)).toThrow(
      "not_admitted_architecture",
    );
    const final = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    (final.finalProtocol as { externalN: number | null }).externalN = 38;
    expect(() => assertFixedTraceEvaluationProtocol(final)).toThrow(
      "external final is unavailable",
    );
  });
});
