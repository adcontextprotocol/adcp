import { createHash } from "node:crypto";
import { CLAUDE_PRICING_VERSION } from "../claude-pricing.js";
import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
  OPENAI_GPT_5_6_LUNA_PRICING,
} from "../model-cost-pricing.js";
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
  fixedTraceEstimatedCostUsd,
  validateFixedTracePricing,
  type FixedTraceBudgetPricing,
} from "./fixed-trace-budget.js";
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  assertFixedTracePartitionManifest,
} from "./fixed-trace-partition.js";
import { FIXED_TRACE_CORPUS } from "./fixed-trace-suite.js";

export const FIXED_TRACE_EVALUATION_PROTOCOL_VERSION =
  "addie-fixed-trace-evaluation-protocol-v2" as const;

export const FIXED_TRACE_CONFIRMATORY_POWER_GATE = Object.freeze({
  version: "addie-fixed-trace-confirmatory-power-v2",
  familywiseAlpha: 0.025,
  hypotheses: Object.freeze([
    Object.freeze({
      id: "H1-superiority",
      comparison: "locked-pipeline-candidate vs locked-pipeline-comparator",
      endpoint: "two-judge blinded success rate",
      direction: "greater",
      marginPercentagePoints: 0,
      alternativeDifferencePercentagePoints: 5,
      holmOneSidedAlpha: 0.0125,
      exactTest: "exact_conditional_mcnemar_zero_margin_only",
    }),
    Object.freeze({
      id: "H2-non-inferiority",
      comparison: "locked-pipeline-candidate vs locked-pipeline-comparator",
      endpoint: "two-judge blinded success rate",
      direction: "not_less_than",
      marginPercentagePoints: -3,
      alternativeDifferencePercentagePoints: 0,
      holmOneSidedAlpha: 0.025,
      exactTest: "predeclared_exact_unconditional_matched_pair_test_required",
    }),
  ]),
  test: "exact_paired_discordance_test",
  bootstrap: "grouped_stratified_case_level_bootstrap",
  exclusionRule: "hard_failures_and_missing_evidence_remain_in_denominator",
  repetitionsCountAsIndependentCases: false,
  superiorityRequiredIndependentEvaluableCases: 3_803,
  nonInferiorityRequiredIndependentEvaluableCases: 10_562,
  requiredIndependentEvaluableCases: 10_562,
  targetPower: 0.8,
  planningAlternative:
    "H1: +5pp over zero; H2: 0pp, three points above the -3pp NI margin",
  conservativeDiscordanceVarianceUpperBound: 1,
  externalFinalN: null,
  externalFinalStatus:
    "unavailable_pending_fingerprinted_exact_paired_discordance_power_result",
} as const);

/**
 * This is the complete schema of the final statistical admission. Values that
 * require independent custody are null, which is an executable refusal—not a
 * prose promise. The sizing pilot is held out and may never be reused in the
 * one-time final; repeated/template-related observations cluster by episode.
 */
export const FIXED_TRACE_CONFIRMATORY_ADMISSION = Object.freeze({
  status: "not_admitted_missing_fingerprinted_statistical_protocol",
  reasons: Object.freeze([
    "external_final_pack_unavailable",
    "held_out_sizing_pilot_and_conservative_discordance_bound_unavailable",
    "exact_unconditional_noninferiority_test_unavailable",
    "candidate_comparator_arm_identity_unavailable",
    "judge_calibration_must_be_separate_or_cross_fitted",
  ]),
  holm: Object.freeze({
    K: 2,
    oneSidedFamilyAlpha: 0.025,
    orderedAlphas: Object.freeze([0.0125, 0.025]),
  }),
  unitOfAnalysis: "unique_conversation_user_episode",
  repeatedAndTemplateRelatedObservationRule:
    "cluster_by_conversation_user_episode; repetitions_never_increase_N",
  sizingPilot: Object.freeze({
    status: "unavailable",
    heldOutFromFinal: true,
    reusableInFinal: false,
    conservativeDiscordanceUpperBound: null,
    digest: null,
  }),
  judgeCalibration: Object.freeze({
    status: "unavailable",
    allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only",
    digest: null,
  }),
  finalProtocolFingerprint: null,
  externalPackDigest: null,
  candidatePipelineId: null,
  comparatorPipelineId: null,
  architectureArmId: null,
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
  | "not_admitted_architecture"
  | "not_evaluable_no_treatment_contrast"
  | "not_admitted_external_final"
  | "not_admitted_canary";

export interface FixedTraceProtocolPricingProfile extends FixedTraceBudgetPricing {
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly version: string;
}

export const FIXED_TRACE_PROTOCOL_PRICING = Object.freeze([
  Object.freeze({
    provider: "anthropic" as const,
    model: "claude-haiku-4-5",
    version: CLAUDE_PRICING_VERSION,
    profileId: `${CLAUDE_PRICING_VERSION}:claude-haiku-4-5`,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    cacheReadUsdPerMillionTokens: 0.1,
    cacheWriteUsdPerMillionTokens: 1.25,
    cacheReadAccounting: "additive" as const,
    cacheWriteAccounting: "additive" as const,
    source: "Repository Anthropic reviewed pricing table, August 2026.",
  }),
  Object.freeze({
    provider: "anthropic" as const,
    model: "claude-sonnet-5",
    version: CLAUDE_PRICING_VERSION,
    profileId: `${CLAUDE_PRICING_VERSION}:claude-sonnet-5`,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cacheReadUsdPerMillionTokens: 0.3,
    cacheWriteUsdPerMillionTokens: 3.75,
    cacheReadAccounting: "additive" as const,
    cacheWriteAccounting: "additive" as const,
    source: "Repository Anthropic reviewed pricing table, August 2026.",
  }),
  Object.freeze({
    provider: "openai" as const,
    model: OPENAI_ROUTER_MODEL,
    version: OPENAI_GPT_5_6_LUNA_PRICING.profileId,
    ...OPENAI_GPT_5_6_LUNA_PRICING,
  }),
  Object.freeze({
    provider: "google" as const,
    model: GOOGLE_ROUTER_MODEL,
    version: GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
    profileId: GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 3.75,
    cacheReadUsdPerMillionTokens: 0.075,
    cacheWriteUsdPerMillionTokens: 0.75,
    cacheReadAccounting: "subset" as const,
    cacheWriteAccounting: "additive" as const,
    source:
      "Repository Google Gemini 3.7 Flash pricing pin through 2026-12-31.",
  }),
] satisfies readonly FixedTraceProtocolPricingProfile[]);

export interface FixedTraceAdmittedCell {
  readonly id: string;
  readonly role: "router" | "generation";
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly effort: ModelReasoningEffort;
  readonly pricingProfileId: string;
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
      ANTHROPIC_PROVIDER_CAPABILITIES.reasoningEfforts,
      "ANTHROPIC_PROVIDER_CAPABILITIES",
    ),
    ...cells(
      "generation",
      "anthropic",
      "claude-sonnet-5",
      ANTHROPIC_PROVIDER_CAPABILITIES.reasoningEfforts,
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

/** No judge can score a finalist until this evaluator-custodied record exists. */
export const FIXED_TRACE_JUDGE_CALIBRATION_REQUIREMENTS = Object.freeze([
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
  readonly caseSet: "development" | "tuning" | "external_unavailable";
  readonly uniqueCases: number | null;
  readonly repetitions: number;
  readonly selectionUse:
    | "calibration"
    | "adaptive_screening"
    | "architecture_selection"
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
    readonly hypothesisIds: readonly ["H1-superiority", "H2-non-inferiority"];
    readonly endpoint: "two-judge blinded success rate";
    readonly externalPackDigest: null;
    readonly externalN: null;
    readonly candidatePipelineId: null;
    readonly comparatorPipelineId: null;
    readonly architectureArmId: null;
    readonly pairedTest: "exact_paired_discordance_test";
    readonly bootstrap: "grouped_stratified_case_level_bootstrap";
    readonly exclusions: "hard_failures_and_missing_evidence_remain_in_denominator";
    readonly fingerprint: null;
    readonly powerResult: null;
  };
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
  });
const routerCell = FIXED_TRACE_ADMITTED_CELLS.find(
  (cell) => cell.id === "router:anthropic:claude-haiku-4-5:provider_default",
)!;
const generatorCell = FIXED_TRACE_ADMITTED_CELLS.find(
  (cell) => cell.id === "generation:anthropic:claude-sonnet-5:provider_default",
)!;
const judgeCells = Object.freeze([
  FIXED_TRACE_ADMITTED_CELLS.find(
    (cell) => cell.id === "generation:openai:gpt-5.6-luna:none",
  )!,
  FIXED_TRACE_ADMITTED_CELLS.find(
    (cell) => cell.id === "generation:google:gemini-3.7-flash:provider_default",
  )!,
]);
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
        "H2-non-inferiority",
      ]) as readonly ["H1-superiority", "H2-non-inferiority"],
      endpoint: "two-judge blinded success rate",
      externalPackDigest: null,
      externalN: null,
      candidatePipelineId: null,
      comparatorPipelineId: null,
      architectureArmId: null,
      pairedTest: "exact_paired_discordance_test",
      bootstrap: "grouped_stratified_case_level_bootstrap",
      exclusions: "hard_failures_and_missing_evidence_remain_in_denominator",
      fingerprint: null,
      powerResult: null,
    }),
    phases: Object.freeze([
      Object.freeze({
        id: "stage_0_preflight_calibration",
        caseSet: "development",
        uniqueCases: 8,
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
            candidate(`smoke-${cell.id}`, "none", "admitted_diagnostic", [
              stage(
                cell.role,
                cell.id,
                cell.role === "router" ? 1 : 12,
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
              "admitted_diagnostic",
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
              "admitted_diagnostic",
              [stage("generation", cell.id, 12, 16_384, 900)],
            ),
          ),
        ),
      }),
      Object.freeze({
        id: "stage_3_architecture",
        caseSet: "development",
        uniqueCases: 46,
        repetitions: 3,
        selectionUse: "architecture_selection",
        arms: Object.freeze([
          candidate(
            "routed-locked-finalist",
            "two_stage_llm_router",
            "admitted_diagnostic",
            [
              stage("router", routerCell.id, 1, 4_096, 300),
              stage("generation", generatorCell.id, 12, 16_384, 900),
              stage("judge", judgeCells[0].id, 1, 16_384, 300),
              stage("judge", judgeCells[1].id, 1, 16_384, 300),
            ],
          ),
          candidate(
            "hybrid-locked-finalist",
            "deterministic_policy_llm_fallback_hybrid",
            "not_evaluable_no_treatment_contrast",
            [
              stage("router", routerCell.id, 1, 4_096, 300),
              stage("generation", generatorCell.id, 12, 16_384, 900),
              stage("judge", judgeCells[0].id, 1, 16_384, 300),
              stage("judge", judgeCells[1].id, 1, 16_384, 300),
            ],
            {
              localTerminalCases: "exact_harmless_only",
              fallbackRouterCallsPerNonlocalCase: 1,
              worstCaseRouterCalls: 46 * 3,
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
            "admitted_diagnostic",
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
  ceilingUsd: number;
}
export interface FixedTraceProtocolEstimate {
  dispatchable: false;
  approvalCeilingUsd: null;
  stages: readonly FixedTraceStageCeiling[];
  candidateCeilingUsd: number;
  judgeCeilingUsd: number;
  simulatorCeilingUsd: 0;
  failedTimeoutUnknownExposureCeilingUsd: number;
  contingencyUsd: number;
  totalCeilingUsd: number;
  hybridWorstCaseRouterCalls: 138;
  hybridWorstCaseRouterCeilingUsd: number;
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
  readonly routerCeilingUsd: number;
  readonly generationCeilingUsd: number;
}
export interface FixedTraceScreeningResult {
  readonly cellId: string;
  readonly safetyFailures: number;
  readonly identityFailures: number;
  readonly malformedFailures: number;
  readonly toolLoopFailures: number;
  readonly reliabilityFailures: number;
  readonly latencyMs: number;
  readonly costUsd: number;
}
/** Pure, predeclared elimination/halving rule; repetitions estimate stability only. */
export function selectFixedTraceScreeningSurvivors(
  results: readonly FixedTraceScreeningResult[],
): readonly string[] {
  const seen = new Set<string>();
  for (const result of results) {
    if (
      !FIXED_TRACE_ADMITTED_CELLS.some((cell) => cell.id === result.cellId) ||
      seen.has(result.cellId)
    )
      throw new Error("screening result has an unknown or duplicate cell");
    if (
      [
        result.safetyFailures,
        result.identityFailures,
        result.malformedFailures,
        result.toolLoopFailures,
        result.reliabilityFailures,
        result.latencyMs,
        result.costUsd,
      ].some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error("screening result has invalid metrics");
    seen.add(result.cellId);
  }
  const eligible = results.filter(
    (result) =>
      result.safetyFailures === 0 &&
      result.identityFailures === 0 &&
      result.malformedFailures === 0 &&
      result.toolLoopFailures === 0,
  );
  return Object.freeze(
    [...eligible]
      .sort(
        (left, right) =>
          left.reliabilityFailures - right.reliabilityFailures ||
          left.costUsd - right.costUsd ||
          left.latencyMs - right.latencyMs ||
          left.cellId.localeCompare(right.cellId),
      )
      .slice(0, Math.max(1, Math.ceil(eligible.length / 2)))
      .map((result) => result.cellId),
  );
}
function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}
export function fixedTraceEvaluationProtocolFingerprint(
  protocol: FixedTraceEvaluationProtocol,
): string {
  assertFixedTraceEvaluationProtocol(protocol);
  return sha256(protocol);
}
export function assertFixedTraceEvaluationProtocol(
  protocol: FixedTraceEvaluationProtocol,
): void {
  assertFixedTracePartitionManifest();
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
    protocol.finalProtocol.powerResult !== null
  )
    throw new Error(
      "external final is unavailable until exact paired-discordance power is fingerprinted",
    );
  if (
    FIXED_TRACE_CONFIRMATORY_ADMISSION.status !==
      "not_admitted_missing_fingerprinted_statistical_protocol" ||
    FIXED_TRACE_CONFIRMATORY_ADMISSION.finalProtocolFingerprint !== null ||
    FIXED_TRACE_CONFIRMATORY_ADMISSION.sizingPilot.digest !== null ||
    FIXED_TRACE_CONFIRMATORY_ADMISSION.judgeCalibration.digest !== null
  ) {
    throw new Error(
      "confirmatory statistical admission must fail closed until independently custodied",
    );
  }
  for (const phase of protocol.phases) {
    const expectedCases =
      phase.caseSet === "development"
        ? FIXED_TRACE_PARTITION_MANIFEST.development.length
        : phase.caseSet === "tuning"
          ? FIXED_TRACE_PARTITION_MANIFEST.tuning.length
          : null;
    if (
      phase.uniqueCases !== null &&
      phase.uniqueCases !== 8 &&
      phase.uniqueCases !== expectedCases
    )
      throw new Error(
        `phase ${phase.id} does not use corpus-derived case counts`,
      );
    for (const arm of phase.arms) {
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
      if (judges.length) {
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
}
export function estimateFixedTraceEvaluationProtocol(
  protocol: FixedTraceEvaluationProtocol = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
): FixedTraceProtocolEstimate {
  assertFixedTraceEvaluationProtocol(protocol);
  const stages: FixedTraceStageCeiling[] = [];
  for (const phase of protocol.phases)
    for (const arm of phase.arms) {
      if (
        (arm.admission === "not_admitted_architecture" ||
          phase.uniqueCases === null) &&
        arm.architecture !== "deterministic_policy_llm_fallback_hybrid"
      )
        continue;
      const uniqueCases = phase.uniqueCases;
      if (uniqueCases === null) continue;
      for (const item of arm.stages) {
        const cell = FIXED_TRACE_ADMITTED_CELLS.find(
          (entry) => entry.id === item.cellId,
        );
        if (!cell) continue;
        const profile = FIXED_TRACE_PROTOCOL_PRICING.find(
          (entry) => entry.profileId === cell.pricingProfileId,
        )!;
        validateFixedTracePricing(profile);
        const calls =
          uniqueCases * phase.repetitions * item.maxInvocationsPerCase;
        stages.push({
          phaseId: phase.id,
          armId: arm.id,
          role: item.role,
          calls,
          ceilingUsd: fixedTraceEstimatedCostUsd(
            {
              inputTokens: calls * item.maxInputTokensPerInvocation,
              outputTokens: calls * item.maxOutputTokensPerInvocation,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            profile,
          ),
        });
      }
    }
  const candidateCeilingUsd = stages
    .filter((item) => item.role === "router" || item.role === "generation")
    .reduce((total, item) => total + item.ceilingUsd, 0);
  const judgeCeilingUsd = stages
    .filter((item) => item.role === "judge")
    .reduce((total, item) => total + item.ceilingUsd, 0);
  const failedTimeoutUnknownExposureCeilingUsd =
    candidateCeilingUsd + judgeCeilingUsd;
  const contingencyUsd = (candidateCeilingUsd + judgeCeilingUsd) * 0.1;
  const hybridRouter = stages.find(
    (item) =>
      item.phaseId === "stage_3_architecture" &&
      item.armId === "hybrid-locked-finalist" &&
      item.role === "router",
  )!;
  const architecturePhase = protocol.phases.find(
    (phase) => phase.id === "stage_3_architecture",
  )!;
  const developmentContrast = FIXED_TRACE_HYBRID_CONTRAST_PREFLIGHT.find(
    (preflight) => preflight.phase === "development",
  )!;
  const armCallAccounting = architecturePhase.arms.map((arm) => {
    const router = arm.stages.find((item) => item.role === "router");
    const generation = arm.stages.find((item) => item.role === "generation");
    const localTerminalCases =
      arm.architecture === "deterministic_policy_llm_fallback_hybrid"
        ? developmentContrast.localTerminalCases * architecturePhase.repetitions
        : 0;
    const routedCases =
      arm.architecture === "direct_generation"
        ? 0
        : architecturePhase.uniqueCases! * architecturePhase.repetitions -
          localTerminalCases;
    const cost = (item: FixedTraceProtocolStage | undefined, calls: number) => {
      if (!item?.cellId) return 0;
      const cell = FIXED_TRACE_ADMITTED_CELLS.find(
        (entry) => entry.id === item.cellId,
      )!;
      const profile = FIXED_TRACE_PROTOCOL_PRICING.find(
        (entry) => entry.profileId === cell.pricingProfileId,
      )!;
      return fixedTraceEstimatedCostUsd(
        {
          inputTokens: calls * item.maxInputTokensPerInvocation,
          outputTokens: calls * item.maxOutputTokensPerInvocation,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        profile,
      );
    };
    const routerCalls = router ? routedCases * router.maxInvocationsPerCase : 0;
    const generationCalls = generation
      ? routedCases * generation.maxInvocationsPerCase
      : 0;
    return Object.freeze({
      armId: arm.id,
      admission: arm.admission,
      evaluable:
        arm.architecture !== "deterministic_policy_llm_fallback_hybrid" ||
        developmentContrast.evaluable,
      localTerminalCases,
      routedCases,
      routerCalls,
      generationCalls,
      routerCeilingUsd: cost(router, routerCalls),
      generationCeilingUsd: cost(generation, generationCalls),
    });
  });
  return Object.freeze({
    dispatchable: false,
    approvalCeilingUsd: null,
    stages: Object.freeze(stages),
    candidateCeilingUsd,
    judgeCeilingUsd,
    simulatorCeilingUsd: 0,
    failedTimeoutUnknownExposureCeilingUsd,
    contingencyUsd,
    totalCeilingUsd: candidateCeilingUsd + judgeCeilingUsd + contingencyUsd,
    hybridWorstCaseRouterCalls: 138,
    hybridWorstCaseRouterCeilingUsd: hybridRouter.ceilingUsd,
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
  return Object.freeze(
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
        )!,
      ),
  );
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
