import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_ADMITTED_CELLS,
  FIXED_TRACE_CONFIRMATORY_POWER_GATE,
  FIXED_TRACE_CONFIRMATORY_ADMISSION,
  FIXED_TRACE_HYBRID_CONTRAST_PREFLIGHT,
  FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS,
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  FIXED_TRACE_PROTOCOL_PRICING,
  FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES,
  assertPromotionGradeDualJudgeFeasibility,
  assertFixedTraceEvaluationProtocol,
  estimateFixedTraceEvaluationProtocol,
  providerExcludingCalibratedJudges,
  selectFixedTraceScreeningSurvivors,
  semanticJudgeCandidateProviders,
} from "../../../src/addie/eval/fixed-trace-evaluation-protocol.js";
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  assertFixedTracePartitionManifest,
} from "../../../src/addie/eval/fixed-trace-partition.js";
import { resolveModelCostPricing } from "../../../src/addie/model-cost-pricing.js";

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
    ).toEqual(["H1-superiority", "H2-non-inferiority"]);
    expect(FIXED_TRACE_CONFIRMATORY_POWER_GATE).toMatchObject({
      targetPower: 0.8,
      conservativeDiscordanceVarianceUpperBound: 1,
      hypotheses: [
        {
          id: "H1-superiority",
          marginPercentagePoints: 0,
          exactTest: "exact_conditional_mcnemar_zero_margin_only",
        },
        {
          id: "H2-non-inferiority",
          marginPercentagePoints: -3,
          exactTest:
            "predeclared_exact_unconditional_matched_pair_test_required",
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
  });
  it("uses two provider-excluding calibrated judge families for every candidate provider", () => {
    for (const provider of ["anthropic", "openai", "google"] as const) {
      const judges = providerExcludingCalibratedJudges([provider]);
      expect(judges).toHaveLength(2);
      expect(judges.some((judge) => judge.provider === provider)).toBe(false);
    }
    expect(FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS).toHaveLength(2);
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
      "single-provider complete pipeline",
    );
  });
  it("applies hard elimination and successive halving deterministically", () => {
    const results = FIXED_TRACE_ADMITTED_CELLS.slice(0, 4).map(
      (cell, index) => ({
        cellId: cell.id,
        safetyFailures: index === 3 ? 1 : 0,
        identityFailures: 0,
        malformedFailures: 0,
        toolLoopFailures: 0,
        reliabilityFailures: index,
        latencyMs: 10 - index,
        costUsd: index,
      }),
    );
    expect(selectFixedTraceScreeningSurvivors(results)).toEqual([
      results[0]!.cellId,
      results[1]!.cellId,
    ]);
    expect(selectFixedTraceScreeningSurvivors([...results].reverse())).toEqual([
      results[0]!.cellId,
      results[1]!.cellId,
    ]);
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
