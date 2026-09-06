import { createHash } from "node:crypto";
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
} from "./fixed-trace-partition.js";
import { snapshotFixedTraceJson } from "./fixed-trace-safe-snapshot.js";

export const FIXED_TRACE_EXPERIMENTAL_DESIGN_VERSION =
  "addie-fixed-trace-experimental-design-v1" as const;

const SMOKE_CASE_IDS = Object.freeze([
  "surface-channel-chatter",
  "knowledge-task-model",
  "admin-member-records-without-slack",
  "billing-invoice-confirmed",
  "tool-result-prompt-injection",
  "dev-tool-error-retry",
  "dev-truncation-boundary",
  "provider-unavailable",
]);

const HYBRID_DIAGNOSTIC_CASE_SPECS = Object.freeze({
  localTerminal: Object.freeze([
    "arch-l01-dm-ignore", "arch-l02-private-react", "arch-l03-private-thanks", "arch-l04-dm-done",
    "arch-l05-dm-sounds-good", "arch-l06-dm-will-do", "arch-l07-private-hello", "arch-l08-dm-thank-you",
  ]),
  matchedNearMiss: Object.freeze([
    "arch-n01-thread-ignore", "arch-n02-public-react", "arch-n03-unknown-privacy", "arch-n04-mutating-suffix",
    "arch-n05-admin-sounds-good", "arch-n06-thread-will-do", "arch-n07-control-delimiter", "arch-n08-negated-thanks",
  ]),
  routedSafety: Object.freeze([
    "knowledge-task-model", "dev-auth-no-disclosure", "billing-invoice-confirmed", "admin-member-records-without-slack",
    "dev-tool-error-retry", "dev-date-relative", "arch-r02-public-channel-injection", "arch-r08-long-truncation",
  ]),
});

type FixedTraceArchitectureStratum =
  | "local_terminal_eligible"
  | "matched_hybrid_fallback_near_miss"
  | "routed_tool_or_safety";

interface FixedTraceArchitectureEstimand {
  readonly id:
    | "architecture_direct_vs_routed"
    | "architecture_hybrid_vs_routed"
    | "architecture_hybrid_vs_direct";
  readonly comparison: string;
  readonly endpoint: string;
  readonly strata: readonly FixedTraceArchitectureStratum[];
  readonly population: "custodied_24_case_diagnostic_pack_not_production_prevalence";
  readonly analysisUnit: "conversation_user_episode_cluster";
  readonly intentionToTreat: "all_assigned_case_arm_repetition_records";
  readonly missingness: "missing_or_failed_output_remains_in_denominator";
  readonly repetitions: "three_stability_repetitions_not_independent_N";
  readonly randomization: "seeded_complete_blocks_case_repetition_Latin_square_arm_provider_position";
  readonly multiplicity: "diagnostic_only_no_confirmatory_decision";
  readonly gateRole: "descriptive_stratum_effects_only";
  readonly collisionHandling: "custodied_preexposure_collision_audit_required";
}

const ARCHITECTURE_DIAGNOSTIC_STRATA = Object.freeze([
  "local_terminal_eligible",
  "matched_hybrid_fallback_near_miss",
  "routed_tool_or_safety",
] as const);

function architectureEstimand(
  id: FixedTraceArchitectureEstimand["id"],
  comparison: string,
  endpoint: string,
): FixedTraceArchitectureEstimand {
  return Object.freeze({
    id, comparison, endpoint,
    strata: ARCHITECTURE_DIAGNOSTIC_STRATA,
    population: "custodied_24_case_diagnostic_pack_not_production_prevalence",
    analysisUnit: "conversation_user_episode_cluster",
    intentionToTreat: "all_assigned_case_arm_repetition_records",
    missingness: "missing_or_failed_output_remains_in_denominator",
    repetitions: "three_stability_repetitions_not_independent_N",
    randomization: "seeded_complete_blocks_case_repetition_Latin_square_arm_provider_position",
    multiplicity: "diagnostic_only_no_confirmatory_decision",
    gateRole: "descriptive_stratum_effects_only",
    collisionHandling: "custodied_preexposure_collision_audit_required",
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * This records methodology requirements, not authority to dispatch.  Every
 * unavailable pack has a purpose-specific plan fingerprint but no invented
 * content digest or case list.  That makes a later custody artifact additive
 * rather than allowing development cases to be relabelled as confirmation.
 */
export const FIXED_TRACE_EXPERIMENTAL_DESIGN = Object.freeze({
  version: FIXED_TRACE_EXPERIMENTAL_DESIGN_VERSION,
  status: "not_admitted_pending_custodied_packs_panel_randomization_and_dispatch_authority",
  configurationCellTreatmentRule:
    "router_and_generator_entries_are_exact_nested_provider_model_effort_configuration_cells; no separable_provider_model_or_effort_main_effect_is_estimable",
  estimands: Object.freeze([
    Object.freeze({
      id: "component_router_cell",
      comparison: "named_router_cell_against_predeclared_named_router_counterpart_under_fixed_oracle_generator",
    }),
    Object.freeze({
      id: "component_generator_cell",
      comparison: "named_generator_cell_against_predeclared_named_generator_counterpart_under_oracle_and_deployable_fixed_router_conditions",
    }),
    architectureEstimand(
      "architecture_direct_vs_routed",
      "direct_generation_vs_two_stage_llm_router with one fixed named generator cell; direct has no router cell",
      "stratum_specific_blinded_human_primary_quality",
    ),
    architectureEstimand(
      "architecture_hybrid_vs_routed",
      "deterministic_policy_llm_fallback_hybrid_vs_two_stage_llm_router with fixed named router and generator cells",
      "stratum_specific_blinded_human_primary_quality_and_operational_metrics",
    ),
    architectureEstimand(
      "architecture_hybrid_vs_direct",
      "deterministic_policy_llm_fallback_hybrid_vs_direct_generation with one fixed named generator cell",
      "stratum_specific_blinded_human_primary_quality",
    ),
  ]),
  corpus: Object.freeze({
    caseCount: 82,
    developmentCases: 46,
    tuningCases: 36,
    sealedFinalCases: 0,
    corpusSha256: "8fbd8c74afccbff7d557f235a48152b27e327279efd58d29418f07f4f4c121c1",
    trustedLockVerified: false,
    sealedFinalDeficit: 38,
    existingCaseRule: "no_existing_case_may_be_relabelled_external_final",
    lineage: Object.freeze([
      "legacy_v31_32_cases_exposed_in_two_live_Luna_runs_one_conservative_analysis_cluster",
      "14_added_development_cases_one_builder_lineage",
      "36_tuning_cases_separate_public_builder_authority",
      "machine_duplicate_clean_does_not_remove_template_or_builder_dependence",
    ]),
  }),
  packs: Object.freeze([
    Object.freeze({
      id: "calibration",
      purpose: "human_and_secondary_llm_judge_calibration_only",
      status: "unavailable_pending_independent_custody",
      caseIds: null,
      contentDigest: null,
      planFingerprint: digest({ id: "calibration", purpose: "judge_calibration_only" }),
    }),
    Object.freeze({
      id: "development",
      purpose: "exploratory_screening_and_diagnostic_selection_only",
      status: "pinned",
      caseIds: FIXED_TRACE_PARTITION_MANIFEST.development,
      tuningCaseIds: FIXED_TRACE_PARTITION_MANIFEST.tuning,
      /** Full-semantic corpus manifest; the ID partition hash is not content custody. */
      contentDigest: "8fbd8c74afccbff7d557f235a48152b27e327279efd58d29418f07f4f4c121c1",
      partitionDigest: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
      planFingerprint: digest({
        id: "development",
        ids: FIXED_TRACE_PARTITION_MANIFEST.development,
        tuningIds: FIXED_TRACE_PARTITION_MANIFEST.tuning,
        partition: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
      }),
    }),
    Object.freeze({
      id: "sealed_sizing_pilot",
      purpose: "stratified_discordance_sizing_only_never_final",
      status: "unavailable_pending_independent_custody",
      caseIds: null,
      contentDigest: null,
      planFingerprint: digest({ id: "sealed_sizing_pilot", purpose: "sizing_only_never_final" }),
    }),
    Object.freeze({
      id: "external_final",
      purpose: "one_time_confirmatory_external_episodes_only",
      status: "unavailable_pending_independent_custody_and_power",
      caseIds: null,
      contentDigest: null,
      planFingerprint: digest({ id: "external_final", purpose: "one_time_confirmation_only" }),
    }),
  ]),
  smoke: Object.freeze({
    caseIds: SMOKE_CASE_IDS,
    strata: Object.freeze([
      "surface_terminal", "knowledge_read", "admin_authorized_read", "confirmed_mutation",
      "tool_result_injection", "tool_retry", "truncation", "provider_degradation",
    ]),
    orderedSubsetDigest: digest(SMOKE_CASE_IDS),
    repetitions: 1,
    cells: 21,
    providerCeilingUsd: 5,
    claims: "mechanical_feasibility_only_no_quality_architecture_safety_rate_NI_superiority_hybrid_interaction_or_production_claim",
    executionOverlay: Object.freeze({
      status: "contract_complete_evaluator_owned_non_promotable",
      contractCompleteCaseIds: SMOKE_CASE_IDS,
      requiredOverlayCaseIds: Object.freeze([]),
      blocker: "explicit_one_use_external_paid_authorization_and_dormant_dispatch_wiring_required",
    }),
  }),
  hybridArchitectureDiagnostic: Object.freeze({
    status: "not_admitted_pending_independently_custodied_stratified_pack",
    totalCases: 24,
    repetitions: 3,
    requiredStrata: Object.freeze([
      "local_terminal_eligible",
      "matched_hybrid_fallback_near_miss",
      "routed_tool_or_safety",
    ]),
    casesPerStratum: 8,
    caseSpecs: HYBRID_DIAGNOSTIC_CASE_SPECS,
    contentDigest: null,
    excludesHandpickedPolicyFixtures: true,
    pairingAndClusterRule: "each_local_near_and_routed_triplet_is_one_cluster; every_local_near_pair_has_one_pair_id",
    effectReport: "stratum_specific_only; production_standardized_overall_requires_separately_estimated_prevalence_weights",
    humanPanel: "two_common_blinded_humans_with_locked_adjudication",
  }),
  componentScreening: Object.freeze({
    status: "not_admitted_pending_common_blinded_human_panel",
    qualityRule: "human_blinded_quality_is_required_alongside_mechanical_failure_cost_latency_ranking",
    generatorConditions: "oracle_routing_diagnostic_plus_at_least_one_deployable_fixed_router",
    finalistCross: "two_to_three_router_cells_by_three_to_four_generator_cells_across_routed_hybrid_and_direct_per_generator",
  }),
  judging: Object.freeze({
    primary: "same_blinded_human_primary_panel_for_all_finalists",
    secondary: "calibrated_LLM_judges_only",
    mixedProviderPipeline: "dual_provider_excluding_LLM_judging_unavailable_without_governed_dual_human_primary_or_fourth_calibrated_provider",
    randomization: "presentation_randomization_and_disagreement_adjudication_locked_before_scoring",
  }),
  randomization: Object.freeze({
    status: "not_admitted_pending_evaluator_owned_seed_and_schedule",
    design: "seeded_randomized_complete_blocks_by_case_repetition_with_balanced_Latin_square_arm_provider_position_and_balanced_concurrency",
    requiredLedgerFields: Object.freeze(["seed", "block", "position", "scheduleDigest", "worker"]),
    seedCommitment: null,
    scheduleDigest: null,
  }),
  inference: Object.freeze({
    status: "not_admitted_pending_locked_final_protocol_and_exact_power",
    multiplicity: "Holm_thresholds_attach_to_ordered_p_values; H1_then_H2_is_gatekeeping_not_fixed_Holm_threshold_assignment",
    screening: "exploratory_simultaneous_intervals_or_FDR; safety_and_reliability_are_co_gates",
    denominator: "intention_to_treat; every_dispatched_attempt_cost_latency_and_missingness_persisted; evaluator_corruption_reruns_are_block_level_only",
    rareFailure: "exact_one_sided_upper_limits_and_zero_tolerance_catastrophic_sentinels",
    pairedInference: "paired_quality_cost_and_p95_or_paired_latency_inference_clustered_by_conversation_user_episode",
    confirmation: "sealed_sizing_pilot_never_reused_in_final; one_run_per_unique_external_episode",
  }),
  pricing: Object.freeze({
    status: "not_admitted_pending_reviewed_current_price_cohort",
    prospectiveInference: "must_bind_reviewed_current_pricing_cohort_before_dispatch",
    historicalReserve:
      "historical_reservation_records_are_not_a_prospective_price_cohort_or_exact_cross_model_cost",
    retrospectiveReconciliation: Object.freeze({
      status: "externally_supplied_nonadmitting_reconciliation_unverified_in_this_workspace",
      method:
        "recompute_from_metered_judgment_usage_at_current_price_version_without_rewriting_source_artifacts",
      admissionBinding: null,
      rule:
        "immutable_price_versioned_local_addenda_only; never_rewrite_original_v31_artifacts; any historical judge_or_combined_cost_threshold_change does_not_override_failed_deterministic_quality_coverage_safety_consensus_or_enable_promotion",
    }),
  }),
  externalHoldoutBrief: Object.freeze({
    status: "unavailable_pending_independent_custody",
    minimumCases: 38,
    requirements: "independent_synthetic_authoring_against_preregistered_category_surface_risk_matrix_without_candidate_outputs_or_prompt_text; separate_visible_request_from_custodied_fixtures_expectations_rubrics; predeclare_tool_auth_confirmation_receipt_terminal_output; assign_clusters_collision_screen_all_82_distinct_custodian_sign_encrypt_third_party_validate; exposure_permanently_removes_final_eligibility",
  }),
  diagnosticManifest: Object.freeze({
    status: "not_admitted_pending_custodied_versioned_manifest",
    signature: null,
    requiredFields: Object.freeze([
      "ordered_ids_full_semantic_case_hashes_parent_corpus_phase_hashes",
      "stratum_pair_cluster_analysis_unit_lineage_arm_repetition_randomization_seed_algorithm_schedule",
      "architecture_policy_stage_control_code_source_grader_adapter_orchestration_prompt_config_tool_definition_handler_execution_envelope_request_fact_fingerprints",
      "provider_model_control_pricing_fault_token_schedule_when_authorized",
      "diagnostic_only_run_authorized_false_promotion_authorized_false",
      "canonical_versioned_json_domain_separated_sha256_custodied_signature",
    ]),
  }),
  evidenceLedgerFields: Object.freeze([
    "pack_fingerprints", "randomization", "software_prompt_tool_pricing_calibration_fingerprints",
    "episode_template_stratum_arm_cells_repetition_block_position_worker_times",
    "authenticated_request_facts_and_tool_binding", "every_prepared_returned_identity_and_fallback",
    "limits_request_hash_raw_outputs_tool_evidence_usage_cost_latency",
    "blinded_ratings_adjudication_denominator_missingness_deviation",
  ]),
  budget: Object.freeze({
    humanOptionalUsd: 650,
    humanDiagnosticFormula: Object.freeze({
      status: "not_admitted_pending_rate_and_assignment_authorization",
      cases: 24,
      architectureArms: 3,
      repetitions: 3,
      blindedOutputs: 216,
      primaryRatingsPerOutput: 2,
      primaryRatings: 432,
      examplePrimaryUsdPerRating: 1.25,
      maximumAdjudications: 44,
      exampleAdjudicationUsdEach: 2.5,
      examplePrimaryCeilingUsd: 540,
      exampleAdjudicationCeilingUsd: 110,
      exampleTotalCeilingUsd: 650,
      assignmentRule: "reserve_before_assignment_and_reject_overrun; changed_vendor_or_human_rates_leave_values_unavailable",
      inference: "diagnostic_only_no_final_power_or_promotion_inference",
    }),
    humanSpendRule: "qualitative_only_until_population_panel_blinding_form_adjudication_and_max_N_are_prospectively_locked",
    confirmation: "formula_driven_may_exceed_100k_under_worst_case_N; no_fixed_10050_recommendation",
  }),
});

export type FixedTraceExperimentalDesign = typeof FIXED_TRACE_EXPERIMENTAL_DESIGN;

export function fixedTraceExperimentalDesignFingerprint(
  design: FixedTraceExperimentalDesign = FIXED_TRACE_EXPERIMENTAL_DESIGN,
): string {
  return digest(snapshotFixedTraceJson(design, "fixed-trace experimental design"));
}

/** Reject incomplete or relabelled design artifacts before any admission. */
export function assertFixedTraceExperimentalDesign(
  design: FixedTraceExperimentalDesign = FIXED_TRACE_EXPERIMENTAL_DESIGN,
): void {
  const snapshot = snapshotFixedTraceJson(
    design,
    "fixed-trace experimental design",
  ) as FixedTraceExperimentalDesign;
  if (snapshot.version !== FIXED_TRACE_EXPERIMENTAL_DESIGN_VERSION)
    throw new Error("fixed-trace experimental design version is invalid");
  if (digest(snapshot) !== digest(FIXED_TRACE_EXPERIMENTAL_DESIGN))
    throw new Error("fixed-trace experimental design differs from pinned declaration");
  if (
    snapshot.smoke.caseIds.length !== 8 ||
    snapshot.smoke.strata.length !== 8 ||
    new Set(snapshot.smoke.caseIds).size !== 8 ||
    snapshot.smoke.orderedSubsetDigest !== digest(snapshot.smoke.caseIds) ||
    snapshot.smoke.caseIds.some((id) => !FIXED_TRACE_PARTITION_MANIFEST.development.includes(id))
  ) throw new Error("smoke requires eight exact stratified development IDs and digest");
  if (
    digest(snapshot.hybridArchitectureDiagnostic.caseSpecs) !== digest(HYBRID_DIAGNOSTIC_CASE_SPECS) ||
    snapshot.hybridArchitectureDiagnostic.contentDigest !== null ||
    snapshot.diagnosticManifest.signature !== null ||
    snapshot.randomization.seedCommitment !== null ||
    snapshot.randomization.scheduleDigest !== null
  ) throw new Error("unavailable diagnostic pack or randomization cannot be caller-admitted");
}
