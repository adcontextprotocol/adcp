import { describe, expect, it, vi } from "vitest";
import {
  FIXED_TRACE_ADMITTED_CELLS,
  FIXED_TRACE_ARCHITECTURE_CELL_TRUTH,
  FIXED_TRACE_COMPONENT_SMOKE_PLAN,
  FIXED_TRACE_CONFIRMATORY_POWER_GATE,
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
  reliabilityFailures: 0,
  humanPrimaryQualityPass: true,
  latencyMs: 100 + index,
  costUsd: index,
});

describe("fixed-trace staged protocol", () => {
  it("has A itself reject a mismatched dependency-free prerequisite manifest", async () => {
    vi.resetModules();
    vi.doMock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js", async () => {
      const actual = await vi.importActual<typeof import("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js")>(
        "../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js",
      );
      return {
        ...actual,
        FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST: Object.freeze({
          ...actual.FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
          sourceCommit: "mismatched-A-source",
        }),
        fixedTraceAPurePrerequisiteManifest: () => Object.freeze({
          ...actual.FIXED_TRACE_A_PURE_PREREQUISITE_MANIFEST,
          sourceCommit: "mismatched-A-source",
        }) as never,
      };
    });
    try {
      await expect(import("../../../src/addie/eval/fixed-trace-evaluation-protocol.js"))
        .rejects.toThrow("fixed-trace A pure prerequisite manifest parity mismatch");
    } finally {
      vi.doUnmock("../../../src/addie/eval/fixed-trace-a-prerequisite-manifest.js");
      vi.resetModules();
    }
  });
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
    expect(
      FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases
        .flatMap((phase) => phase.arms)
        .some((arm) => arm.admission === "admitted_diagnostic"),
    ).toBe(false);
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
    expect(estimate.hybridWorstCaseRouterCalls).toBe(48);
    expect(estimate.hybridWorstCaseRouterCeilingUsd).toBeNull();
    expect(estimate.totalCeilingUsd).toBeNull();
    const architecture = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.find(
      (phase) => phase.id === "stage_3_architecture",
    )!;
    expect(architecture).toMatchObject({
      caseSet: "architecture_diagnostic_unavailable",
      uniqueCases: 24,
      repetitions: 3,
      selectionUse: "architecture_diagnostic",
    });
    expect(architecture.arms.every((arm) => arm.stages.every((stage) => stage.role !== "judge"))).toBe(true);
    expect(
      architecture.arms.find((arm) => arm.architecture === "direct_generation")
        ?.admission,
    ).toBe("not_admitted_architecture");
    expect(
      estimate.armCallAccounting.find(
        (arm) => arm.armId === "direct-locked-finalist",
      ),
    ).toMatchObject({ evaluable: false, routerCalls: 0, generationCalls: 864 });
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
      localTerminalCases: 24,
      routedCases: 48,
      routerCalls: 48,
      generationCalls: 576,
      routerCeilingUsd: null,
      generationCeilingUsd: null,
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
      FIXED_TRACE_CONFIRMATORY_POWER_GATE.conservativeNormalApproximationBounds,
    ).toMatchObject({ H1Superiority: 3_803, H2QualityNonInferiority: 10_562 });
    expect(estimateFixedTraceEvaluationProtocol()).toMatchObject({
      simulatorCeilingUsd: null,
      toolInvocationCeiling: null,
      totalCeilingUsd: null,
    });
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
      conservativeNormalApproximationBounds: {
        alpha: 0.0125,
        H1Superiority: 3_803,
        H2QualityNonInferiority: 10_562,
        H2AtDisplayedAlpha025: 8_721,
        notExactEMPower: true,
      },
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
    expect(
      FIXED_TRACE_CONFIRMATORY_POWER_GATE.hypotheses.every(
        (hypothesis) =>
          hypothesis.oneSidedAlpha ===
            "assigned_by_Holm_to_ordered_p_values_after_locked_gatekeeping_graph",
      ),
    ).toBe(true);
    expect(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.finalProtocol).toMatchObject({
      status: "unavailable",
      sizingPilot: {
        heldOutFromFinal: true,
        reusableInFinal: false,
        conservativeDiscordanceUpperBound: null,
      },
      judgeCalibration: {
        allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only",
      },
      finalRandomization: { episodeClusterManifestDigest: null },
      prospectivePricingCohort: { digest: null },
      lloydMoldovanEM: { certificate: null, certificateDigest: null },
      typeIValidation: { verifierIdentity: null, verifierSignature: null },
    });
    expect(FIXED_TRACE_OPERATIONAL_ECONOMIC_GATE).toMatchObject({
      status:
        "not_admitted_pending_complete_trusted_usage_and_predeclared_economic_margin",
      endpoint: "paired_metered_USD_cost_and_latency_reliability",
      qualityHypothesisRelationship: "separate_from_H2_quality_noninferiority",
      binaryPercentagePointHypothesis: false,
    });
  });
  it.each([
    (protocol: any) => { protocol.finalProtocol.lloydMoldovanEM.result = { p: 0.01 }; },
    (protocol: any) => { protocol.finalProtocol.exactPower.implementationDigest = "a".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.typeIValidation.validationDigest = "b".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.typeIValidation.verifierIdentity = "forged"; },
    (protocol: any) => { protocol.finalProtocol.lloydMoldovanEM.certificate = { forged: true }; },
    (protocol: any) => { protocol.finalProtocol.lloydMoldovanEM.certificateDigest = "d".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.sizingPilot.digest = "e".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.judgeCalibration.digest = "f".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.finalRandomization.episodeClusterManifestDigest = "a".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.prospectivePricingCohort.id = "forged"; },
    (protocol: any) => { protocol.finalProtocol.operationalGates.safety.result = "pass"; },
    (protocol: any) => { protocol.finalProtocol.missingnessDeviationAdmission.specificationDigest = "c".repeat(64); },
    (protocol: any) => { protocol.finalProtocol.externalPackCustody.custodianIdentity = "forged"; },
  ])("rejects every independently unavailable final admission artifact", (mutate) => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    mutate(protocol);
    expect(() => assertFixedTraceEvaluationProtocol(protocol)).toThrow();
  });
  it.each([
    (protocol: any) => { delete protocol.finalProtocol.sizingPilot; },
    (protocol: any) => { protocol.finalProtocol.extra = true; },
    (protocol: any) => { delete protocol.finalProtocol.lloydMoldovanEM.certificateDigest; },
    (protocol: any) => { protocol.finalProtocol.typeIValidation.extra = true; },
    (protocol: any) => { delete protocol.finalProtocol.finalRandomization.episodeClusterManifestDigest; },
    (protocol: any) => { protocol.finalProtocol.operationalGates.extra = true; },
    (protocol: any) => { delete protocol.finalProtocol.externalPackCustody.signature; },
  ])("rejects omission or addition from the unified final admission record", (mutate) => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    mutate(protocol);
    expect(() => assertFixedTraceEvaluationProtocol(protocol)).toThrow(
      "final admission must be one complete immutable record",
    );
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
      [
        ...results.filter((result) => result.role === "router").slice(0, 5),
        ...results.filter((result) => result.role === "generation").slice(0, 5),
      ].map((result) => result.cellId),
    );
    expect(selectFixedTraceScreeningSurvivors([...results].reverse())).toEqual(
      [
        ...results.filter((result) => result.role === "router").slice(0, 5),
        ...results.filter((result) => result.role === "generation").slice(0, 5),
      ].map((result) => result.cellId),
    );
    results[0]!.reliabilityFailures = 1;
    expect(selectFixedTraceScreeningSurvivors(results)).not.toContain(results[0]!.cellId);
    results[1]!.humanPrimaryQualityPass = false;
    expect(selectFixedTraceScreeningSurvivors(results)).not.toContain(results[1]!.cellId);
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
  it("derives descriptors from the canonical registry without inventing a prospective rate", () => {
    const luna = FIXED_TRACE_PROTOCOL_PRICING.find(
      (profile) => profile.provider === "openai",
    )!;
    expect(luna.status).toBe("unavailable_missing_canonical_price");
    expect(luna.profileId).toBeNull();
    expect(
      FIXED_TRACE_PROTOCOL_PRICING.every(
        (profile) => profile.status !== "available",
      ),
    ).toBe(true);
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
