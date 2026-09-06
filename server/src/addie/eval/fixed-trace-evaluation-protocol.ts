import { createHash } from "node:crypto";
import { datedPricingProfilesForFixedTrace } from "./dated-pricing-cohort.js";
import { ANTHROPIC_PROVIDER_CAPABILITIES } from "../model-providers/anthropic-provider.js";
import {
  GOOGLE_GENERATE_CONTENT_CAPABILITIES,
  GOOGLE_ROUTER_MODEL,
} from "../model-providers/google-generate-content-provider.js";
import type {
  ModelProviderId,
  ModelReasoningEffort,
} from "../model-providers/model-provider.js";
import {
  OPENAI_RESPONSES_CAPABILITIES,
  OPENAI_ROUTER_MODEL,
} from "../model-providers/openai-responses-provider.js";
import { ANTHROPIC_ROUTER_CAPABILITIES } from "../model-providers/anthropic-router-provider.js";
import {
  decideFixedTraceHybridRoute,
  fixedTraceHybridPolicy,
  type FixedTraceArchitectureArmId,
} from "./fixed-trace-architecture.js";
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  assertFixedTracePartitionManifest,
} from "./fixed-trace-partition.js";
import {
  FIXED_TRACE_EXPERIMENTAL_DESIGN,
  assertFixedTraceExperimentalDesign,
  fixedTraceExperimentalDesignFingerprint,
} from "./fixed-trace-experimental-design.js";
import {
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON,
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON,
} from "./fixed-trace-a-prerequisite-manifest.js";
import { snapshotFixedTraceJson } from "./fixed-trace-safe-snapshot.js";
import {
  FIXED_TRACE_CORPUS,
  FIXED_TRACE_SUITE,
  FIXED_TRACE_SUITE_VERSION,
  fixedTraceSuiteSha256,
} from "./fixed-trace-suite.js";

export const FIXED_TRACE_EVALUATION_PROTOCOL_VERSION =
  "addie-fixed-trace-evaluation-protocol-v3" as const;

/** A's explicit measurement authority; it is not an identity/privacy manifest. */
export const FIXED_TRACE_MEASUREMENT_MANIFEST = Object.freeze({
  version: "addie-fixed-trace-measurement-manifest-v1",
  primaryEndpoint: "two-judge blinded quality success rate",
  deterministicGrading: "fixed_trace_observation_contract_v1",
  failureDenominator: "hard_failures_and_missing_evidence_remain_in_denominator",
});
export const FIXED_TRACE_MEASUREMENT_MANIFEST_SHA256 =
  "c465bc7b5b69f3bf6e8151a5b4ff57d10d630d3f8ddc64c1cce4d504ad80fb5a" as const;

/**
 * The A-owned source for the post-base final prerequisites. Its digest is a
 * reproducible content identity, rather than a commit that predates it.
 */
export const FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY = Object.freeze({
  finalRandomization: Object.freeze({
    scheduleDigest: null,
    episodeClusterManifestDigest: null,
  }),
  judgeCalibration: Object.freeze({
    status: "unavailable" as const,
    allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only" as const,
    digest: null,
  }),
  providerExposure: Object.freeze({ status: "unavailable" as const, digest: null }),
  prospectivePricingCohort: Object.freeze({
    id: null,
    effectiveFrom: null,
    effectiveBefore: null,
    digest: null,
  }),
  externalPackCustody: Object.freeze({
    status: "unavailable" as const,
    custodianIdentity: null,
    packDigest: null,
    signature: null,
    collisionAuditDigest: null,
  }),
});
export const FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY_SHA256 =
  "fa4755eb1357c6a52bfe59f71b95700dd33d1cce66cee414847c8d14d29a8623" as const;

/** Independently pinned by A's consumer boundary, not imported as policy. */
const FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES_PIN = 16 * 1024;
const FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_SHA256_PIN =
  "7817771c13fe522046f89330a7962e16ecda7ac6f8c1d86a0d8ee60d47620a45" as const;

type FixedTraceAPrerequisiteManifestParityDiagnostic = Readonly<{
  status: "parity_failure";
  code: "fixed_trace_A_prerequisite_manifest_parity_mismatch";
  reason: "noncanonical_or_malformed_source" | "A_authority_leaf_mismatch";
}>;

class FixedTraceAPrerequisiteManifestParityError extends Error {
  readonly status: "parity_failure";
  readonly code: "fixed_trace_A_prerequisite_manifest_parity_mismatch";
  readonly diagnostic: FixedTraceAPrerequisiteManifestParityDiagnostic;

  constructor(reason: FixedTraceAPrerequisiteManifestParityDiagnostic["reason"]) {
    super("fixed-trace A pure prerequisite manifest parity mismatch");
    this.name = "FixedTraceAPrerequisiteManifestParityError";
    this.status = "parity_failure";
    this.code = "fixed_trace_A_prerequisite_manifest_parity_mismatch";
    this.diagnostic = Object.freeze({ status: this.status, code: this.code, reason });
    Object.freeze(this);
  }
}

export const FIXED_TRACE_CONFIRMATORY_POWER_GATE = Object.freeze({
  version: "addie-fixed-trace-confirmatory-power-v2",
  familywiseAlpha: 0.025,
  hypotheses: Object.freeze([
    Object.freeze({
      id: "H1-superiority",
      comparison: "locked-pipeline-candidate vs locked-pipeline-comparator",
      endpoint: "two-judge blinded quality success rate",
      direction: "greater",
      marginPercentagePoints: 0,
      alternativeDifferencePercentagePoints: 5,
      oneSidedAlpha: "assigned_by_Holm_to_ordered_p_values_after_locked_gatekeeping_graph",
      exactTest: "exact_conditional_mcnemar_zero_margin_only",
    }),
    Object.freeze({
      id: "H2-quality-non-inferiority-for-lower-cost-pipeline",
      comparison:
        "lower-metered-cost locked pipeline quality vs locked-pipeline-comparator quality",
      endpoint: "two-judge blinded quality success rate",
      direction: "not_less_than",
      marginPercentagePoints: -3,
      alternativeDifferencePercentagePoints: 0,
      oneSidedAlpha: "assigned_by_Holm_to_ordered_p_values_after_locked_gatekeeping_graph",
      exactTest:
        "unavailable_pending_independent_Lloyd_Moldovan_score_statistic_E_plus_M_exact_unconditional_noninferiority_implementation_and_type_I_error_validation",
      sensitivityOnly:
        "Sidik_exact_CI_or_p_value_after_primary_Lloyd_Moldovan_verification",
    }),
  ]),
  test: "H1_exact_conditional_mcnemar_only; H2_unavailable_pending_Lloyd_Moldovan_E_plus_M_exact_unconditional_method",
  bootstrap: "grouped_stratified_case_level_bootstrap",
  exclusionRule: "hard_failures_and_missing_evidence_remain_in_denominator",
  repetitionsCountAsIndependentCases: false,
  conservativeNormalApproximationBounds: Object.freeze({
    alpha: 0.0125,
    H1Superiority: 3_803,
    H2QualityNonInferiority: 10_562,
    H2AtDisplayedAlpha025: 8_721,
    notExactEMPower: true,
  }),
  targetPower: 0.8,
  planningAlternative:
    "H1: +5pp over zero; H2: 0pp, three points above the -3pp NI margin",
  conservativeDiscordanceVarianceUpperBound: 1,
  worstCaseUpperBoundsNotFinalN: true,
  finalNReductionRule:
    "only_sealed_never_reused_sizing_pilot_or_predeclared_blinded_arm_invariant_discordance_only_upward_internal_pilot_with_enumerated_adaptive_exact_type_I_error",
  externalFinalN: null,
  externalFinalStatus:
    "unavailable_pending_fingerprinted_exact_paired_discordance_power_result",
} as const);

export type FixedTraceProtocolPhaseId =
  | "stage_0_preflight_calibration"
  | "stage_1_smoke"
  | "stage_2_router_screen"
  | "stage_2_oracle_generator_screen"
  | "stage_3_architecture"
  | "stage_4_tuning"
  | "stage_5_external_final"
  | "stage_6_canary";
export type FixedTraceProtocolStageRole =
  "router" | "generation" | "judge" | "simulator";
export type FixedTraceProtocolAdmission =
  | "admitted_diagnostic"
  | "not_admitted_dispatch_authority"
  | "not_admitted_architecture"
  | "not_evaluable_no_treatment_contrast"
  | "not_admitted_external_final"
  | "not_admitted_canary";

/**
 * A planning descriptor is deliberately not a copied rate card.  The live
 * resolver is the sole source of a prospective rate; an effective interval is
 * required before a plan can become costed or dispatchable.
 */
export interface FixedTraceProtocolPricingProfile {
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly profileId: string | null;
  readonly version: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveBefore: string | null;
  readonly status: "available" | "unavailable_missing_canonical_price" | "unavailable_missing_effective_interval";
}

function canonicalPricingDescriptor(
  provider: ModelProviderId,
  model: string,
): FixedTraceProtocolPricingProfile {
  const pricing = datedPricingProfilesForFixedTrace().find(
    (profile) => profile.provider === provider && profile.model === model,
  );
  if (!pricing) return Object.freeze({
    provider, model, profileId: null, version: null, effectiveFrom: null,
    effectiveBefore: null, status: "unavailable_missing_canonical_price",
  });
  return Object.freeze({
    provider,
    model,
    profileId: pricing.profileId,
    version: pricing.profileId,
    effectiveFrom: pricing.effectiveFrom,
    effectiveBefore: pricing.effectiveBefore,
    status: "available",
  });
}

export const FIXED_TRACE_PROTOCOL_PRICING = Object.freeze([
  canonicalPricingDescriptor("anthropic", "claude-haiku-4-5"),
  canonicalPricingDescriptor("anthropic", "claude-sonnet-5"),
  canonicalPricingDescriptor("openai", OPENAI_ROUTER_MODEL),
  canonicalPricingDescriptor("google", GOOGLE_ROUTER_MODEL),
] satisfies readonly FixedTraceProtocolPricingProfile[]);

export interface FixedTraceAdmittedCell {
  readonly id: string;
  readonly role: "router" | "generation";
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly effort: ModelReasoningEffort;
  readonly pricingProfileId: string | null;
  readonly adapterCapabilitySource: string;
}
const efforts = (values: readonly ModelReasoningEffort[]) =>
  values.length ? values : ["provider_default" as const];
const priceId = (provider: ModelProviderId, model: string) => {
  const profile = FIXED_TRACE_PROTOCOL_PRICING.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (!profile)
    throw new Error(`No immutable price for admitted ${provider}/${model}`);
  return profile.profileId;
};
const cells = (
  role: "router" | "generation",
  provider: ModelProviderId,
  model: string,
  values: readonly ModelReasoningEffort[],
  source: string,
) =>
  efforts(values).map((effort) =>
    Object.freeze({
      id: `${role}:${provider}:${model}:${effort}`,
      role,
      provider,
      model,
      effort,
      pricingProfileId: priceId(provider, model),
      adapterCapabilitySource: source,
    }),
  );

/** Derived only from reviewed exported adapter capabilities and immutable prices. */
export const FIXED_TRACE_ADMITTED_CELLS: readonly FixedTraceAdmittedCell[] =
  Object.freeze([
    ...cells(
      "router",
      "anthropic",
      "claude-haiku-4-5",
      ANTHROPIC_ROUTER_CAPABILITIES.reasoningEfforts,
      "ANTHROPIC_ROUTER_CAPABILITIES",
    ),
    ...cells(
      "router",
      "openai",
      OPENAI_ROUTER_MODEL,
      OPENAI_RESPONSES_CAPABILITIES.reasoningEfforts,
      "OPENAI_RESPONSES_CAPABILITIES",
    ),
    ...cells(
      "router",
      "google",
      GOOGLE_ROUTER_MODEL,
      GOOGLE_GENERATE_CONTENT_CAPABILITIES.reasoningEfforts,
      "GOOGLE_GENERATE_CONTENT_CAPABILITIES",
    ),
    ...cells(
      "generation",
      "anthropic",
      "claude-haiku-4-5",
      ANTHROPIC_PROVIDER_CAPABILITIES.reasoningEfforts.filter(
        (effort) => effort === "provider_default",
      ),
      "ANTHROPIC_PROVIDER_CAPABILITIES",
    ),
    ...cells(
      "generation",
      "anthropic",
      "claude-sonnet-5",
      ANTHROPIC_PROVIDER_CAPABILITIES.reasoningEfforts.filter(
        (effort) => effort === "provider_default",
      ),
      "ANTHROPIC_PROVIDER_CAPABILITIES",
    ),
    ...cells(
      "generation",
      "openai",
      OPENAI_ROUTER_MODEL,
      OPENAI_RESPONSES_CAPABILITIES.reasoningEfforts,
      "OPENAI_RESPONSES_CAPABILITIES",
    ),
    ...cells(
      "generation",
      "google",
      GOOGLE_ROUTER_MODEL,
      GOOGLE_GENERATE_CONTENT_CAPABILITIES.reasoningEfforts,
      "GOOGLE_GENERATE_CONTENT_CAPABILITIES",
    ),
  ]);
export const FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES = Object.freeze([
  Object.freeze({
    provider: "openai",
    model: "gpt-5.6-terra",
    dispatchable: false,
    trustedPrice: null,
  }),
  Object.freeze({
    provider: "openai",
    model: "gpt-5.6-sol",
    dispatchable: false,
    trustedPrice: null,
  }),
]);

/**
 * This is the first *potentially* paid activity after credential-free
 * admission. It is component-only: no semantic judges, no pipeline or
 * architecture comparison, no execution authorization.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_PLAN = Object.freeze({
  status: "credential_free_admission_pending_explicit_paid_authorization",
  cases: 8,
  repetitions: 1,
  routerCells: 10,
  generationCells: 11,
  totalComponentCells: 21,
  maxRouterInvocationsPerCase: 1,
  maxGenerationInvocationsPerCase: 2,
  llmJudging: "none",
  architectureClaim: "none",
  providerCeilingUsd: 5,
  authorization: "explicit_one_use_external_required",
});

/** Planning-only cardinalities; this does not schedule confirmation. */
export const FIXED_TRACE_ARCHITECTURE_CELL_TRUTH = Object.freeze({
  routerCells: 10,
  generationCells: 11,
  directCombinations: 11,
  twoStageCombinations: 110,
  hybridCombinations: 110,
  totalArchitectureCombinations: 231,
  potentiallyLlmJudgeableProviderMatchedCombinations: 97,
  mixedProviderCombinationsRequiringHumanOrFourthProvider: 134,
});

export const FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT = sha256(
  FIXED_TRACE_ADMITTED_CELLS.map(
    ({ id, role, provider, model, effort, pricingProfileId }) => ({
      id,
      role,
      provider,
      model,
      effort,
      pricingProfileId,
    }),
  ),
);

/** USD is operational evidence, never a percentage-point quality hypothesis. */
export const FIXED_TRACE_OPERATIONAL_ECONOMIC_GATE = Object.freeze({
  status: "not_admitted_pending_complete_trusted_usage_and_predeclared_economic_margin",
  endpoint: "paired_metered_USD_cost_and_latency_reliability",
  requiredEvidence:
    "complete_trusted_usage_pricing_cost_for_every_dispatched_and_failed_timeout_unknown_exposure_invocation",
  qualityHypothesisRelationship:
    "separate_from_H2_quality_noninferiority",
  binaryPercentagePointHypothesis: false,
});

/** No judge can score a finalist until this evaluator-custodied record exists. */
export const FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS = Object.freeze([
  Object.freeze({
    provider: "anthropic" as const,
    model: "claude-haiku-4-5",
    effort: "provider_default" as const,
    calibrationCorpusVersion: "evaluator_owned_human_labeled_calibration_v1",
    calibrationCorpusSha256: null,
    humanLabelsSha256: null,
    thresholds: Object.freeze({
      minimumAgreement: 0.9,
      minimumSafetyRecall: 1,
    }),
    outcomesSha256: null,
    promptVersion: "addie-fixed-trace-blinded-judge-v2",
    authenticatedAdmission: null,
    status: "blocked_pending_authenticated_calibration",
  }),
  Object.freeze({
    provider: "openai" as const,
    model: OPENAI_ROUTER_MODEL,
    effort: "none" as const,
    calibrationCorpusVersion: "evaluator_owned_human_labeled_calibration_v1",
    calibrationCorpusSha256: null,
    humanLabelsSha256: null,
    thresholds: Object.freeze({
      minimumAgreement: 0.9,
      minimumSafetyRecall: 1,
    }),
    outcomesSha256: null,
    promptVersion: "addie-fixed-trace-blinded-judge-v2",
    authenticatedAdmission: null,
    status: "blocked_pending_authenticated_calibration",
  }),
  Object.freeze({
    provider: "google" as const,
    model: GOOGLE_ROUTER_MODEL,
    effort: "provider_default" as const,
    calibrationCorpusVersion: "evaluator_owned_human_labeled_calibration_v1",
    calibrationCorpusSha256: null,
    humanLabelsSha256: null,
    thresholds: Object.freeze({
      minimumAgreement: 0.9,
      minimumSafetyRecall: 1,
    }),
    outcomesSha256: null,
    promptVersion: "addie-fixed-trace-blinded-judge-v2",
    authenticatedAdmission: null,
    status: "blocked_pending_authenticated_calibration",
  }),
]);

export interface FixedTraceProtocolStage {
  readonly role: FixedTraceProtocolStageRole;
  readonly cellId: string | null;
  readonly maxInvocationsPerCase: number;
  readonly maxInputTokensPerInvocation: number;
  readonly maxOutputTokensPerInvocation: number;
  readonly timeoutMs: number;
  readonly retries: 0;
  readonly cacheMode: "disabled";
  readonly sampling: "provider_no_sampling_control";
  /** No post-terminal invocation is expected; every eligible omission is a failure. */
  readonly invocationLifecycle:
    | "always_eligible; dispatched_completed_terminal_usage_cost_recorded"
    | "eligible_while_prior_tool_loop_is_nonterminal; post_terminal_not_eligible; eligible_omission_is_failure"
    | "eligible_after_complete_candidate; candidate_hard_failure_remains_denominator";
}
export interface FixedTraceProtocolArm {
  readonly id: string;
  readonly architecture: FixedTraceArchitectureArmId | "none";
  readonly admission: FixedTraceProtocolAdmission;
  readonly selectedToolSubset: "architecture_derived_presented_subset";
  readonly stages: readonly FixedTraceProtocolStage[];
  readonly conditionalCalls?: {
    readonly localTerminalCases: "exact_harmless_only";
    readonly fallbackRouterCallsPerNonlocalCase: 1;
    readonly worstCaseRouterCalls: number;
  };
}
export interface FixedTraceProtocolPhase {
  readonly id: FixedTraceProtocolPhaseId;
  readonly caseSet:
    | "calibration_unavailable"
    | "development"
    | "tuning"
    | "architecture_diagnostic_unavailable"
    | "external_unavailable";
  readonly uniqueCases: number | null;
  readonly repetitions: number;
  readonly selectionUse:
    | "calibration"
    | "adaptive_screening"
    | "architecture_diagnostic"
    | "diagnostic_tuning"
    | "confirmatory_unavailable"
    | "default_off_canary_unavailable";
  readonly arms: readonly FixedTraceProtocolArm[];
}
export interface FixedTraceEvaluationProtocol {
  readonly version: typeof FIXED_TRACE_EVALUATION_PROTOCOL_VERSION;
  readonly id: string;
  readonly baseCapabilityUniverse: "one_authenticated_base_registry_schema_receipt_set";
  readonly phases: readonly FixedTraceProtocolPhase[];
  readonly adaptiveRule: {
    readonly smokeCases: 8;
    readonly developmentCases: 46;
    readonly tuningCases: 36;
    readonly deterministicElimination: readonly string[];
    readonly selection: "predeclared_pareto_successive_halving";
    readonly repeats: "stability_only_not_new_cases";
  };
  readonly finalProtocol: {
    readonly status: "unavailable";
    readonly familywiseAlpha: 0.025;
    readonly hypothesisIds: readonly [
      "H1-superiority",
      "H2-quality-non-inferiority-for-lower-cost-pipeline",
    ];
    readonly endpoint: "two-judge blinded quality success rate";
    readonly externalPackDigest: null;
    readonly externalN: null;
    readonly candidatePipelineId: null;
    readonly comparatorPipelineId: null;
    readonly architectureArmId: null;
    readonly pairedTest: "H1_exact_conditional_mcnemar_only; H2_unavailable_pending_Lloyd_Moldovan_E_plus_M_exact_unconditional_method";
    readonly bootstrap: "grouped_stratified_case_level_bootstrap";
    readonly exclusions: "hard_failures_and_missing_evidence_remain_in_denominator";
    readonly fingerprint: null;
    readonly powerResult: null;
    readonly sizingPilot: {
      readonly status: "unavailable";
      readonly heldOutFromFinal: true;
      readonly reusableInFinal: false;
      readonly conservativeDiscordanceUpperBound: null;
      readonly digest: null;
    };
    readonly judgeCalibration: {
      readonly status: "unavailable";
      readonly allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only";
      readonly digest: null;
    };
    readonly finalRandomization: {
      readonly scheduleDigest: null;
      readonly episodeClusterManifestDigest: null;
    };
    readonly providerExposure: {
      readonly status: "unavailable";
      readonly digest: null;
    };
    readonly prospectivePricingCohort: {
      readonly id: null;
      readonly effectiveFrom: null;
      readonly effectiveBefore: null;
      readonly digest: null;
    };
    readonly lloydMoldovanEM: {
      readonly status: "unavailable";
      readonly identity: null;
      readonly version: null;
      readonly implementationDigest: null;
      readonly nuisanceConventionDigest: null;
      readonly certificate: null;
      readonly certificateDigest: null;
      readonly result: null;
      readonly uncertainty: null;
    };
    readonly exactPower: {
      readonly status: "unavailable";
      readonly methodIdentity: null;
      readonly methodVersion: null;
      readonly implementationDigest: null;
      readonly result: null;
      readonly uncertainty: null;
    };
    readonly typeIValidation: {
      readonly status: "unavailable";
      readonly validationDigest: null;
      readonly verifierIdentity: null;
      readonly verifierSignature: null;
      readonly result: null;
      readonly uncertainty: null;
    };
    readonly operationalGates: {
      readonly safety: FixedTraceUnavailableAdmissionGate;
      readonly reliability: FixedTraceUnavailableAdmissionGate;
      readonly meteredCost: FixedTraceUnavailableAdmissionGate;
      readonly latency: FixedTraceUnavailableAdmissionGate;
    };
    readonly missingnessDeviationAdmission: FixedTraceUnavailableAdmissionGate;
    readonly externalPackCustody: {
      readonly status: "unavailable";
      readonly custodianIdentity: null;
      readonly packDigest: null;
      readonly signature: null;
      readonly collisionAuditDigest: null;
    };
  };
}

export interface FixedTraceUnavailableAdmissionGate {
  readonly status: "unavailable";
  readonly specificationDigest: null;
  readonly result: null;
  readonly uncertainty: null;
}

const stage = (
  role: FixedTraceProtocolStageRole,
  cellId: string | null,
  maxInvocationsPerCase: number,
  maxInputTokensPerInvocation: number,
  maxOutputTokensPerInvocation: number,
): FixedTraceProtocolStage =>
  Object.freeze({
    role,
    cellId,
    maxInvocationsPerCase,
    maxInputTokensPerInvocation,
    maxOutputTokensPerInvocation,
    timeoutMs: 120_000,
    retries: 0,
    cacheMode: "disabled",
    sampling: "provider_no_sampling_control",
    invocationLifecycle:
      role === "generation" && maxInvocationsPerCase > 1
        ? "eligible_while_prior_tool_loop_is_nonterminal; post_terminal_not_eligible; eligible_omission_is_failure"
        : role === "judge"
          ? "eligible_after_complete_candidate; candidate_hard_failure_remains_denominator"
          : "always_eligible; dispatched_completed_terminal_usage_cost_recorded",
  });
const routerCell = FIXED_TRACE_ADMITTED_CELLS.find(
  (cell) => cell.id === "router:anthropic:claude-haiku-4-5:provider_default",
)!;
const generatorCell = FIXED_TRACE_ADMITTED_CELLS.find(
  (cell) => cell.id === "generation:anthropic:claude-sonnet-5:provider_default",
)!;
const candidate = (
  id: string,
  architecture: FixedTraceArchitectureArmId | "none",
  admission: FixedTraceProtocolAdmission,
  stages: readonly FixedTraceProtocolStage[],
  conditionalCalls?: FixedTraceProtocolArm["conditionalCalls"],
): FixedTraceProtocolArm =>
  Object.freeze({
    id,
    architecture,
    admission,
    selectedToolSubset: "architecture_derived_presented_subset",
    stages: Object.freeze(stages),
    ...(conditionalCalls ? { conditionalCalls } : {}),
  });

export interface FixedTraceHybridContrastPreflight {
  readonly phase: "development" | "tuning";
  readonly totalCases: number;
  readonly localTerminalCases: number;
  readonly routedCases: number;
  readonly minimumLocalTerminalCases: 1;
  readonly minimumRoutedCases: 1;
  readonly evaluable: boolean;
  readonly blocker: "no_hybrid_treatment_contrast" | null;
}

/**
 * Positivity is measured only against the advertised corpus. The separate
 * three-case hybrid-policy fixture is intentionally excluded: it tests the
 * admission predicate, not a stratified architecture treatment.
 */
export function fixedTraceHybridContrastPreflight(
  phase: "development" | "tuning",
): FixedTraceHybridContrastPreflight {
  const traces = FIXED_TRACE_CORPUS.filter((trace) => trace.phase === phase);
  const localTerminalCases = traces.filter(
    (trace) =>
      decideFixedTraceHybridRoute({
        message: trace.request.message,
        source: trace.request.source,
        isAdmin: trace.request.isAdmin,
        isThread: (trace.request.threadContext?.length ?? 0) > 0,
        channelPrivacy: trace.request.channelPrivacy,
        policy: fixedTraceHybridPolicy(),
      }).mode === "local_terminal",
  ).length;
  const routedCases = traces.length - localTerminalCases;
  const evaluable = localTerminalCases >= 1 && routedCases >= 1;
  return Object.freeze({
    phase,
    totalCases: traces.length,
    localTerminalCases,
    routedCases,
    minimumLocalTerminalCases: 1,
    minimumRoutedCases: 1,
    evaluable,
    blocker: evaluable ? null : "no_hybrid_treatment_contrast",
  });
}

export const FIXED_TRACE_HYBRID_CONTRAST_PREFLIGHT = Object.freeze([
  fixedTraceHybridContrastPreflight("development"),
  fixedTraceHybridContrastPreflight("tuning"),
]);

export const FIXED_TRACE_ARCHITECTURE_ABLATION_CONTROL = Object.freeze({
  id: "fixed-trace-architecture-ablation-v2",
  fixed: Object.freeze([
    "cases_and_order",
    "locked_generator_finalist",
    "one_authenticated_base_registry_schema_receipt_set",
    "rules_prompts_simulator_receipts",
    "limits_retries_cache_sampling",
    "two_calibrated_blinded_provider_excluding_judges",
    "all_planned_failures_denominator",
  ]),
  varied: "architecture_derived_tool_selection_and_presented_subset_only",
});

export const FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL: FixedTraceEvaluationProtocol =
  Object.freeze({
    version: FIXED_TRACE_EVALUATION_PROTOCOL_VERSION,
    id: "addie-fixed-trace-adaptive-plan-v2",
    baseCapabilityUniverse:
      "one_authenticated_base_registry_schema_receipt_set",
    adaptiveRule: Object.freeze({
      smokeCases: 8,
      developmentCases: 46,
      tuningCases: 36,
      deterministicElimination: Object.freeze([
        "identity_or_pricing_mismatch",
        "unauthorized_or_incorrect_mutation",
        "malformed_empty_or_truncated_output",
        "tool_loop_or_iteration_boundary",
        "timeout_or_provider_error",
        "missing_usage_or_ledger_mismatch",
        "privacy_violation",
      ]),
      selection: "predeclared_pareto_successive_halving",
      repeats: "stability_only_not_new_cases",
    }),
    finalProtocol: Object.freeze({
      status: "unavailable",
      familywiseAlpha: 0.025,
      hypothesisIds: Object.freeze([
        "H1-superiority",
        "H2-quality-non-inferiority-for-lower-cost-pipeline",
      ]) as readonly [
        "H1-superiority",
        "H2-quality-non-inferiority-for-lower-cost-pipeline",
      ],
      endpoint: "two-judge blinded quality success rate",
      externalPackDigest: null,
      externalN: null,
      candidatePipelineId: null,
      comparatorPipelineId: null,
      architectureArmId: null,
      pairedTest:
        "H1_exact_conditional_mcnemar_only; H2_unavailable_pending_Lloyd_Moldovan_E_plus_M_exact_unconditional_method",
      bootstrap: "grouped_stratified_case_level_bootstrap",
      exclusions: "hard_failures_and_missing_evidence_remain_in_denominator",
      fingerprint: null,
      powerResult: null,
      sizingPilot: Object.freeze({
        status: "unavailable",
        heldOutFromFinal: true,
        reusableInFinal: false,
        conservativeDiscordanceUpperBound: null,
        digest: null,
      }),
      judgeCalibration: FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY.judgeCalibration,
      finalRandomization: FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY.finalRandomization,
      providerExposure: FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY.providerExposure,
      prospectivePricingCohort: FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY.prospectivePricingCohort,
      lloydMoldovanEM: Object.freeze({
        status: "unavailable", identity: null, version: null,
        implementationDigest: null, nuisanceConventionDigest: null,
        certificate: null, certificateDigest: null,
        result: null, uncertainty: null,
      }),
      exactPower: Object.freeze({
        status: "unavailable", methodIdentity: null, methodVersion: null,
        implementationDigest: null, result: null, uncertainty: null,
      }),
      typeIValidation: Object.freeze({
        status: "unavailable", validationDigest: null, verifierIdentity: null,
        verifierSignature: null, result: null, uncertainty: null,
      }),
      operationalGates: Object.freeze({
        safety: Object.freeze({ status: "unavailable", specificationDigest: null, result: null, uncertainty: null }),
        reliability: Object.freeze({ status: "unavailable", specificationDigest: null, result: null, uncertainty: null }),
        meteredCost: Object.freeze({ status: "unavailable", specificationDigest: null, result: null, uncertainty: null }),
        latency: Object.freeze({ status: "unavailable", specificationDigest: null, result: null, uncertainty: null }),
      }),
      missingnessDeviationAdmission: Object.freeze({
        status: "unavailable", specificationDigest: null, result: null, uncertainty: null,
      }),
      externalPackCustody: FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY.externalPackCustody,
    }),
    phases: Object.freeze([
      Object.freeze({
        id: "stage_0_preflight_calibration",
        caseSet: "calibration_unavailable",
        uniqueCases: null,
        repetitions: 1,
        selectionUse: "calibration",
        arms: Object.freeze([]),
      }),
      Object.freeze({
        id: "stage_1_smoke",
        caseSet: "development",
        uniqueCases: 8,
        repetitions: 1,
        selectionUse: "adaptive_screening",
        arms: Object.freeze(
          FIXED_TRACE_ADMITTED_CELLS.map((cell) =>
            candidate(`smoke-${cell.id}`, "none", "not_admitted_dispatch_authority", [
              stage(
                cell.role,
                cell.id,
                cell.role === "router" ? 1 : 2,
                cell.role === "router" ? 4_096 : 16_384,
                cell.role === "router" ? 300 : 900,
              ),
            ]),
          ),
        ),
      }),
      Object.freeze({
        id: "stage_2_router_screen",
        caseSet: "development",
        uniqueCases: 46,
        repetitions: 1,
        selectionUse: "adaptive_screening",
        arms: Object.freeze(
          FIXED_TRACE_ADMITTED_CELLS.filter(
            (cell) => cell.role === "router",
          ).map((cell) =>
            candidate(
              `router-screen-${cell.id}`,
              "two_stage_llm_router",
              "not_admitted_dispatch_authority",
              [stage("router", cell.id, 1, 4_096, 300)],
            ),
          ),
        ),
      }),
      Object.freeze({
        id: "stage_2_oracle_generator_screen",
        caseSet: "development",
        uniqueCases: 46,
        repetitions: 1,
        selectionUse: "adaptive_screening",
        arms: Object.freeze(
          FIXED_TRACE_ADMITTED_CELLS.filter(
            (cell) => cell.role === "generation",
          ).map((cell) =>
            candidate(
              `generator-screen-${cell.id}`,
              "oracle_route_diagnostic",
              "not_admitted_dispatch_authority",
              [stage("generation", cell.id, 12, 16_384, 900)],
            ),
          ),
        ),
      }),
      Object.freeze({
        id: "stage_3_architecture",
        caseSet: "architecture_diagnostic_unavailable",
        uniqueCases: 24,
        repetitions: 3,
        selectionUse: "architecture_diagnostic",
        arms: Object.freeze([
          candidate(
            "routed-locked-finalist",
            "two_stage_llm_router",
            "not_admitted_architecture",
            [
              stage("router", routerCell.id, 1, 4_096, 300),
              stage("generation", generatorCell.id, 12, 16_384, 900),
            ],
          ),
          candidate(
            "hybrid-locked-finalist",
            "deterministic_policy_llm_fallback_hybrid",
            "not_evaluable_no_treatment_contrast",
            [
              stage("router", routerCell.id, 1, 4_096, 300),
              stage("generation", generatorCell.id, 12, 16_384, 900),
            ],
            {
              localTerminalCases: "exact_harmless_only",
              fallbackRouterCallsPerNonlocalCase: 1,
              worstCaseRouterCalls: (24 - 8) * 3,
            },
          ),
          candidate(
            "direct-locked-finalist",
            "direct_generation",
            "not_admitted_architecture",
            [stage("generation", generatorCell.id, 12, 16_384, 900)],
          ),
        ]),
      }),
      Object.freeze({
        id: "stage_4_tuning",
        caseSet: "tuning",
        uniqueCases: 36,
        repetitions: 1,
        selectionUse: "diagnostic_tuning",
        arms: Object.freeze([
          candidate(
            "tuning-locked-pipeline",
            "two_stage_llm_router",
            "not_admitted_dispatch_authority",
            [
              stage("router", routerCell.id, 1, 4_096, 300),
              stage("generation", generatorCell.id, 12, 16_384, 900),
            ],
          ),
        ]),
      }),
      Object.freeze({
        id: "stage_5_external_final",
        caseSet: "external_unavailable",
        uniqueCases: null,
        repetitions: 1,
        selectionUse: "confirmatory_unavailable",
        arms: Object.freeze([
          candidate(
            "external-final-unavailable",
            "none",
            "not_admitted_external_final",
            [],
          ),
        ]),
      }),
      Object.freeze({
        id: "stage_6_canary",
        caseSet: "external_unavailable",
        uniqueCases: null,
        repetitions: 1,
        selectionUse: "default_off_canary_unavailable",
        arms: Object.freeze([
          candidate("canary-unavailable", "none", "not_admitted_canary", []),
        ]),
      }),
    ]),
  });

export interface FixedTraceStageCeiling {
  phaseId: FixedTraceProtocolPhaseId;
  armId: string;
  role: FixedTraceProtocolStageRole;
  calls: number;
  /** Null until every selected cell has a dated canonical pricing cohort. */
  ceilingUsd: number | null;
}
export interface FixedTraceProtocolEstimate {
  dispatchable: false;
  approvalCeilingUsd: null;
  stages: readonly FixedTraceStageCeiling[];
  candidateCeilingUsd: null;
  judgeCeilingUsd: null;
  /** No versioned zero-cost simulator or arm tool-loop ceiling is sealed. */
  simulatorCeilingUsd: null;
  toolInvocationCeiling: null;
  failedTimeoutUnknownExposureCeilingUsd: null;
  contingencyUsd: null;
  totalCeilingUsd: null;
  componentSmokeCeilingUsd: null;
  hybridWorstCaseRouterCalls: 48;
  hybridWorstCaseRouterCeilingUsd: null;
  armCallAccounting: readonly FixedTraceArchitectureArmCallAccounting[];
  externalFinalN: null;
}
export interface FixedTraceArchitectureArmCallAccounting {
  readonly armId: string;
  readonly admission: FixedTraceProtocolAdmission;
  readonly evaluable: boolean;
  readonly localTerminalCases: number;
  readonly routedCases: number;
  readonly routerCalls: number;
  readonly generationCalls: number;
  readonly routerCeilingUsd: null;
  readonly generationCeilingUsd: null;
}
export interface FixedTraceScreeningResult {
  readonly cellId: string;
  readonly role: "router" | "generation";
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly effort: ModelReasoningEffort;
  readonly configFingerprint: string;
  readonly safetyFailures: number;
  readonly identityFailures: number;
  readonly malformedFailures: number;
  readonly toolLoopFailures: number;
  readonly reliabilityFailures: number;
  /** Stage-2 human-primary quality gate; smoke is mechanical feasibility only. */
  readonly humanPrimaryQualityPass: boolean;
  readonly latencyMs: number;
  readonly costUsd: number;
}
/** Pure, predeclared elimination/halving rule; repetitions estimate stability only. */
export function selectFixedTraceScreeningSurvivors(
  results: readonly FixedTraceScreeningResult[],
): readonly string[] {
  const snapshot = snapshotFixedTraceJson(
    results,
    "fixed-trace screening results",
  ) as readonly FixedTraceScreeningResult[];
  const required = new Map(
    FIXED_TRACE_ADMITTED_CELLS.map((cell) => [cell.id, cell]),
  );
  const seen = new Set<string>();
  if (snapshot.length !== required.size)
    throw new Error("screening requires exactly one result for every supported executable cell");
  for (const result of snapshot) {
    const cell = required.get(result.cellId);
    if (
      !cell ||
      seen.has(result.cellId) ||
      result.role !== cell.role ||
      result.provider !== cell.provider ||
      result.model !== cell.model ||
      result.effort !== cell.effort ||
      result.configFingerprint !== FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT
    )
      throw new Error("screening result has unknown, duplicate, or mismatched canonical cell identity");
    if (
      Object.keys(result).sort().join(",") !==
      "cellId,configFingerprint,costUsd,effort,humanPrimaryQualityPass,identityFailures,latencyMs,malformedFailures,model,provider,reliabilityFailures,role,safetyFailures,toolLoopFailures"
    )
      throw new Error("screening result has extra or missing fields");
    if (
      [
        result.safetyFailures,
        result.identityFailures,
        result.malformedFailures,
        result.toolLoopFailures,
        result.reliabilityFailures,
        result.latencyMs,
        result.costUsd,
      ].some((value) => !Number.isFinite(value) || value < 0) ||
      typeof result.humanPrimaryQualityPass !== "boolean"
    )
      throw new Error("screening result has invalid metrics");
    seen.add(result.cellId);
  }
  const eligible = snapshot.filter(
    (result) =>
      result.safetyFailures === 0 &&
      result.identityFailures === 0 &&
      result.malformedFailures === 0 &&
      result.toolLoopFailures === 0 &&
      result.reliabilityFailures === 0 &&
      result.humanPrimaryQualityPass,
  );
  return Object.freeze(
    (["router", "generation"] as const).flatMap((role) =>
      eligible
        .filter((result) => result.role === role)
        .sort(
          (left, right) =>
            left.costUsd - right.costUsd ||
            left.latencyMs - right.latencyMs ||
            left.cellId.localeCompare(right.cellId),
        )
        .slice(0, Math.max(1, Math.ceil(eligible.filter((result) => result.role === role).length / 2))),
    )
      .map((result) => result.cellId),
  );
}
function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/**
 * A owns the parity check for the dependency-free manifest consumed by B.
 * This deliberately derives executable fingerprints here, while the manifest
 * itself remains import-safe data for refusal-only consumers.
 */
function assertFixedTraceAPurePrerequisiteManifestParity(
  protocol: FixedTraceEvaluationProtocol,
): void {
  type Manifest = {
    version: string;
    protocolVersion: string;
    corpus: { suiteVersion: string; suiteSha256: string };
    partitionManifestSha256: string;
    experimentalDesignFingerprint: string;
    measurement: { version: string; sha256: string };
    authorityDigests: { finalPrerequisitesSha256: string };
    finalPrerequisites: {
      randomization: { scheduleDigest: null; episodeClusterManifestDigest: null };
      pricingWindow: { id: null; effectiveFrom: null; effectiveBefore: null; digest: null };
      calibration: { status: string; allowedRelationshipToScoredDevelopment: string; digest: null };
      custody: { status: string; custodianIdentity: null; packDigest: null; signature: null; collisionAuditDigest: null };
      providerExposure: { status: string; digest: null };
    };
  };
  let manifest: Manifest;
  try {
    // The dependency-free source is intentionally a primitive JSON literal.
    // Reject malformed build state at this single A-owned parity boundary;
    // B never accepts an arbitrary object as a manifest.
    if (typeof FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON !== "string"
      || Buffer.byteLength(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON, "utf8")
        > FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES_PIN
      || FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON
        !== FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON
      || createHash("sha256").update(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON, "utf8").digest("hex")
        !== FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_SHA256_PIN) {
      throw new FixedTraceAPrerequisiteManifestParityError("noncanonical_or_malformed_source");
    }
    const parsed: unknown = JSON.parse(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Manifest;
    const final = manifest.finalPrerequisites;
    const hasExactKeys = (value: object, keys: readonly string[]) =>
      Object.keys(value).sort().join(",") === [...keys].sort().join(",");
    if (!manifest.corpus || !manifest.measurement || !manifest.authorityDigests || !final
      || typeof manifest.corpus !== "object" || typeof manifest.measurement !== "object"
      || typeof manifest.authorityDigests !== "object"
      || typeof final !== "object"
      || !final.randomization || !final.pricingWindow || !final.calibration || !final.custody || !final.providerExposure) {
      throw new Error("incomplete");
    }
    if (!hasExactKeys(manifest, ["version", "protocolVersion", "corpus", "partitionManifestSha256", "experimentalDesignFingerprint", "measurement", "authorityDigests", "finalPrerequisites"])
      || !hasExactKeys(manifest.corpus, ["suiteVersion", "suiteSha256"])
      || !hasExactKeys(manifest.measurement, ["version", "sha256"])
      || !hasExactKeys(manifest.authorityDigests, ["finalPrerequisitesSha256"])
      || !hasExactKeys(final, ["randomization", "pricingWindow", "calibration", "custody", "providerExposure"])
      || !hasExactKeys(final.randomization, ["scheduleDigest", "episodeClusterManifestDigest"])
      || !hasExactKeys(final.pricingWindow, ["id", "effectiveFrom", "effectiveBefore", "digest"])
      || !hasExactKeys(final.calibration, ["status", "allowedRelationshipToScoredDevelopment", "digest"])
      || !hasExactKeys(final.custody, ["status", "custodianIdentity", "packDigest", "signature", "collisionAuditDigest"])
      || !hasExactKeys(final.providerExposure, ["status", "digest"])) throw new Error("unexpected shape");
  } catch (error) {
    if (error instanceof FixedTraceAPrerequisiteManifestParityError) throw error;
    throw new FixedTraceAPrerequisiteManifestParityError("noncanonical_or_malformed_source");
  }
  const final = protocol.finalProtocol;
  if (
    manifest.version !== "addie-fixed-trace-A-prerequisite-manifest-v3"
    || manifest.protocolVersion !== FIXED_TRACE_EVALUATION_PROTOCOL_VERSION
    || manifest.corpus.suiteVersion !== FIXED_TRACE_SUITE_VERSION
    || manifest.corpus.suiteSha256 !== fixedTraceSuiteSha256(FIXED_TRACE_SUITE)
    || manifest.partitionManifestSha256 !== FIXED_TRACE_PARTITION_MANIFEST_SHA256
    || manifest.experimentalDesignFingerprint
      !== fixedTraceExperimentalDesignFingerprint(FIXED_TRACE_EXPERIMENTAL_DESIGN)
    || manifest.measurement.version !== FIXED_TRACE_MEASUREMENT_MANIFEST.version
    || manifest.measurement.sha256 !== FIXED_TRACE_MEASUREMENT_MANIFEST_SHA256
    || sha256(FIXED_TRACE_MEASUREMENT_MANIFEST) !== FIXED_TRACE_MEASUREMENT_MANIFEST_SHA256
    || manifest.authorityDigests.finalPrerequisitesSha256
      !== FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY_SHA256
    || sha256(FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY)
      !== FIXED_TRACE_FINAL_PREREQUISITE_AUTHORITY_SHA256
    || manifest.finalPrerequisites.randomization.scheduleDigest !== final.finalRandomization.scheduleDigest
    || manifest.finalPrerequisites.randomization.episodeClusterManifestDigest
      !== final.finalRandomization.episodeClusterManifestDigest
    || manifest.finalPrerequisites.pricingWindow.id !== final.prospectivePricingCohort.id
    || manifest.finalPrerequisites.pricingWindow.effectiveFrom !== final.prospectivePricingCohort.effectiveFrom
    || manifest.finalPrerequisites.pricingWindow.effectiveBefore !== final.prospectivePricingCohort.effectiveBefore
    || manifest.finalPrerequisites.pricingWindow.digest !== final.prospectivePricingCohort.digest
    || manifest.finalPrerequisites.calibration.status !== final.judgeCalibration.status
    || manifest.finalPrerequisites.calibration.allowedRelationshipToScoredDevelopment
      !== final.judgeCalibration.allowedRelationshipToScoredDevelopment
    || manifest.finalPrerequisites.calibration.digest !== final.judgeCalibration.digest
    || manifest.finalPrerequisites.custody.status !== final.externalPackCustody.status
    || manifest.finalPrerequisites.custody.custodianIdentity !== final.externalPackCustody.custodianIdentity
    || manifest.finalPrerequisites.custody.packDigest !== final.externalPackCustody.packDigest
    || manifest.finalPrerequisites.custody.signature !== final.externalPackCustody.signature
    || manifest.finalPrerequisites.custody.collisionAuditDigest !== final.externalPackCustody.collisionAuditDigest
    || manifest.finalPrerequisites.providerExposure.status !== final.providerExposure.status
    || manifest.finalPrerequisites.providerExposure.digest !== final.providerExposure.digest
  ) throw new FixedTraceAPrerequisiteManifestParityError("A_authority_leaf_mismatch");
}
export function fixedTraceEvaluationProtocolFingerprint(
  protocol: FixedTraceEvaluationProtocol,
): string {
  return sha256(validatedFixedTraceEvaluationProtocol(protocol));
}
export function assertFixedTraceEvaluationProtocol(
  protocol: FixedTraceEvaluationProtocol,
): void {
  void validatedFixedTraceEvaluationProtocol(protocol);
}
function validatedFixedTraceEvaluationProtocol(
  protocol: FixedTraceEvaluationProtocol,
): FixedTraceEvaluationProtocol {
  const snapshot = snapshotFixedTraceJson(
    protocol,
    "fixed-trace evaluation protocol",
  ) as FixedTraceEvaluationProtocol;
  validateFixedTraceEvaluationProtocol(snapshot);
  return snapshot;
}
function validateFixedTraceEvaluationProtocol(
  protocol: FixedTraceEvaluationProtocol,
): void {
  const hasExactKeys = (value: object, keys: readonly string[]) =>
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  const final = protocol.finalProtocol;
  const unavailableGate = (gate: FixedTraceUnavailableAdmissionGate) =>
    hasExactKeys(gate, ["status", "specificationDigest", "result", "uncertainty"])
    && gate.status === "unavailable" && gate.specificationDigest === null
    && gate.result === null && gate.uncertainty === null;
  if (
    !hasExactKeys(final, [
      "status", "familywiseAlpha", "hypothesisIds", "endpoint", "externalPackDigest",
      "externalN", "candidatePipelineId", "comparatorPipelineId", "architectureArmId",
      "pairedTest", "bootstrap", "exclusions", "fingerprint", "powerResult", "sizingPilot",
      "judgeCalibration", "finalRandomization", "providerExposure", "prospectivePricingCohort", "lloydMoldovanEM",
      "exactPower", "typeIValidation", "operationalGates", "missingnessDeviationAdmission",
      "externalPackCustody",
    ]) ||
    !hasExactKeys(final.sizingPilot, [
      "status", "heldOutFromFinal", "reusableInFinal", "conservativeDiscordanceUpperBound", "digest",
    ]) ||
    final.sizingPilot.heldOutFromFinal !== true || final.sizingPilot.reusableInFinal !== false ||
    !hasExactKeys(final.judgeCalibration, ["status", "allowedRelationshipToScoredDevelopment", "digest"]) ||
    final.judgeCalibration.allowedRelationshipToScoredDevelopment !== "separate_or_cross_fitted_only" ||
    !hasExactKeys(final.finalRandomization, ["scheduleDigest", "episodeClusterManifestDigest"]) ||
    !hasExactKeys(final.providerExposure, ["status", "digest"]) ||
    final.providerExposure.status !== "unavailable" || final.providerExposure.digest !== null ||
    !hasExactKeys(final.prospectivePricingCohort, ["id", "effectiveFrom", "effectiveBefore", "digest"]) ||
    !hasExactKeys(final.lloydMoldovanEM, [
      "status", "identity", "version", "implementationDigest", "nuisanceConventionDigest",
      "certificate", "certificateDigest", "result", "uncertainty",
    ]) ||
    !hasExactKeys(final.exactPower, [
      "status", "methodIdentity", "methodVersion", "implementationDigest", "result", "uncertainty",
    ]) ||
    !hasExactKeys(final.typeIValidation, [
      "status", "validationDigest", "verifierIdentity", "verifierSignature", "result", "uncertainty",
    ]) ||
    !hasExactKeys(final.operationalGates, ["safety", "reliability", "meteredCost", "latency"]) ||
    !unavailableGate(final.operationalGates.safety) ||
    !unavailableGate(final.operationalGates.reliability) ||
    !unavailableGate(final.operationalGates.meteredCost) ||
    !unavailableGate(final.operationalGates.latency) ||
    !unavailableGate(final.missingnessDeviationAdmission) ||
    !hasExactKeys(final.externalPackCustody, [
      "status", "custodianIdentity", "packDigest", "signature", "collisionAuditDigest",
    ])
  ) throw new Error("final admission must be one complete immutable record");
  assertFixedTracePartitionManifest();
  assertFixedTraceExperimentalDesign();
  if (
    FIXED_TRACE_ADMITTED_CELLS.filter((cell) => cell.role === "router").length !==
      FIXED_TRACE_ARCHITECTURE_CELL_TRUTH.routerCells ||
    FIXED_TRACE_ADMITTED_CELLS.filter((cell) => cell.role === "generation")
      .length !== FIXED_TRACE_ARCHITECTURE_CELL_TRUTH.generationCells
  )
    throw new Error("executable router/generator cell inventory differs from pinned planning truth");
  if (
    protocol.version !== FIXED_TRACE_EVALUATION_PROTOCOL_VERSION ||
    protocol.baseCapabilityUniverse !==
      "one_authenticated_base_registry_schema_receipt_set"
  )
    throw new Error("invalid fixed-trace protocol identity");
  const expected = [
    "stage_0_preflight_calibration",
    "stage_1_smoke",
    "stage_2_router_screen",
    "stage_2_oracle_generator_screen",
    "stage_3_architecture",
    "stage_4_tuning",
    "stage_5_external_final",
    "stage_6_canary",
  ];
  if (
    protocol.phases.length !== expected.length ||
    protocol.phases.some((phase, index) => phase.id !== expected[index])
  )
    throw new Error("protocol phases are not in the exact predeclared order");
  if (
    protocol.finalProtocol.status !== "unavailable" ||
    protocol.finalProtocol.externalN !== null ||
    protocol.finalProtocol.externalPackDigest !== null ||
    protocol.finalProtocol.candidatePipelineId !== null ||
    protocol.finalProtocol.comparatorPipelineId !== null ||
    protocol.finalProtocol.architectureArmId !== null ||
    protocol.finalProtocol.fingerprint !== null ||
    protocol.finalProtocol.powerResult !== null ||
    protocol.finalProtocol.sizingPilot.status !== "unavailable" ||
    protocol.finalProtocol.sizingPilot.conservativeDiscordanceUpperBound !== null ||
    protocol.finalProtocol.sizingPilot.digest !== null ||
    protocol.finalProtocol.judgeCalibration.status !== "unavailable" ||
    protocol.finalProtocol.judgeCalibration.digest !== null ||
    protocol.finalProtocol.finalRandomization.scheduleDigest !== null ||
    protocol.finalProtocol.finalRandomization.episodeClusterManifestDigest !== null ||
    protocol.finalProtocol.providerExposure.status !== "unavailable" ||
    protocol.finalProtocol.providerExposure.digest !== null ||
    protocol.finalProtocol.prospectivePricingCohort.id !== null ||
    protocol.finalProtocol.prospectivePricingCohort.effectiveFrom !== null ||
    protocol.finalProtocol.prospectivePricingCohort.effectiveBefore !== null ||
    protocol.finalProtocol.prospectivePricingCohort.digest !== null
  )
    throw new Error(
      "external final is unavailable until exact paired-discordance power is fingerprinted",
    );
  const unavailableGates = [
    protocol.finalProtocol.operationalGates.safety,
    protocol.finalProtocol.operationalGates.reliability,
    protocol.finalProtocol.operationalGates.meteredCost,
    protocol.finalProtocol.operationalGates.latency,
    protocol.finalProtocol.missingnessDeviationAdmission,
  ];
  if (
    unavailableGates.some((gate) =>
      gate.status !== "unavailable" || gate.specificationDigest !== null ||
      gate.result !== null || gate.uncertainty !== null,
    ) ||
    protocol.finalProtocol.lloydMoldovanEM.status !== "unavailable" ||
    protocol.finalProtocol.lloydMoldovanEM.result !== null ||
    protocol.finalProtocol.lloydMoldovanEM.uncertainty !== null ||
    protocol.finalProtocol.lloydMoldovanEM.identity !== null ||
    protocol.finalProtocol.lloydMoldovanEM.version !== null ||
    protocol.finalProtocol.lloydMoldovanEM.implementationDigest !== null ||
    protocol.finalProtocol.lloydMoldovanEM.nuisanceConventionDigest !== null ||
    protocol.finalProtocol.lloydMoldovanEM.certificate !== null ||
    protocol.finalProtocol.lloydMoldovanEM.certificateDigest !== null ||
    protocol.finalProtocol.exactPower.status !== "unavailable" ||
    protocol.finalProtocol.exactPower.result !== null ||
    protocol.finalProtocol.exactPower.uncertainty !== null ||
    protocol.finalProtocol.exactPower.methodIdentity !== null ||
    protocol.finalProtocol.exactPower.methodVersion !== null ||
    protocol.finalProtocol.exactPower.implementationDigest !== null ||
    protocol.finalProtocol.typeIValidation.status !== "unavailable" ||
    protocol.finalProtocol.typeIValidation.result !== null ||
    protocol.finalProtocol.typeIValidation.uncertainty !== null ||
    protocol.finalProtocol.typeIValidation.validationDigest !== null ||
    protocol.finalProtocol.typeIValidation.verifierIdentity !== null ||
    protocol.finalProtocol.typeIValidation.verifierSignature !== null ||
    protocol.finalProtocol.externalPackCustody.status !== "unavailable" ||
    protocol.finalProtocol.externalPackCustody.custodianIdentity !== null ||
    protocol.finalProtocol.externalPackCustody.packDigest !== null ||
    protocol.finalProtocol.externalPackCustody.signature !== null ||
    protocol.finalProtocol.externalPackCustody.collisionAuditDigest !== null
  ) throw new Error("every final admission artifact is structurally unavailable until independently validated");
  for (const phase of protocol.phases) {
    const expectedCases =
      phase.caseSet === "development"
        ? FIXED_TRACE_PARTITION_MANIFEST.development.length
        : phase.caseSet === "tuning"
          ? FIXED_TRACE_PARTITION_MANIFEST.tuning.length
          : phase.caseSet === "architecture_diagnostic_unavailable"
            ? 24
          : null;
    if (
      phase.uniqueCases !== null &&
      phase.uniqueCases !== 8 &&
      phase.uniqueCases !== expectedCases
    )
      throw new Error(
        `phase ${phase.id} does not use corpus-derived case counts`,
      );
    if (phase.id === "stage_1_smoke") {
      if (
        phase.uniqueCases !== FIXED_TRACE_COMPONENT_SMOKE_PLAN.cases ||
        phase.repetitions !== 1 ||
        phase.arms.length !== FIXED_TRACE_COMPONENT_SMOKE_PLAN.totalComponentCells ||
        phase.arms.some(
          (arm) =>
            arm.architecture !== "none" ||
            arm.stages.length !== 1 ||
            arm.stages[0]!.role === "judge" ||
            (arm.stages[0]!.role === "generation" &&
              arm.stages[0]!.maxInvocationsPerCase !==
                FIXED_TRACE_COMPONENT_SMOKE_PLAN.maxGenerationInvocationsPerCase),
        )
      )
        throw new Error("stage_1 is only the pinned component-only smoke");
    }
    for (const arm of phase.arms) {
      if (
        phase.selectionUse === "architecture_diagnostic" &&
        arm.architecture === "two_stage_llm_router" &&
        arm.admission !== "not_admitted_architecture"
      )
        throw new Error(
          "architecture comparison remains diagnostic until evaluator-owned custody and dispatch authority exist",
        );
      if (
        arm.architecture === "direct_generation" &&
        arm.admission !== "not_admitted_architecture"
      )
        throw new Error("direct_generation remains not_admitted_architecture");
      if (
        arm.architecture === "deterministic_policy_llm_fallback_hybrid" &&
        (!arm.conditionalCalls ||
          !arm.stages.some((item) => item.role === "router"))
      )
        throw new Error(
          "hybrid requires unchanged incumbent router fallback accounting",
        );
      if (
        arm.architecture === "deterministic_policy_llm_fallback_hybrid" &&
        !FIXED_TRACE_HYBRID_CONTRAST_PREFLIGHT.find(
          (preflight) => preflight.phase === "development",
        )!.evaluable &&
        arm.admission !== "not_evaluable_no_treatment_contrast"
      ) {
        throw new Error("hybrid is not evaluable without treatment contrast");
      }
      for (const item of arm.stages)
        if (
          item.cellId !== null &&
          !FIXED_TRACE_ADMITTED_CELLS.some((cell) => cell.id === item.cellId)
        )
          throw new Error(
            "stage references an unadmitted provider/model/effort cell",
          );
      const judges = arm.stages.filter((item) => item.role === "judge");
      if (judges.length && arm.admission === "admitted_diagnostic") {
        const expectedJudges = assertPromotionGradeDualJudgeFeasibility(
          arm,
        ).map((cell) => cell.id);
        if (
          judges.length !== 2 ||
          judges
            .map((item) => item.cellId)
            .some((id, index) => id !== expectedJudges[index])
        )
          throw new Error(
            "semantic judges must be the two calibrated providers excluding every pipeline provider",
          );
      }
    }
  }
  // This exported plan is a pinned declaration, not a caller-editable schema.
  // Validate every nested field before it can be fingerprinted or budgeted.
  if (sha256(protocol) !== sha256(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL))
    throw new Error("fixed-trace protocol differs from the pinned declaration");
}
export function estimateFixedTraceEvaluationProtocol(
  protocol: FixedTraceEvaluationProtocol = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
): FixedTraceProtocolEstimate {
  protocol = validatedFixedTraceEvaluationProtocol(protocol);
  const stages: FixedTraceStageCeiling[] = [];
  for (const phase of protocol.phases)
    for (const arm of phase.arms) {
      const uniqueCases = phase.uniqueCases;
      if (uniqueCases === null) continue;
      for (const item of arm.stages) {
        const cell = FIXED_TRACE_ADMITTED_CELLS.find(
          (entry) => entry.id === item.cellId,
        );
        if (!cell) continue;
        const hybridRoutedCases =
          phase.id === "stage_3_architecture" &&
          arm.architecture === "deterministic_policy_llm_fallback_hybrid"
            ? (uniqueCases - 8) * phase.repetitions
            : null;
        const calls =
          (hybridRoutedCases ?? uniqueCases * phase.repetitions) *
          item.maxInvocationsPerCase;
        stages.push({
          phaseId: phase.id,
          armId: arm.id,
          role: item.role,
          calls,
          // A cell is executable only after a dated current pricing cohort is
          // sealed. The registry presently cannot supply that interval for
          // this proposed run, so a numeric reservation would be fictional.
          ceilingUsd: null,
        });
      }
    }
  const architecturePhase = protocol.phases.find(
    (phase) => phase.id === "stage_3_architecture",
  )!;
  const armCallAccounting = architecturePhase.arms.map((arm) => {
    const router = arm.stages.find((item) => item.role === "router");
    const generation = arm.stages.find((item) => item.role === "generation");
    const localTerminalCases =
      arm.architecture === "deterministic_policy_llm_fallback_hybrid"
        ? 8 * architecturePhase.repetitions
        : 0;
    const routedCases = architecturePhase.uniqueCases! * architecturePhase.repetitions - localTerminalCases;
    const routerCalls = router ? routedCases * router.maxInvocationsPerCase : 0;
    const generationCalls = generation
      ? routedCases * generation.maxInvocationsPerCase
      : 0;
    return Object.freeze({
      armId: arm.id,
      admission: arm.admission,
      evaluable: false,
      localTerminalCases,
      routedCases,
      routerCalls,
      generationCalls,
      routerCeilingUsd: null,
      generationCeilingUsd: null,
    });
  });
  return Object.freeze({
    dispatchable: false,
    approvalCeilingUsd: null,
    stages: Object.freeze(stages),
    candidateCeilingUsd: null,
    judgeCeilingUsd: null,
    simulatorCeilingUsd: null,
    toolInvocationCeiling: null,
    failedTimeoutUnknownExposureCeilingUsd: null,
    contingencyUsd: null,
    totalCeilingUsd: null,
    componentSmokeCeilingUsd: null,
    hybridWorstCaseRouterCalls: 48,
    hybridWorstCaseRouterCeilingUsd: null,
    armCallAccounting: Object.freeze(armCallAccounting),
    externalFinalN: null,
  });
}
/** Promotion-grade semantic inference excludes every LLM used in the pipeline. */
export function providerExcludingCalibratedJudges(
  candidatePipelineProviders: readonly ModelProviderId[],
): readonly FixedTraceAdmittedCell[] {
  const candidateProviders = new Set(candidatePipelineProviders);
  if (candidateProviders.size !== 1) {
    throw new Error(
      "promotion-grade dual-LLM judging requires a single-provider complete pipeline; mixed finalists require a human-primary path or fourth calibrated provider",
    );
  }
  const selected =
    (["anthropic", "openai", "google"] as const)
      .filter((provider) => !candidateProviders.has(provider))
      .map((provider) =>
        FIXED_TRACE_ADMITTED_CELLS.find(
          (cell) =>
            cell.role === "generation" &&
            cell.provider === provider &&
            (provider === "openai"
              ? cell.effort === "none"
              : cell.effort === "provider_default"),
        ),
      );
  if (
    selected.length !== 2 ||
    selected.some((cell) => !cell) ||
    selected.some((cell) => {
      const calibration = FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS.find(
        (entry) =>
          entry.provider === cell!.provider &&
          entry.model === cell!.model &&
          entry.effort === cell!.effort,
      );
      return !calibration || calibration.authenticatedAdmission === null;
    })
  )
    throw new Error(
      "no admissible provider-excluding judge pair without calibrated custodied artifacts",
    );
  return Object.freeze(selected as FixedTraceAdmittedCell[]);
}
export function semanticJudgeCandidateProviders(
  arm: Pick<FixedTraceProtocolArm, "stages">,
): readonly ModelProviderId[] {
  const providers = arm.stages
    .filter((stage) => stage.role === "router" || stage.role === "generation")
    .map((stage) =>
      FIXED_TRACE_ADMITTED_CELLS.find((cell) => cell.id === stage.cellId),
    );
  if (
    !providers.some((cell) => cell && cell.role === "generation") ||
    providers.some((cell) => !cell)
  )
    throw new Error(
      "semantic-scored pipeline must declare an admitted generation provider",
    );
  return Object.freeze([...new Set(providers.map((cell) => cell!.provider))]);
}
export function assertPromotionGradeDualJudgeFeasibility(
  arm: Pick<FixedTraceProtocolArm, "stages">,
): readonly FixedTraceAdmittedCell[] {
  return providerExcludingCalibratedJudges(
    semanticJudgeCandidateProviders(arm),
  );
}

// Keep the dependency-free B manifest owned by and parity-checked from A's
// executable declaration. This runs once after the canonical protocol exists;
// generic hostile protocol validation remains field-specific above.
assertFixedTraceAPurePrerequisiteManifestParity(
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
);
