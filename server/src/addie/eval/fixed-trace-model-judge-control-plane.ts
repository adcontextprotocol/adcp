import { FIXED_TRACE_API_BUDGET_LADDER, assertFixedTraceUnverifiedTrancheLedgerShape } from './fixed-trace-api-budget-ladder.js';
import { FIXED_TRACE_ADMITTED_CELLS, FIXED_TRACE_ARCHITECTURE_CELL_TRUTH, FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, fixedTraceEvaluationProtocolFingerprint } from './fixed-trace-evaluation-protocol.js';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

export const FIXED_TRACE_MODEL_JUDGE_CONTROL_PLANE_VERSION = 'addie-fixed-trace-model-judge-control-plane-v2' as const;
const BASE_PROTOCOL_FINGERPRINT = 'fef6fd0edb9354d078cbac3dfce688bd9d187982a50a9564c6521e100dcc2325' as const;
if (fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) !== BASE_PROTOCOL_FINGERPRINT) throw new Error('model-judged amendment must bind the unchanged base protocol fingerprint');

/** No calibration content, expected decisions, or observed results are present. */
export const FIXED_TRACE_FROZEN_GOLDEN_CALIBRATION_REQUIREMENT = Object.freeze({
  status: 'unavailable_pending_versioned_case_rubric_expected_decision_and_observed_calibration_ledger',
  requiredArtifact: 'canonical_versioned_case_rubric_expected_decision_manifest_with_derived_content_digest',
  requiredResults: 'private_verified_observed_per_judge_calibration_ledger',
  prohibited: 'self_attested_id_hash_or_caller_supplied_calibrated_judge_list',
} as const);
export const FIXED_TRACE_DIAGNOSTIC_ASSIGNMENT_REQUIREMENT = Object.freeze({
  status: 'unavailable_pending_custodied_exact_assignment_manifest',
  requiredFields: Object.freeze(['case_id', 'stratum', 'architecture_arm', 'ordered_configuration_cell_ids', 'derived_and_bound_candidate_pipeline_provider_set', 'repetition', 'opaque_packet_id', 'judge_eligibility', 'exact_expected_provider_excluding_judge_slots', 'deterministic_evidence_assignment', 'seed_commitment', 'schedule_digest', 'locked_holdout_digest']),
  omissionRule: 'every_expected_candidate_output_and_judge_slot_remains_in_denominator',
} as const);
export const FIXED_TRACE_CUSTODY_REQUIREMENT = Object.freeze({
  status: 'unavailable_pending_private_verified_seed_schedule_and_locked_holdout_linkage',
  prohibited: 'syntax_valid_caller_supplied_digests_are_not_custody_or_holdout_proof',
} as const);

/** This deliberately mirrors only the locked v2 21-cell registry; it is not exhaustive. */
const LOCKED_V2_CANDIDATE_PROVIDER_SUBSET = Object.freeze(['anthropic', 'openai', 'google'] as const);
export type FixedTraceRegisteredCandidateProvider = (typeof LOCKED_V2_CANDIDATE_PROVIDER_SUBSET)[number];
export type FixedTraceProviderExcludingJudgeEligibility = Readonly<{
  candidateProviders: readonly FixedTraceRegisteredCandidateProvider[];
  status: 'eligible_pending_custodied_manifest_calibration_and_authority' | 'unavailable_mixed_provider_requires_human_or_fourth_provider';
  requiredJudgeProviders: readonly FixedTraceRegisteredCandidateProvider[];
  promotable: false;
}>;

/**
 * Planning classification only. It neither declares an assignment nor admits
 * one: the future manifest must bind this exact relationship per assignment.
 */
export function classifyFixedTraceProviderExcludingJudgeEligibility(
  candidateProviders: readonly FixedTraceRegisteredCandidateProvider[],
): FixedTraceProviderExcludingJudgeEligibility {
  const unique = [...new Set(candidateProviders)];
  if (unique.length === 0 || unique.some((provider) => !LOCKED_V2_CANDIDATE_PROVIDER_SUBSET.includes(provider))) {
    throw new Error('candidate provider set must be a nonempty subset of the locked v2 three-provider registry');
  }
  if (unique.length !== 1) {
    return Object.freeze({
      candidateProviders: Object.freeze(unique),
      status: 'unavailable_mixed_provider_requires_human_or_fourth_provider',
      requiredJudgeProviders: Object.freeze([]),
      promotable: false,
    });
  }
  return Object.freeze({
    candidateProviders: Object.freeze(unique),
    status: 'eligible_pending_custodied_manifest_calibration_and_authority',
    requiredJudgeProviders: Object.freeze(LOCKED_V2_CANDIDATE_PROVIDER_SUBSET.filter((provider) => provider !== unique[0])),
    promotable: false,
  });
}

export const FIXED_TRACE_PROVIDER_EXCLUDING_JUDGE_ELIGIBILITY_REQUIREMENT = Object.freeze({
  status: 'unavailable_pending_custodied_per_assignment_eligibility_manifest',
  lockedV2CandidateProviderSubset: LOCKED_V2_CANDIDATE_PROVIDER_SUBSET,
  universeScope: 'not_an_exhaustive_model_universe; additions_require_a_separate_versioned_priced_and_admitted_inventory_after_tranche_1',
  currentPlanningTruth: Object.freeze({
    potentiallyLlmJudgeableProviderMatchedCombinations: FIXED_TRACE_ARCHITECTURE_CELL_TRUTH.potentiallyLlmJudgeableProviderMatchedCombinations,
    mixedProviderCombinationsRequiringHumanOrFourthProvider: FIXED_TRACE_ARCHITECTURE_CELL_TRUTH.mixedProviderCombinationsRequiringHumanOrFourthProvider,
  }),
  singleProviderRule: 'single-provider component packets and same-provider locked architecture arms require exactly two distinct provider-excluding judge providers',
  mixedProviderRule: 'mixed-provider quality admission is unavailable and non-promotable; do not self-judge, invent a fourth provider, or claim comprehensive mixed-provider quality admission',
  requiredPerAssignmentBindings: Object.freeze(['candidate_pipeline_provider_set', 'eligibility_status', 'exact_expected_provider_excluding_judge_slots']),
} as const);

export const FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT = Object.freeze({
  version: 'addie-fixed-trace-model-judged-diagnostic-amendment-v2',
  baseProtocolFingerprint: BASE_PROTOCOL_FINGERPRINT,
  status: 'not_admitted_pending_custody_calibration_exact_assignment_and_private_verified_budget_authority',
  blockers: Object.freeze([FIXED_TRACE_FROZEN_GOLDEN_CALIBRATION_REQUIREMENT.status, FIXED_TRACE_DIAGNOSTIC_ASSIGNMENT_REQUIREMENT.status, FIXED_TRACE_PROVIDER_EXCLUDING_JUDGE_ELIGIBILITY_REQUIREMENT.status, FIXED_TRACE_API_BUDGET_LADDER.status, FIXED_TRACE_CUSTODY_REQUIREMENT.status, 'unavailable_pending_complete_per_assignment_deterministic_evidence']),
  componentSmoke: 'unchanged_v2_mechanical_feasibility_only_no_quality_or_architecture_claim',
  architectureArms: Object.freeze(['direct_generation', 'two_stage_llm_router', 'deterministic_policy_llm_fallback_hybrid']),
  treatmentRule: 'architecture_and_provider_model_effort_configuration_cells_are_nested_treatments_not_separable_effects',
  judges: 'exactly_two_judges_with_distinct_provider_and_model_identities_excluding_every_candidate_provider_and_candidate_model_in_the_locked_three_provider_registry; future_fourth_provider_support_requires_a_versioned_amendment; exact_manifest_slots_preserve_missing_malformed_refusal_abstain_and_disagreement',
  blinding: 'candidate_provider_model_architecture_cost_latency_configuration_and_other_judge_scores_absent_from_judge_packets',
  hardGates: Object.freeze(['correctness', 'mutation_safety', 'prompt_injection', 'tool_correctness', 'provenance', 'returned_identity', 'latency', 'cost']),
  humanPanel: 'dormant_optional_control_plane_not_admission_blocker_and_not_evidence_that_humans_ran',
  claimLimits: Object.freeze(['no_human_confirmatory_claim', 'no_noninferiority_claim', 'no_superiority_claim', 'no_production_generalization_claim', 'no_architecture_winner_claim', 'no_model_winner_claim', 'no_effort_winner_claim', 'no_quality_rate_claim']),
} as const);

const packetKeys = ['candidateOutput', 'outputCondition', 'packetId', 'prompt', 'scoringContext'] as const;
const exact = (record: Record<string, unknown>, keys: readonly string[], label: string) => {
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${label} has extra or missing fields`);
};
const plain = (value: unknown, label: string) => {
  const snapshot = snapshotFixedTraceJson(value, label);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error(`${label} must be an object`);
  return snapshot as Record<string, unknown>;
};
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonblank = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const assignmentKeys = ['architectureArm', 'assignmentId', 'candidateOutput', 'caseId', 'configurationCellIds', 'outputStatus', 'packetId', 'repetition', 'stratum'] as const;
const lockedV2CellsById = new Map(FIXED_TRACE_ADMITTED_CELLS.map((cell) => [cell.id, cell]));
const deterministicKeys = ['assignmentId', 'correctness', 'cost', 'latency', 'mutationSafety', 'promptInjection', 'provenance', 'returnedIdentity', 'toolCorrectness'] as const;
const judgmentKeys = ['judgeModel', 'judgeProvider', 'outcome', 'packetId', 'reason'] as const;
const lockedV2TreatmentIdentifiers = Object.freeze([
  ...FIXED_TRACE_ADMITTED_CELLS.map((cell) => cell.id),
  'direct_generation',
  'two_stage_llm_router',
  'deterministic_policy_llm_fallback_hybrid',
]);
const escapedLockedV2TreatmentIdentifiers = lockedV2TreatmentIdentifiers
  .slice()
  .sort((left, right) => right.length - left.length)
  .map((identifier) => identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const lockedV2TreatmentIdentifierPattern = new RegExp(`(?<![A-Za-z0-9_])(?:${escapedLockedV2TreatmentIdentifiers.join('|')})(?![A-Za-z0-9_])`);
const lockedV2CellIds = new Set(FIXED_TRACE_ADMITTED_CELLS.map((cell) => cell.id));

/**
 * This is only a narrow structural screen for exact locked-v2 identifiers.
 * It is not proof of blinding; real packet blinding remains unavailable until
 * a separately verified exact assignment manifest supplies all identifiers.
 */
export const FIXED_TRACE_PACKET_BLINDING_BOUNDARY = Object.freeze({
  status: 'non_proof_structural_check_pending_verified_assignment_manifest',
  exactIdentifierRule: 'reject_only_exact_locked_v2_treatment_identifiers_or_extra_metadata_fields; ordinary_task_language_is_not_treatment_metadata',
} as const);

function assertRows(rows: unknown, keys: readonly string[], label: string, validate: (row: Record<string, unknown>) => boolean): void {
  if (!Array.isArray(rows)) throw new Error(`${label} must be an array`);
  for (const row of rows) {
    const record = plain(row, label);
    exact(record, keys, label);
    if (!validate(record)) throw new Error(`${label} has invalid values`);
  }
}

/** Judge packets have an exact structural shape; this function never proves blinding. */
export function assertFixedTraceBlindedModelJudgePacket(packet: unknown): void {
  const record = plain(packet, 'model judge packet');
  exact(record, packetKeys, 'model judge packet');
  if (typeof record.packetId !== 'string' || !record.packetId.trim() || typeof record.prompt !== 'string' || !record.prompt.trim() || typeof record.scoringContext !== 'string' || !record.scoringContext.trim() || (record.candidateOutput !== null && typeof record.candidateOutput !== 'string') || !['complete', 'missing', 'malformed'].includes(record.outputCondition as string)) throw new Error('model judge packet is malformed');
  if (lockedV2TreatmentIdentifierPattern.test(`${record.prompt}\n${record.candidateOutput ?? ''}\n${record.scoringContext}`)) throw new Error('model judge packet contains an exact locked-v2 treatment identifier');
}

/** Structural safety only: unavailable custody prevents every positive admission. */
export function assessFixedTraceModelJudgedDiagnostic(input: unknown): Readonly<{ admitted: false; status: typeof FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT.status; blockers: readonly string[] }> {
  const blockers = [...FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT.blockers];
  try {
    const record = plain(input, 'model-judged diagnostic input');
    exact(record, ['budgetLedger', 'candidateOutputs', 'deterministicEvidence', 'judgments', 'manualReview', 'packets', 'randomization'], 'model-judged diagnostic input');
    if (!Array.isArray(record.packets) || !record.randomization || typeof record.randomization !== 'object' || Array.isArray(record.randomization) || !record.budgetLedger || typeof record.budgetLedger !== 'object' || Array.isArray(record.budgetLedger) || !['not_requested', 'optional_spot_check', 'optional_escalation'].includes(record.manualReview as string)) throw new Error('model-judged diagnostic input has invalid field types');
    const randomization = plain(record.randomization, 'model-judged diagnostic randomization');
    exact(randomization, ['lockedHoldoutDigest', 'scheduleDigest', 'seedCommitment'], 'model-judged diagnostic randomization');
    if (!hex(randomization.lockedHoldoutDigest) || !hex(randomization.scheduleDigest) || !hex(randomization.seedCommitment)) throw new Error('model-judged diagnostic randomization has invalid syntax');
    for (const packet of record.packets) assertFixedTraceBlindedModelJudgePacket(packet);
    assertRows(record.candidateOutputs, assignmentKeys, 'model-judged candidate output', (row) =>
      nonblank(row.assignmentId) && nonblank(row.caseId) && nonblank(row.stratum) && ['direct_generation', 'two_stage_llm_router', 'deterministic_policy_llm_fallback_hybrid'].includes(row.architectureArm as string) && Array.isArray(row.configurationCellIds) && row.configurationCellIds.every((id) => typeof id === 'string' && lockedV2CellIds.has(id)) && Number.isSafeInteger(row.repetition) && (row.repetition as number) > 0 && nonblank(row.packetId) && ['complete', 'missing', 'malformed'].includes(row.outputStatus as string) && ((row.outputStatus === 'complete' && nonblank(row.candidateOutput)) || (row.outputStatus !== 'complete' && row.candidateOutput === null)),
    );
    for (const candidate of record.candidateOutputs as Record<string, unknown>[]) {
      const ids = candidate.configurationCellIds as string[];
      const cells = ids.map((id) => lockedV2CellsById.get(id));
      const arm = candidate.architectureArm;
      if ((arm === 'direct_generation' && (cells.length !== 1 || cells[0]?.role !== 'generation')) ||
          ((arm === 'two_stage_llm_router' || arm === 'deterministic_policy_llm_fallback_hybrid') && (cells.length !== 2 || cells[0]?.role !== 'router' || cells[1]?.role !== 'generation'))) throw new Error('model-judged diagnostic has invalid architecture configuration cell roles or order');
    }
    assertRows(record.deterministicEvidence, deterministicKeys, 'model-judged deterministic evidence', (row) =>
      nonblank(row.assignmentId) && ['correctness', 'cost', 'latency', 'mutationSafety', 'promptInjection', 'provenance', 'returnedIdentity', 'toolCorrectness'].every((key) => typeof row[key] === 'boolean'),
    );
    assertRows(record.judgments, judgmentKeys, 'model-judged judgment', (row) =>
      nonblank(row.packetId) && nonblank(row.judgeProvider) && nonblank(row.judgeModel) && ['pass', 'fail', 'abstain', 'missing', 'malformed', 'refusal'].includes(row.outcome as string) && nonblank(row.reason),
    );
    const candidates = record.candidateOutputs as Record<string, unknown>[];
    const packets = record.packets as Record<string, unknown>[];
    const evidence = record.deterministicEvidence as Record<string, unknown>[];
    const judgments = record.judgments as Record<string, unknown>[];
    if (candidates.length === 0) throw new Error('model-judged diagnostic requires nonempty candidate assignments');
    const unique = (values: readonly string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`model-judged diagnostic has duplicate ${label}`); };
    unique(candidates.map((row) => row.assignmentId as string), 'assignment IDs');
    unique(candidates.map((row) => row.packetId as string), 'candidate packet IDs');
    unique(packets.map((row) => row.packetId as string), 'packet IDs');
    unique(evidence.map((row) => row.assignmentId as string), 'deterministic-evidence assignment IDs');
    const packetById = new Map(packets.map((row) => [row.packetId as string, row]));
    const evidenceIds = new Set(evidence.map((row) => row.assignmentId as string));
    if (packets.length !== candidates.length || evidence.length !== candidates.length) throw new Error('model-judged diagnostic has incomplete candidate packet or deterministic-evidence coverage');
    for (const candidate of candidates) {
      const packet = packetById.get(candidate.packetId as string);
      if (!packet || !evidenceIds.has(candidate.assignmentId as string)) throw new Error('model-judged diagnostic has orphan or missing candidate cross-link');
      if (candidate.outputStatus !== packet.outputCondition || candidate.candidateOutput !== packet.candidateOutput) throw new Error('model-judged diagnostic candidate output conflicts with packet condition or content');
      const candidateProviders = new Set((candidate.configurationCellIds as string[]).map((id) => lockedV2CellsById.get(id)!.provider));
      const expectedJudgeProviders = LOCKED_V2_CANDIDATE_PROVIDER_SUBSET.filter((provider) => !candidateProviders.has(provider));
      const packetJudgments = judgments.filter((judgment) => judgment.packetId === candidate.packetId);
      if (candidateProviders.size !== 1 || expectedJudgeProviders.length !== 2) throw new Error('model-judged diagnostic mixed-provider pipeline cannot have two provider-excluding judges');
      if (packetJudgments.length !== 2) throw new Error('model-judged diagnostic requires exactly two structural judge slots per packet');
      if (!packetJudgments.every((judgment) => expectedJudgeProviders.includes(judgment.judgeProvider as FixedTraceRegisteredCandidateProvider)) || new Set(packetJudgments.map((judgment) => judgment.judgeProvider)).size !== 2) throw new Error('model-judged diagnostic judges must be exactly the provider-excluding pair');
      unique(packetJudgments.map((judgment) => judgment.judgeProvider as string), 'judge providers per packet');
      unique(packetJudgments.map((judgment) => `${judgment.judgeProvider}:${judgment.judgeModel}`), 'judge provider/model identities per packet');
    }
    if (judgments.some((judgment) => !packetById.has(judgment.packetId as string))) throw new Error('model-judged diagnostic has orphan judgment');
    assertFixedTraceUnverifiedTrancheLedgerShape(record.budgetLedger);
  } catch (error) {
    blockers.push(error instanceof Error ? `invalid_unverified_input:${error.message}` : 'invalid_unverified_input');
  }
  return Object.freeze({ admitted: false, status: FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT.status, blockers: Object.freeze(blockers) });
}
