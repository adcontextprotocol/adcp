import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_EXPERIMENTAL_DESIGN,
  assertFixedTraceExperimentalDesign,
  fixedTraceExperimentalDesignFingerprint,
} from "../../../src/addie/eval/fixed-trace-experimental-design.js";
import { FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PACK_DIGEST } from "../../../src/addie/eval/fixed-trace-architecture-diagnostic.js";

describe("fixed-trace experimental-design admission", () => {
  it("pins distinct pack purposes, named smoke IDs, strata, and the mechanical-only cap", () => {
    assertFixedTraceExperimentalDesign();
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.packs.map((pack) => pack.id)).toEqual([
      "calibration", "development", "sealed_sizing_pilot", "external_final",
    ]);
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.smoke).toMatchObject({
      repetitions: 1, cells: 21, providerCeilingUsd: 5,
    });
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.hybridArchitectureDiagnostic).toMatchObject({
      status: "predeclared_synthetic_development_diagnostic_only",
      totalCases: 24, casesPerStratum: 8, contentDigest: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PACK_DIGEST,
      excludesHandpickedPolicyFixtures: false,
    });
    for (const estimand of FIXED_TRACE_EXPERIMENTAL_DESIGN.estimands.slice(2)) {
      expect(estimand).toMatchObject({
        strata: [
          "local_terminal_eligible",
          "matched_hybrid_fallback_near_miss",
          "routed_tool_or_safety",
        ],
        population: "custodied_24_case_diagnostic_pack_not_production_prevalence",
        analysisUnit: "conversation_user_episode_cluster",
        intentionToTreat: "all_assigned_case_arm_repetition_records",
        missingness: "missing_or_failed_output_remains_in_denominator",
        repetitions: "three_stability_repetitions_not_independent_N",
        multiplicity: "diagnostic_only_no_confirmatory_decision",
        collisionHandling: "custodied_preexposure_collision_audit_required",
      });
    }
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.smoke.executionOverlay).toMatchObject({
      status: "contract_complete_evaluator_owned_non_promotable",
      contractCompleteCaseIds: [
        "surface-channel-chatter", "knowledge-task-model", "admin-member-records-without-slack",
        "billing-invoice-confirmed", "tool-result-prompt-injection", "dev-tool-error-retry",
        "dev-truncation-boundary", "provider-unavailable",
      ],
    });
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.corpus).toMatchObject({
      caseCount: 82, developmentCases: 46, tuningCases: 36, sealedFinalCases: 0,
      trustedLockVerified: false, sealedFinalDeficit: 38,
    });
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.budget.humanDiagnosticFormula).toMatchObject({
      status: "not_admitted_pending_rate_and_assignment_authorization",
      blindedOutputs: 216,
      primaryRatings: 432,
      exampleTotalCeilingUsd: 650,
    });
    expect(FIXED_TRACE_EXPERIMENTAL_DESIGN.pricing.retrospectiveReconciliation).toMatchObject({
      status: "externally_supplied_nonadmitting_reconciliation_unverified_in_this_workspace",
      admissionBinding: null,
    });
  });

  it.each([
    (design: any) => { design.smoke.caseIds.pop(); },
    (design: any) => { design.smoke.orderedSubsetDigest = "forged"; },
    (design: any) => { design.smoke.strata[0] = "missing"; },
    (design: any) => { design.estimands[0].comparison = "provider_main_effect"; },
    (design: any) => { design.randomization.scheduleDigest = "forged"; },
    (design: any) => { design.hybridArchitectureDiagnostic.caseSpecs.localTerminal[0] = "policy-fixture"; },
    (design: any) => { design.corpus.lineage[0] = "external-final"; },
    (design: any) => { design.diagnosticManifest.signature = "forged"; },
  ])("rejects missing IDs, digests, randomization, or estimand rewrites", (mutate) => {
    const design = structuredClone(FIXED_TRACE_EXPERIMENTAL_DESIGN);
    mutate(design);
    expect(() => assertFixedTraceExperimentalDesign(design)).toThrow();
  });

  it("snapshots getters and proxies before a fingerprint can be produced", () => {
    const getter = structuredClone(FIXED_TRACE_EXPERIMENTAL_DESIGN) as any;
    Object.defineProperty(getter.smoke, "orderedSubsetDigest", {
      enumerable: true,
      get: () => "forged",
    });
    expect(() => fixedTraceExperimentalDesignFingerprint(getter)).toThrow("own enumerable data property");
    expect(() => assertFixedTraceExperimentalDesign(new Proxy(getter, {}))).toThrow("Proxy");
  });
});
