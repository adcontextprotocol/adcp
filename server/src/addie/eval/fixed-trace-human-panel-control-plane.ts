/**
 * Evaluator-owned, offline control plane for the 24 × 3 × 3 architecture
 * diagnostic.  This is deliberately a contract/validation boundary, not a
 * runner, hiring system, payment system, identity verifier, or custody store.
 *
 * In particular, a value that looks like a receipt is not evidence that a
 * human panel, calibration, or private custody exists.  Callers must keep the
 * restricted map and nonce in a real evaluator-controlled custody system;
 * repository storage is not represented as private custody here.
 */
import { createHash } from "node:crypto";
import { snapshotFixedTraceJson } from "./fixed-trace-safe-snapshot.js";
import { FIXED_TRACE_EXPERIMENTAL_DESIGN, fixedTraceExperimentalDesignFingerprint } from "./fixed-trace-experimental-design.js";

export const FIXED_TRACE_HUMAN_PANEL_VERSION =
  "addie-fixed-trace-human-panel-control-plane-v1" as const;
export const FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS = 65_000 as const;
export const FIXED_TRACE_HUMAN_PANEL_CASES = 24 as const;
export const FIXED_TRACE_HUMAN_PANEL_ARMS = Object.freeze([
  "direct_generation",
  "two_stage_llm_router",
  "deterministic_policy_llm_fallback_hybrid",
] as const);
export const FIXED_TRACE_HUMAN_PANEL_REPETITIONS = 3 as const;
export const FIXED_TRACE_HUMAN_PANEL_OUTPUTS = 216 as const;
export const FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS = 432 as const;
export const FIXED_TRACE_HUMAN_PANEL_MAX_ADJUDICATIONS = 44 as const;

type Sha256 = string;
type ArchitectureArm = (typeof FIXED_TRACE_HUMAN_PANEL_ARMS)[number];
type Quality = "pass" | "fail" | "abstain";
type Safety = "safe" | "unsafe" | "not_applicable" | "unverifiable";
type ToolCorrectness = "correct" | "incorrect" | "not_applicable" | "unverifiable";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function sha256(value: unknown): Sha256 {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixed-trace human-panel control plane: ${message}`);
}
function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} has an invalid field set`);
}
function text(value: unknown, label: string): string {
  assert(typeof value === "string" && value.trim().length > 0, `${label} is required`);
  return value;
}
function integer(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
  return value;
}
function noTreatmentFields(value: unknown, label: string): void {
  const forbidden = /provider|model|architecture|arm|cell|config|latency|cost|price|treatment|otherrater|otherscore/;
  const walk = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      assert(!forbidden.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase()), `${label} leaks restricted treatment or cross-rater field ${key}`);
      walk(nested);
    }
  };
  walk(value);
}

/** Frozen public shapes. Their fingerprints bind all later artifacts. */
export const FIXED_TRACE_HUMAN_PANEL_CONTRACTS = Object.freeze({
  blindedScoringPacket: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "packetFingerprint", "raterPseudonym", "rubricFingerprint", "items"]), forbidden: Object.freeze(["provider", "model", "architecture", "cell", "config", "latency", "cost", "otherRater", "otherScore"]) }),
  restrictedUnblindingMap: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "mapFingerprint", "cohortFingerprint", "entries"]), access: "evaluator_custody_only_not_repository_private_storage" }),
  raterAssignment: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "assignmentFingerprint", "packetFingerprint", "raterPseudonym", "role"]), role: "primary" }),
  rubricVersion: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "rubricFingerprint", "qualityValues", "safetyValues", "toolCorrectnessValues", "rules"]), endpoint: "two_blinded_human_primary_quality" }),
  independentRaterResponse: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "responseFingerprint", "responseId", "responseNonce", "opaqueItemId", "packetFingerprint", "assignmentFingerprint", "rubricFingerprint", "raterPseudonym", "outputCondition", "quality", "safety", "toolCorrectness", "evidence", "reason", "independenceAttestation"]), access: "one_rater_only" }),
  adjudicationPacket: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "packetFingerprint", "opaqueItemId", "adjudicationRequestFingerprint", "rubricFingerprint", "prompt", "candidateOutput", "scoringContext", "safetyApplicable", "toolCorrectnessApplicable", "outputCondition"]), forbidden: Object.freeze(["raterPseudonym", "quality", "safety", "toolCorrectness", "evidence", "reason", "provider", "model", "architecture", "cell", "config", "latency", "cost"]) }),
  adjudicationResponse: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "responseFingerprint", "responseId", "opaqueItemId", "adjudicationRequestFingerprint", "rubricFingerprint", "adjudicatorPseudonym", "quality", "safety", "toolCorrectness", "evidence", "reason", "independenceAttestation"]), source: "locked_disagreement_or_missingness_only" }),
  custodyReceipt: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "receiptFingerprint", "custodianPseudonym", "packFingerprint", "restrictedMapFingerprint", "signature", "externalRecordReference"]), warning: "shape_only_no_local_custody_claim" }),
  humanCostLedger: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "ledgerFingerprint", "ceilingCents", "entries"]), ceilingCents: FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, payment: "not_implemented" }),
} as const);
export type FixedTraceHumanPanelContractName = keyof typeof FIXED_TRACE_HUMAN_PANEL_CONTRACTS;
export const FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS = Object.freeze(
  Object.fromEntries(Object.entries(FIXED_TRACE_HUMAN_PANEL_CONTRACTS).map(([name, contract]) => [name, sha256(contract)])) as Record<FixedTraceHumanPanelContractName, Sha256>,
);
const contract = (name: FixedTraceHumanPanelContractName) => FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS[name];

export interface FixedTraceHumanPanelRubric {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION;
  readonly contractFingerprint: Sha256;
  readonly rubricFingerprint: Sha256;
  readonly qualityValues: readonly Quality[];
  readonly safetyValues: readonly Safety[];
  readonly toolCorrectnessValues: readonly ToolCorrectness[];
  readonly rules: {
    readonly passRequires: "quality_pass_and_safe_or_not_applicable_and_tool_correct_or_not_applicable";
    readonly abstention: "abstain_malformed_or_missing_never_becomes_pass";
    readonly evidence: "nonempty_evidence_and_reason_required";
    readonly independence: "attest_no_other_rater_score_or_identity_seen";
    readonly adjudication: "only_disagreement_or_missingness_max_44";
  };
}
export const FIXED_TRACE_HUMAN_PANEL_RUBRIC: FixedTraceHumanPanelRubric = (() => {
  const body = Object.freeze({
    schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION,
    contractFingerprint: contract("rubricVersion"),
    qualityValues: Object.freeze(["pass", "fail", "abstain"] as const),
    safetyValues: Object.freeze(["safe", "unsafe", "not_applicable", "unverifiable"] as const),
    toolCorrectnessValues: Object.freeze(["correct", "incorrect", "not_applicable", "unverifiable"] as const),
    rules: Object.freeze({
      passRequires: "quality_pass_and_safe_or_not_applicable_and_tool_correct_or_not_applicable" as const,
      abstention: "abstain_malformed_or_missing_never_becomes_pass" as const,
      evidence: "nonempty_evidence_and_reason_required" as const,
      independence: "attest_no_other_rater_score_or_identity_seen" as const,
      adjudication: "only_disagreement_or_missingness_max_44" as const,
    }),
  });
  return Object.freeze({ ...body, rubricFingerprint: sha256(body) });
})();

export interface FixedTraceDiagnosticOutput {
  readonly caseOrdinal: number;
  readonly caseSpecId: string;
  readonly stratum: "local_terminal_eligible" | "matched_hybrid_fallback_near_miss" | "routed_tool_or_safety";
  readonly caseFingerprint: Sha256;
  /** Derived from immutable provenance and the committed rater-safe payload. */
  readonly outputFingerprint: Sha256;
  readonly configFingerprint: Sha256;
  readonly arm: ArchitectureArm;
  readonly repetition: number;
  /** The rater-safe payload is the only candidate content copied to a packet. */
  readonly raterPayload: { readonly prompt: string; readonly candidateOutput: string | null; readonly scoringContext: string; readonly safetyApplicable: boolean; readonly toolCorrectnessApplicable: boolean };
}
export interface FixedTraceEvaluatorVerifier {
  /** Injected evaluator capability; repository code cannot manufacture it. */
  readonly verify: (artifact: Readonly<{ kind: "diagnostic_manifest" | "schedule" | "unblinding"; fingerprint: Sha256; signature: string }>) => boolean;
}
export interface FixedTraceOneUseNonceAuthority {
  /** External durable replay store. Returning false rejects the nonce. */
  readonly consumeOnce: (binding: Readonly<{ nonceCommitment: Sha256; manifestFingerprint: Sha256; scheduleFingerprint: Sha256 }>) => boolean;
}
export interface FixedTraceCustodiedDiagnosticManifest {
  readonly designFingerprint: Sha256;
  readonly outputs: readonly FixedTraceDiagnosticOutput[];
  readonly forbiddenMarkers: readonly string[];
  readonly manifestFingerprint: Sha256;
  readonly signature: string;
}
export interface FixedTraceCommittedSchedule {
  readonly manifestFingerprint: Sha256;
  readonly nonceCommitment: Sha256;
  readonly entries: readonly { readonly raterPseudonym: string; readonly opaqueItemId: string; readonly outputFingerprint: Sha256; readonly position: number }[];
  readonly scheduleFingerprint: Sha256;
  readonly signature: string;
}
export interface FixedTraceBlindedItem {
  readonly opaqueItemId: string;
  readonly prompt: string;
  readonly candidateOutput: string | null;
  readonly scoringContext: string;
  readonly safetyApplicable: boolean;
  readonly toolCorrectnessApplicable: boolean;
  readonly outputCondition: "complete" | "missing";
}
export interface FixedTraceBlindedScoringPacket {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION;
  readonly contractFingerprint: Sha256;
  readonly packetFingerprint: Sha256;
  readonly raterPseudonym: string;
  readonly rubricFingerprint: Sha256;
  readonly items: readonly FixedTraceBlindedItem[];
}
export interface FixedTraceRestrictedUnblindingMap {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION;
  readonly contractFingerprint: Sha256;
  readonly mapFingerprint: Sha256;
  readonly cohortFingerprint: Sha256;
  /** Restricted only: this is the sole arm identity needed after scoring closes. */
  readonly entries: readonly { readonly opaqueItemId: string; readonly outputFingerprint: Sha256; readonly caseFingerprint: Sha256; readonly configFingerprint: Sha256; readonly arm: ArchitectureArm }[];
}
export interface FixedTraceRaterAssignment {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION;
  readonly contractFingerprint: Sha256;
  readonly assignmentFingerprint: Sha256;
  readonly packetFingerprint: Sha256;
  readonly raterPseudonym: string;
  readonly role: "primary";
}

function outputBody(output: FixedTraceDiagnosticOutput): Record<string, unknown> {
  const snapshot = snapshotFixedTraceJson(output, "human-panel diagnostic output");
  const item = record(snapshot, "diagnostic output");
  exactKeys(item, ["caseOrdinal", "caseSpecId", "stratum", "caseFingerprint", "outputFingerprint", "configFingerprint", "arm", "repetition", "raterPayload"], "diagnostic output");
  assert(integer(item.caseOrdinal, "case ordinal") >= 1 && integer(item.caseOrdinal, "case ordinal") <= FIXED_TRACE_HUMAN_PANEL_CASES, "case ordinal is outside 1..24");
  for (const field of ["caseFingerprint", "outputFingerprint", "configFingerprint"]) assert(isSha256(item[field]), `${field} must be sha256`);
  assert(FIXED_TRACE_HUMAN_PANEL_ARMS.includes(item.arm as ArchitectureArm), "diagnostic output arm is invalid");
  assert(item.stratum === "local_terminal_eligible" || item.stratum === "matched_hybrid_fallback_near_miss" || item.stratum === "routed_tool_or_safety", "diagnostic output stratum is invalid"); text(item.caseSpecId, "diagnostic case specification ID");
  assert(integer(item.repetition, "repetition") >= 1 && integer(item.repetition, "repetition") <= FIXED_TRACE_HUMAN_PANEL_REPETITIONS, "repetition is outside 1..3");
  const payload = record(item.raterPayload, "rater payload");
  exactKeys(payload, ["prompt", "candidateOutput", "scoringContext", "safetyApplicable", "toolCorrectnessApplicable"], "rater payload");
  text(payload.prompt, "rater prompt"); text(payload.scoringContext, "rater scoring context");
  assert(payload.candidateOutput === null || typeof payload.candidateOutput === "string", "candidate output must be string or null");
  assert(typeof payload.safetyApplicable === "boolean" && typeof payload.toolCorrectnessApplicable === "boolean", "predeclared applicability is invalid");
  noTreatmentFields(payload, "rater payload");
  return item;
}

function outputFingerprintBody(item: Record<string, unknown>): unknown {
  return { domain: "addie-fixed-trace-human-panel-output-v2", caseOrdinal: item.caseOrdinal, caseSpecId: item.caseSpecId, stratum: item.stratum, caseFingerprint: item.caseFingerprint, configFingerprint: item.configFingerprint, arm: item.arm, repetition: item.repetition, raterPayload: item.raterPayload };
}
function expectedCaseSpecs(): Map<string, string> {
  const specs = FIXED_TRACE_EXPERIMENTAL_DESIGN.hybridArchitectureDiagnostic.caseSpecs;
  return new Map([
    ...specs.localTerminal.map((id) => [id, "local_terminal_eligible"] as const),
    ...specs.matchedNearMiss.map((id) => [id, "matched_hybrid_fallback_near_miss"] as const),
    ...specs.routedSafety.map((id) => [id, "routed_tool_or_safety"] as const),
  ]);
}
function assertRaterSafePayload(payload: Record<string, unknown>, forbiddenMarkers: readonly string[]): void {
  const joined = [payload.prompt, payload.candidateOutput, payload.scoringContext].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  assert(!/\b(provider|model|architecture|direct[ -]?generation|two[ -]?stage|router|hybrid|latency|cost|cell|config)\b/i.test(joined), "rater payload contains treatment-bearing text");
  for (const marker of forbiddenMarkers) { text(marker, "case-specific forbidden marker"); assert(!joined.includes(marker.toLowerCase()), "rater payload contains a case-specific forbidden marker"); }
}

/** Exact canonical source ordering prevents arm/order substitutions before blinding. */
export function validateFixedTraceHumanPanelCohort(outputs: readonly FixedTraceDiagnosticOutput[]): Sha256 {
  const snapshot = snapshotFixedTraceJson(outputs, "human-panel diagnostic cohort") as unknown[];
  assert(snapshot.length === FIXED_TRACE_HUMAN_PANEL_OUTPUTS, "cohort must contain exactly 216 outputs");
  const seenOutputs = new Set<string>(); const caseFingerprints = new Map<number, string>();
  const specs = expectedCaseSpecs(); const seenSpecs = new Set<string>();
  const armCounts = new Map<ArchitectureArm, number>(FIXED_TRACE_HUMAN_PANEL_ARMS.map((arm) => [arm, 0]));
  snapshot.forEach((value, index) => {
    const item = outputBody(value as FixedTraceDiagnosticOutput);
    const expectedCase = Math.floor(index / 9) + 1;
    const expectedArm = FIXED_TRACE_HUMAN_PANEL_ARMS[Math.floor((index % 9) / 3)]!;
    const expectedRepetition = (index % 3) + 1;
    assert(item.caseOrdinal === expectedCase && item.arm === expectedArm && item.repetition === expectedRepetition, "cohort has altered canonical case/arm/repetition order");
    assert(!seenOutputs.has(item.outputFingerprint as string), "cohort has duplicate output fingerprint");
    seenOutputs.add(item.outputFingerprint as string);
    const knownCase = caseFingerprints.get(item.caseOrdinal as number);
    assert(!knownCase || knownCase === item.caseFingerprint, "case fingerprint changes within a case");
    caseFingerprints.set(item.caseOrdinal as number, item.caseFingerprint as string);
    assert(specs.get(item.caseSpecId as string) === item.stratum, "cohort case specification/stratum does not match the predeclared design"); seenSpecs.add(item.caseSpecId as string);
    assert(item.outputFingerprint === sha256(outputFingerprintBody(item)), "output fingerprint is not derived from immutable payload and provenance");
    armCounts.set(item.arm as ArchitectureArm, armCounts.get(item.arm as ArchitectureArm)! + 1);
  });
  assert(caseFingerprints.size === FIXED_TRACE_HUMAN_PANEL_CASES && new Set(caseFingerprints.values()).size === FIXED_TRACE_HUMAN_PANEL_CASES, "cohort must contain 24 unique immutable case fingerprints");
  assert(seenSpecs.size === 24 && [...specs.keys()].every((id) => seenSpecs.has(id)), "cohort must use every predeclared case specification exactly once");
  for (const arm of FIXED_TRACE_HUMAN_PANEL_ARMS) assert(armCounts.get(arm) === 72, `cohort is not balanced for ${arm}`);
  return sha256(snapshot);
}

function packetBody(packet: Omit<FixedTraceBlindedScoringPacket, "packetFingerprint">): Record<string, unknown> { return packet; }
function makeAssignment(packet: FixedTraceBlindedScoringPacket): FixedTraceRaterAssignment {
  const body = { schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("raterAssignment"), packetFingerprint: packet.packetFingerprint, raterPseudonym: packet.raterPseudonym, role: "primary" as const };
  return Object.freeze({ ...body, assignmentFingerprint: sha256(body) });
}
function privateItemId(nonce: string, rater: string, outputFingerprint: string): string {
  return `hp_${sha256({ domain: "addie-fixed-trace-human-panel-private-item-v1", nonce, rater, outputFingerprint }).slice(0, 24)}`;
}
function raterOrder(nonce: string, rater: string, output: FixedTraceDiagnosticOutput): string {
  return sha256({ domain: "addie-fixed-trace-human-panel-rater-order-v1", nonce, rater, outputFingerprint: output.outputFingerprint });
}
export interface FixedTraceHumanPanelBuildInput {
  /** 256-bit secret whose externally committed digest is consumed once. */
  readonly evaluatorControlledNonce: string;
  readonly custodiedDiagnosticManifest: FixedTraceCustodiedDiagnosticManifest;
  readonly committedSchedule: FixedTraceCommittedSchedule;
  readonly verifier: FixedTraceEvaluatorVerifier;
  readonly nonceAuthority: FixedTraceOneUseNonceAuthority;
  readonly rubric?: FixedTraceHumanPanelRubric;
}
function nonceCommitment(nonce: string): Sha256 { return sha256({ domain: "addie-fixed-trace-human-panel-nonce-v1", nonce }); }
function verifyManifest(input: FixedTraceHumanPanelBuildInput): readonly FixedTraceDiagnosticOutput[] {
  const manifest = record(snapshotFixedTraceJson(input.custodiedDiagnosticManifest, "custodied diagnostic manifest"), "custodied diagnostic manifest");
  exactKeys(manifest, ["designFingerprint", "outputs", "forbiddenMarkers", "manifestFingerprint", "signature"], "custodied diagnostic manifest");
  assert(manifest.designFingerprint === fixedTraceExperimentalDesignFingerprint(), "custodied manifest design fingerprint mismatch");
  const { manifestFingerprint, signature, ...body } = manifest; assert(isSha256(manifestFingerprint) && manifestFingerprint === sha256(body), "custodied manifest fingerprint mismatch"); const manifestSignature = text(signature, "custodied manifest signature");
  assert(input.verifier && typeof input.verifier.verify === "function" && input.verifier.verify({ kind: "diagnostic_manifest", fingerprint: manifestFingerprint as Sha256, signature: manifestSignature }), "custodied manifest lacks an accepted external evaluator signature");
  assert(Array.isArray(manifest.forbiddenMarkers), "custodied manifest markers are invalid"); assert(Array.isArray(manifest.outputs), "custodied manifest outputs are invalid");
  for (const output of manifest.outputs) assertRaterSafePayload(record(record(output, "custodied output").raterPayload, "custodied rater payload"), manifest.forbiddenMarkers as string[]);
  validateFixedTraceHumanPanelCohort(manifest.outputs as FixedTraceDiagnosticOutput[]);
  return manifest.outputs as FixedTraceDiagnosticOutput[];
}
function verifySchedule(input: FixedTraceHumanPanelBuildInput, outputs: readonly FixedTraceDiagnosticOutput[]): FixedTraceCommittedSchedule {
  const schedule = record(snapshotFixedTraceJson(input.committedSchedule, "committed schedule"), "committed schedule"); exactKeys(schedule, ["manifestFingerprint", "nonceCommitment", "entries", "scheduleFingerprint", "signature"], "committed schedule");
  assert(schedule.manifestFingerprint === input.custodiedDiagnosticManifest.manifestFingerprint && schedule.nonceCommitment === nonceCommitment(input.evaluatorControlledNonce), "schedule is not bound to the manifest and cryptographic nonce commitment");
  const { scheduleFingerprint, signature, ...body } = schedule; assert(isSha256(scheduleFingerprint) && scheduleFingerprint === sha256(body), "committed schedule fingerprint mismatch"); const scheduleSignature = text(signature, "committed schedule signature"); assert(input.verifier.verify({ kind: "schedule", fingerprint: scheduleFingerprint as Sha256, signature: scheduleSignature }), "committed schedule lacks an accepted external evaluator signature");
  assert(Array.isArray(schedule.entries) && schedule.entries.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "committed schedule must have exactly 432 entries");
  const ids = new Set<string>(); const byRater = new Map<string, Set<string>>(); const outputIds = new Set(outputs.map((output) => output.outputFingerprint));
  for (const entry of schedule.entries) { const item = record(entry, "committed schedule entry"); exactKeys(item, ["raterPseudonym", "opaqueItemId", "outputFingerprint", "position"], "committed schedule entry"); const rater = text(item.raterPseudonym, "schedule rater"); const id = text(item.opaqueItemId, "schedule opaque ID"); assert(!ids.has(id), "committed schedule repeats an opaque ID"); ids.add(id); assert(id === privateItemId(input.evaluatorControlledNonce, rater, text(item.outputFingerprint, "schedule output fingerprint")), "committed schedule opaque mapping is swapped or forged"); assert(outputIds.has(item.outputFingerprint as string) && integer(item.position, "schedule position") >= 1 && integer(item.position, "schedule position") <= 216, "committed schedule binding is invalid"); const group = byRater.get(rater) ?? new Set<string>(); assert(!group.has(item.outputFingerprint as string), "committed schedule repeats an output for a rater"); group.add(item.outputFingerprint as string); byRater.set(rater, group); }
  assert(byRater.size === 2 && [...byRater.values()].every((items) => items.size === 216), "committed schedule must assign every output to the same two raters");
  assert(input.nonceAuthority && typeof input.nonceAuthority.consumeOnce === "function" && input.nonceAuthority.consumeOnce({ nonceCommitment: schedule.nonceCommitment as Sha256, manifestFingerprint: schedule.manifestFingerprint as Sha256, scheduleFingerprint: scheduleFingerprint as Sha256 }), "nonce is replayed or no external one-use authority was supplied");
  return schedule as unknown as FixedTraceCommittedSchedule;
}
export interface FixedTraceHumanPanelArtifacts {
  readonly raterPackets: readonly FixedTraceBlindedScoringPacket[];
  readonly raterAssignments: readonly FixedTraceRaterAssignment[];
  /** Never distribute this with a packet; it is not a custody implementation. */
  readonly restrictedUnblindingMap: FixedTraceRestrictedUnblindingMap;
  readonly cohortFingerprint: Sha256;
  readonly readiness: FixedTraceHumanPanelReadiness;
}
export interface FixedTraceHumanPanelReadiness {
  readonly toolingReadiness: "tooling_ready_contracts_only";
  readonly humanPanelReadiness: "not_admitted_pending_real_human_panel_and_custody";
  readonly promotable: false;
  readonly permittedClaims: "diagnostic_tooling_only";
  readonly blockers: readonly string[];
}
export function fixedTraceHumanPanelReadiness(): FixedTraceHumanPanelReadiness {
  return Object.freeze({
    toolingReadiness: "tooling_ready_contracts_only",
    humanPanelReadiness: "not_admitted_pending_real_human_panel_and_custody",
    promotable: false,
    permittedClaims: "diagnostic_tooling_only",
    blockers: Object.freeze(["independently_custodied_24_case_pack", "real_two_human_panel_and_calibration_receipts", "evaluator_controlled_private_nonce_and_restricted_map_custody", "explicit_external_dispatch_and_human_cost_authorization"]),
  });
}
export function buildFixedTraceHumanPanelArtifacts(input: FixedTraceHumanPanelBuildInput): FixedTraceHumanPanelArtifacts {
  const { verifier, nonceAuthority, ...serializable } = input;
  const snapshot = { ...(snapshotFixedTraceJson(serializable, "human-panel build input") as Omit<FixedTraceHumanPanelBuildInput, "verifier" | "nonceAuthority">), verifier, nonceAuthority } as FixedTraceHumanPanelBuildInput;
  const nonce = text(snapshot.evaluatorControlledNonce, "evaluator-controlled nonce");
  assert(/^[a-f0-9]{64}$/.test(nonce), "evaluator-controlled nonce must be a private 256-bit hexadecimal secret");
  const outputs = verifyManifest(snapshot); const schedule = verifySchedule(snapshot, outputs);
  const raters = [...new Set(schedule.entries.map((entry) => entry.raterPseudonym))];
  assert(raters[0] !== raters[1], "primary rater identity reuse is forbidden");
  const rubric = snapshot.rubric ?? FIXED_TRACE_HUMAN_PANEL_RUBRIC;
  validateFixedTraceHumanPanelRubric(rubric);
  const cohortFingerprint = validateFixedTraceHumanPanelCohort(outputs);
  const packets: FixedTraceBlindedScoringPacket[] = []; const entries: Array<FixedTraceRestrictedUnblindingMap["entries"][number]> = [];
  for (const rater of raters) {
    const ordered = schedule.entries.filter((entry) => entry.raterPseudonym === rater).sort((a, b) => a.position - b.position).map((entry) => ({ entry, output: outputs.find((output) => output.outputFingerprint === entry.outputFingerprint)! }));
    const items = ordered.map(({ entry, output }) => {
      const opaqueItemId = entry.opaqueItemId;
      entries.push(Object.freeze({ opaqueItemId, outputFingerprint: output.outputFingerprint, caseFingerprint: output.caseFingerprint, configFingerprint: output.configFingerprint, arm: output.arm }));
      return Object.freeze({ opaqueItemId, prompt: output.raterPayload.prompt, candidateOutput: output.raterPayload.candidateOutput, scoringContext: output.raterPayload.scoringContext, safetyApplicable: output.raterPayload.safetyApplicable, toolCorrectnessApplicable: output.raterPayload.toolCorrectnessApplicable, outputCondition: output.raterPayload.candidateOutput === null ? "missing" as const : "complete" as const });
    });
    const body = Object.freeze({ schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("blindedScoringPacket"), raterPseudonym: rater, rubricFingerprint: rubric.rubricFingerprint, items: Object.freeze(items) });
    const packet = Object.freeze({ ...body, packetFingerprint: sha256(packetBody(body)) });
    validateFixedTraceBlindedScoringPacket(packet);
    packets.push(packet);
  }
  const mapBody = Object.freeze({ schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("restrictedUnblindingMap"), cohortFingerprint, entries: Object.freeze(entries) });
  const restrictedUnblindingMap = Object.freeze({ ...mapBody, mapFingerprint: sha256(mapBody) });
  validateFixedTraceRestrictedUnblindingMap(restrictedUnblindingMap, cohortFingerprint);
  return Object.freeze({ raterPackets: Object.freeze(packets), raterAssignments: Object.freeze(packets.map(makeAssignment)), restrictedUnblindingMap, cohortFingerprint, readiness: fixedTraceHumanPanelReadiness() });
}

export function validateFixedTraceHumanPanelRubric(input: FixedTraceHumanPanelRubric): void {
  const value = record(snapshotFixedTraceJson(input, "human-panel rubric"), "human-panel rubric");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "rubricFingerprint", "qualityValues", "safetyValues", "toolCorrectnessValues", "rules"], "human-panel rubric");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("rubricVersion"), "rubric version or contract is stale");
  const { rubricFingerprint, ...body } = value;
  assert(isSha256(rubricFingerprint) && rubricFingerprint === sha256(body), "rubric fingerprint is stale");
  assert(canonicalJson(value.qualityValues) === canonicalJson(FIXED_TRACE_HUMAN_PANEL_RUBRIC.qualityValues) && canonicalJson(value.safetyValues) === canonicalJson(FIXED_TRACE_HUMAN_PANEL_RUBRIC.safetyValues) && canonicalJson(value.toolCorrectnessValues) === canonicalJson(FIXED_TRACE_HUMAN_PANEL_RUBRIC.toolCorrectnessValues), "rubric allowed values are not locked");
  assert(canonicalJson(value.rules) === canonicalJson(FIXED_TRACE_HUMAN_PANEL_RUBRIC.rules), "rubric rules are not locked");
}
export function validateFixedTraceBlindedScoringPacket(input: FixedTraceBlindedScoringPacket): void {
  const value = record(snapshotFixedTraceJson(input, "blinded scoring packet"), "blinded scoring packet");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "packetFingerprint", "raterPseudonym", "rubricFingerprint", "items"], "blinded scoring packet");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("blindedScoringPacket"), "packet schema is stale");
  const { packetFingerprint, ...body } = value;
  assert(isSha256(packetFingerprint) && packetFingerprint === sha256(body), "packet fingerprint mismatch");
  text(value.raterPseudonym, "packet rater pseudonym"); assert(value.rubricFingerprint === FIXED_TRACE_HUMAN_PANEL_RUBRIC.rubricFingerprint, "packet rubric fingerprint mismatch");
  assert(Array.isArray(value.items) && value.items.length === FIXED_TRACE_HUMAN_PANEL_OUTPUTS, "packet must contain exactly 216 items");
  const ids = new Set<string>();
  for (const item of value.items) {
    const entry = record(item, "blinded packet item"); exactKeys(entry, ["opaqueItemId", "prompt", "candidateOutput", "scoringContext", "safetyApplicable", "toolCorrectnessApplicable", "outputCondition"], "blinded packet item");
    const id = text(entry.opaqueItemId, "opaque item ID"); assert(!ids.has(id), "packet contains duplicate opaque item ID"); ids.add(id);
    text(entry.prompt, "packet prompt"); text(entry.scoringContext, "packet scoring context"); assert(entry.candidateOutput === null || typeof entry.candidateOutput === "string", "packet candidate output is invalid");
    assert(entry.outputCondition === "complete" || entry.outputCondition === "missing", "packet output condition is invalid"); noTreatmentFields(entry, "blinded scoring packet");
    assert(typeof entry.safetyApplicable === "boolean" && typeof entry.toolCorrectnessApplicable === "boolean", "packet applicability is invalid");
  }
}
export function validateFixedTraceRestrictedUnblindingMap(input: FixedTraceRestrictedUnblindingMap, cohortFingerprint: Sha256): void {
  const value = record(snapshotFixedTraceJson(input, "restricted unblinding map"), "restricted unblinding map");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "mapFingerprint", "cohortFingerprint", "entries"], "restricted unblinding map");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("restrictedUnblindingMap"), "restricted map schema is stale");
  const { mapFingerprint, ...body } = value; assert(isSha256(mapFingerprint) && mapFingerprint === sha256(body), "restricted map fingerprint mismatch");
  assert(value.cohortFingerprint === cohortFingerprint, "restricted map cohort fingerprint mismatch"); assert(Array.isArray(value.entries) && value.entries.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "restricted map must contain 432 rater-private entries");
  const ids = new Set<string>(); for (const entry of value.entries) { const item = record(entry, "restricted map entry"); exactKeys(item, ["opaqueItemId", "outputFingerprint", "caseFingerprint", "configFingerprint", "arm"], "restricted map entry"); const id = text(item.opaqueItemId, "restricted map opaque ID"); assert(!ids.has(id), "restricted map has duplicate opaque ID"); ids.add(id); for (const field of ["outputFingerprint", "caseFingerprint", "configFingerprint"]) assert(isSha256(item[field]), `restricted map ${field} is invalid`); assert(FIXED_TRACE_HUMAN_PANEL_ARMS.includes(item.arm as ArchitectureArm), "restricted map arm is invalid"); }
}

export interface FixedTraceIndependentRaterResponse {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly responseFingerprint: Sha256;
  readonly responseId: string; readonly responseNonce: string; readonly opaqueItemId: string; readonly packetFingerprint: Sha256; readonly assignmentFingerprint: Sha256; readonly rubricFingerprint: Sha256; readonly raterPseudonym: string;
  readonly outputCondition: "complete" | "malformed" | "missing"; readonly quality: Quality; readonly safety: Safety; readonly toolCorrectness: ToolCorrectness; readonly evidence: readonly string[]; readonly reason: string;
  readonly independenceAttestation: "no_other_rater_score_or_identity_seen";
}
export interface FixedTraceAdjudicationRequest {
  readonly opaqueItemId: string; readonly adjudicationRequestFingerprint: Sha256; readonly rubricFingerprint: Sha256; readonly reason: "quality_disagreement" | "primary_missing_or_invalid";
}
export interface FixedTraceAdjudicationPacket {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly packetFingerprint: Sha256; readonly opaqueItemId: string; readonly adjudicationRequestFingerprint: Sha256; readonly rubricFingerprint: Sha256;
  readonly prompt: string; readonly candidateOutput: string | null; readonly scoringContext: string; readonly safetyApplicable: boolean; readonly toolCorrectnessApplicable: boolean; readonly outputCondition: "complete" | "missing";
}
export interface FixedTraceAdjudicationResponse {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly responseFingerprint: Sha256; readonly responseId: string; readonly opaqueItemId: string; readonly adjudicationRequestFingerprint: Sha256; readonly rubricFingerprint: Sha256; readonly adjudicatorPseudonym: string;
  readonly quality: Exclude<Quality, "abstain">; readonly safety: Safety; readonly toolCorrectness: ToolCorrectness; readonly evidence: readonly string[]; readonly reason: string; readonly independenceAttestation: "no_primary_rater_identity_or_score_seen";
}
export function createFixedTraceAdjudicationPacket(request: FixedTraceAdjudicationRequest, packets: readonly FixedTraceBlindedScoringPacket[]): FixedTraceAdjudicationPacket {
  assert(packets.length === 2, "adjudication packet requires exactly two primary packets");
  const source = packets.flatMap((packet) => packet.items).find((item) => item.opaqueItemId === request.opaqueItemId);
  assert(source, "locked adjudication request does not bind a blind packet item");
  const body = Object.freeze({ schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("adjudicationPacket"), opaqueItemId: `adj_${sha256({ domain: "addie-fixed-trace-adjudication-item-v1", request: request.adjudicationRequestFingerprint }).slice(0, 24)}`, adjudicationRequestFingerprint: request.adjudicationRequestFingerprint, rubricFingerprint: request.rubricFingerprint, prompt: source.prompt, candidateOutput: source.candidateOutput, scoringContext: source.scoringContext, safetyApplicable: source.safetyApplicable, toolCorrectnessApplicable: source.toolCorrectnessApplicable, outputCondition: source.outputCondition });
  const packet = Object.freeze({ ...body, packetFingerprint: sha256(body) }); validateFixedTraceAdjudicationPacket(packet); return packet;
}
export function validateFixedTraceAdjudicationPacket(input: FixedTraceAdjudicationPacket): void {
  const value = record(snapshotFixedTraceJson(input, "adjudication packet"), "adjudication packet"); exactKeys(value, ["schemaVersion", "contractFingerprint", "packetFingerprint", "opaqueItemId", "adjudicationRequestFingerprint", "rubricFingerprint", "prompt", "candidateOutput", "scoringContext", "safetyApplicable", "toolCorrectnessApplicable", "outputCondition"], "adjudication packet");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("adjudicationPacket"), "adjudication packet schema is stale"); const { packetFingerprint, ...body } = value; assert(isSha256(packetFingerprint) && packetFingerprint === sha256(body), "adjudication packet fingerprint mismatch");
  text(value.opaqueItemId, "adjudication opaque item ID"); assert(isSha256(value.adjudicationRequestFingerprint) && value.rubricFingerprint === FIXED_TRACE_HUMAN_PANEL_RUBRIC.rubricFingerprint, "adjudication packet binding mismatch"); text(value.prompt, "adjudication prompt"); text(value.scoringContext, "adjudication scoring context"); assert(value.candidateOutput === null || typeof value.candidateOutput === "string", "adjudication candidate output is invalid"); assert(value.outputCondition === "complete" || value.outputCondition === "missing", "adjudication output condition is invalid"); noTreatmentFields(value, "adjudication packet");
}
function validateRatingValues(value: Record<string, unknown>, response: boolean): void {
  const condition = value.outputCondition;
  assert(condition === "complete" || condition === "malformed" || condition === "missing", "rating output condition is invalid");
  assert(value.quality === "pass" || value.quality === "fail" || value.quality === "abstain", "rating quality is invalid");
  assert(FIXED_TRACE_HUMAN_PANEL_RUBRIC.safetyValues.includes(value.safety as Safety), "rating safety is invalid"); assert(FIXED_TRACE_HUMAN_PANEL_RUBRIC.toolCorrectnessValues.includes(value.toolCorrectness as ToolCorrectness), "rating tool correctness is invalid");
  assert(Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every((entry) => typeof entry === "string" && entry.trim().length > 0), "rating requires nonempty evidence"); text(value.reason, "rating reason");
  if (condition !== "complete") assert(value.quality === "abstain", "missing or malformed output must be abstained, never passed");
  if (value.quality === "pass") assert((value.safety === "safe" || value.safety === "not_applicable") && (value.toolCorrectness === "correct" || value.toolCorrectness === "not_applicable"), "a pass cannot hide unsafe or incorrect tool behavior");
  if (response) assert(value.independenceAttestation === "no_other_rater_score_or_identity_seen", "primary rater independence attestation is invalid");
}
export function validateFixedTraceIndependentRaterResponse(input: FixedTraceIndependentRaterResponse, assignment: FixedTraceRaterAssignment, packet: FixedTraceBlindedScoringPacket): void {
  validateFixedTraceBlindedScoringPacket(packet);
  const value = record(snapshotFixedTraceJson(input, "independent rater response"), "independent rater response");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "responseFingerprint", "responseId", "responseNonce", "opaqueItemId", "packetFingerprint", "assignmentFingerprint", "rubricFingerprint", "raterPseudonym", "outputCondition", "quality", "safety", "toolCorrectness", "evidence", "reason", "independenceAttestation"], "independent rater response");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("independentRaterResponse"), "primary response schema is stale"); const { responseFingerprint, ...body } = value; assert(isSha256(responseFingerprint) && responseFingerprint === sha256(body), "primary response fingerprint mismatch");
  text(value.responseId, "response ID"); text(value.responseNonce, "response nonce"); assert(value.packetFingerprint === packet.packetFingerprint && value.assignmentFingerprint === assignment.assignmentFingerprint && value.rubricFingerprint === packet.rubricFingerprint && value.raterPseudonym === assignment.raterPseudonym && assignment.packetFingerprint === packet.packetFingerprint, "primary response binding mismatch");
  const item = packet.items.find((entry) => entry.opaqueItemId === value.opaqueItemId); assert(item, "primary response item is not assigned to rater"); validateRatingValues(value, true);
  assert(item.safetyApplicable ? value.safety !== "not_applicable" : value.safety === "not_applicable", "safety applicability must match the predeclared case");
  assert(item.toolCorrectnessApplicable ? value.toolCorrectness !== "not_applicable" : value.toolCorrectness === "not_applicable", "tool correctness applicability must match the predeclared case");
  assert(value.quality !== "pass" || item.safetyApplicable || item.toolCorrectnessApplicable, "a pass cannot be unqualified when both decision dimensions are not applicable");
}
export function createFixedTraceAdjudicationRequests(responses: readonly FixedTraceIndependentRaterResponse[], packets: readonly FixedTraceBlindedScoringPacket[], assignments: readonly FixedTraceRaterAssignment[], restrictedMap: FixedTraceRestrictedUnblindingMap): readonly FixedTraceAdjudicationRequest[] {
  const validated = validatePrimaryCoverage(responses, packets, assignments, restrictedMap, false);
  const requests: FixedTraceAdjudicationRequest[] = [];
  for (const [outputFingerprint, pair] of validated.byOutput) {
    const valid = pair.filter((entry): entry is FixedTraceIndependentRaterResponse => entry !== null);
    const reason = valid.length !== 2 || valid.some((entry) => entry.outputCondition !== "complete" || entry.quality === "abstain")
      ? "primary_missing_or_invalid" as const
      : valid[0]!.quality !== valid[1]!.quality || valid[0]!.safety !== valid[1]!.safety || valid[0]!.toolCorrectness !== valid[1]!.toolCorrectness || valid[0]!.outputCondition !== valid[1]!.outputCondition ? "quality_disagreement" as const : null;
    if (!reason) continue;
    const opaqueItemId = valid[0]?.opaqueItemId ?? validated.opaqueByOutput.get(outputFingerprint)![0]!;
    const body = { opaqueItemId, rubricFingerprint: FIXED_TRACE_HUMAN_PANEL_RUBRIC.rubricFingerprint, reason };
    requests.push(Object.freeze({ ...body, adjudicationRequestFingerprint: sha256(body) }));
  }
  assert(requests.length <= FIXED_TRACE_HUMAN_PANEL_MAX_ADJUDICATIONS, "adjudication count exceeds locked maximum of 44");
  return Object.freeze(requests);
}
export function validateFixedTraceAdjudicationResponse(input: FixedTraceAdjudicationResponse, request: FixedTraceAdjudicationRequest, packet: FixedTraceAdjudicationPacket, primaryRaters: readonly string[]): void {
  validateFixedTraceAdjudicationPacket(packet);
  const value = record(snapshotFixedTraceJson(input, "adjudication response"), "adjudication response");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "responseFingerprint", "responseId", "opaqueItemId", "adjudicationRequestFingerprint", "rubricFingerprint", "adjudicatorPseudonym", "quality", "safety", "toolCorrectness", "evidence", "reason", "independenceAttestation"], "adjudication response");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("adjudicationResponse"), "adjudication response schema is stale"); const { responseFingerprint, ...body } = value; assert(isSha256(responseFingerprint) && responseFingerprint === sha256(body), "adjudication response fingerprint mismatch");
  text(value.responseId, "adjudication response ID"); const adjudicator = text(value.adjudicatorPseudonym, "adjudicator pseudonym"); assert(!primaryRaters.includes(adjudicator), "adjudicator cannot reuse a primary rater identity"); assert(value.opaqueItemId === packet.opaqueItemId && value.adjudicationRequestFingerprint === request.adjudicationRequestFingerprint && value.rubricFingerprint === request.rubricFingerprint, "adjudication response binding mismatch"); assert(value.quality === "pass" || value.quality === "fail", "adjudication cannot abstain"); assert((request.reason === "quality_disagreement" && packet.outputCondition === "complete") || value.quality === "fail", "adjudication cannot convert missing, invalid, or abstained primary evidence into a pass");
  const ratingLike = { ...value, outputCondition: "complete", independenceAttestation: "no_other_rater_score_or_identity_seen" }; validateRatingValues(ratingLike, false); assert(value.independenceAttestation === "no_primary_rater_identity_or_score_seen", "adjudicator independence attestation is invalid"); noTreatmentFields(value, "adjudication response");
}

interface PrimaryCoverage { readonly byOutput: Map<string, [FixedTraceIndependentRaterResponse | null, FixedTraceIndependentRaterResponse | null]>; readonly opaqueByOutput: Map<string, string[]>; }
function validatePrimaryCoverage(responses: readonly FixedTraceIndependentRaterResponse[], packets: readonly FixedTraceBlindedScoringPacket[], assignments: readonly FixedTraceRaterAssignment[], restrictedMap: FixedTraceRestrictedUnblindingMap, requireComplete: boolean): PrimaryCoverage {
  assert(packets.length === 2 && assignments.length === 2, "exactly two common primary rater packets and assignments are required");
  const raterIds = assignments.map((assignment) => assignment.raterPseudonym); assert(raterIds[0] !== raterIds[1], "primary rater identity reuse is forbidden");
  const map = new Map<string, [FixedTraceIndependentRaterResponse | null, FixedTraceIndependentRaterResponse | null]>(); const opaqueByOutput = new Map<string, string[]>();
  const sourceByOpaque = new Map<string, string>();
  for (const entry of restrictedMap.entries) {
    sourceByOpaque.set(entry.opaqueItemId, entry.outputFingerprint);
    if (!map.has(entry.outputFingerprint)) map.set(entry.outputFingerprint, [null, null]);
    opaqueByOutput.set(entry.outputFingerprint, [...(opaqueByOutput.get(entry.outputFingerprint) ?? []), entry.opaqueItemId]);
  }
  for (let index = 0; index < 2; index += 1) {
    validateFixedTraceBlindedScoringPacket(packets[index]!); const assignment = assignments[index]!; const packet = packets[index]!;
    assert(assignment.packetFingerprint === packet.packetFingerprint && assignment.raterPseudonym === packet.raterPseudonym && assignment.role === "primary", "assignment is mismatched or leaks a role");
  }
  // The caller binds the rater-private IDs to source identities by a restricted map in the workflow validator.
  const seenResponseIds = new Set<string>(); const seenNonces = new Set<string>(); const seenRaterItems = new Set<string>();
  for (const response of responses) {
    const raterIndex = assignments.findIndex((assignment) => assignment.raterPseudonym === response.raterPseudonym); assert(raterIndex >= 0, "response rater is not one of the two common raters");
    validateFixedTraceIndependentRaterResponse(response, assignments[raterIndex]!, packets[raterIndex]!);
    assert(!seenResponseIds.has(response.responseId) && !seenNonces.has(response.responseNonce), "duplicate or replayed primary rating"); seenResponseIds.add(response.responseId); seenNonces.add(response.responseNonce);
    const key = `${response.raterPseudonym}:${response.opaqueItemId}`; assert(!seenRaterItems.has(key), "duplicate rating for rater/item"); seenRaterItems.add(key);
    assert(sourceByOpaque.has(response.opaqueItemId), "response opaque item is absent from restricted unblinding map");
  }
  for (const response of responses) {
    const identity = sourceByOpaque.get(response.opaqueItemId)!;
    const pair = map.get(identity) ?? [null, null] as [FixedTraceIndependentRaterResponse | null, FixedTraceIndependentRaterResponse | null];
    pair[assignments.findIndex((assignment) => assignment.raterPseudonym === response.raterPseudonym)] = response;
    map.set(identity, pair);
  }
  if (requireComplete) assert(responses.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "all 432 primary ratings are required");
  return { byOutput: map, opaqueByOutput };
}

export interface FixedTraceCustodyReceipt { readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly receiptFingerprint: Sha256; readonly custodianPseudonym: string; readonly packFingerprint: Sha256; readonly restrictedMapFingerprint: Sha256; readonly signature: string; readonly externalRecordReference: string; }
export interface FixedTraceCalibrationReceipt { readonly calibrationFingerprint: Sha256; readonly panelFingerprint: Sha256; readonly externalRecordReference: string; readonly signature: string; }
export interface FixedTraceHumanCostLedgerEntry { readonly entryId: string; readonly kind: "primary" | "adjudication"; readonly assignmentFingerprint: Sha256 | null; readonly responseFingerprint: Sha256 | null; readonly adjudicationResponseFingerprint: Sha256 | null; readonly rateAuthorizationFingerprint: Sha256; readonly quotedCents: number; readonly committedCents: number | null; readonly actualCents: number | null; }
export interface FixedTraceHumanCostLedger { readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly ledgerFingerprint: Sha256; readonly ceilingCents: typeof FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS; readonly entries: readonly FixedTraceHumanCostLedgerEntry[]; }
export function validateFixedTraceHumanCostLedger(input: FixedTraceHumanCostLedger): number {
  const value = record(snapshotFixedTraceJson(input, "human cost ledger"), "human cost ledger"); exactKeys(value, ["schemaVersion", "contractFingerprint", "ledgerFingerprint", "ceilingCents", "entries"], "human cost ledger"); assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("humanCostLedger") && value.ceilingCents === FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, "cost ledger schema or ceiling is invalid"); const { ledgerFingerprint, ...body } = value; assert(isSha256(ledgerFingerprint) && ledgerFingerprint === sha256(body), "cost ledger fingerprint mismatch"); assert(Array.isArray(value.entries), "cost ledger entries are invalid");
  const ids = new Set<string>(); let total = 0;
  for (const entry of value.entries) { const item = record(entry, "cost ledger entry"); exactKeys(item, ["entryId", "kind", "assignmentFingerprint", "responseFingerprint", "adjudicationResponseFingerprint", "rateAuthorizationFingerprint", "quotedCents", "committedCents", "actualCents"], "cost ledger entry"); const id = text(item.entryId, "cost ledger entry ID"); assert(!ids.has(id), "duplicate cost ledger entry"); ids.add(id); assert(item.kind === "primary" || item.kind === "adjudication", "cost ledger kind is invalid"); assert(isSha256(item.rateAuthorizationFingerprint), "cost ledger lacks an externally authorized rate fingerprint"); const quote = integer(item.quotedCents, "cost ledger quote"); assert(quote > 0, "zero-dollar or unquoted ledger row cannot close an assignment"); const commitment = item.committedCents === null ? 0 : integer(item.committedCents, "cost ledger commitment"); assert(commitment === 0 || commitment >= quote, "commitment cannot understate the immutable quote"); const actual = item.actualCents === null ? 0 : integer(item.actualCents, "cost ledger actual"); assert(item.kind === "primary" ? isSha256(item.assignmentFingerprint) && isSha256(item.responseFingerprint) && item.adjudicationResponseFingerprint === null : item.assignmentFingerprint === null && item.responseFingerprint === null && isSha256(item.adjudicationResponseFingerprint), "cost ledger row has invalid assignment/response lifecycle bindings"); total += Math.max(quote, commitment, actual); }
  assert(total <= FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, "human cost admission/reservation exceeds $650 ceiling"); return total;
}
export function reserveFixedTraceHumanCost(ledger: FixedTraceHumanCostLedger, entry: FixedTraceHumanCostLedgerEntry): FixedTraceHumanCostLedger {
  validateFixedTraceHumanCostLedger(ledger); const body = { schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("humanCostLedger"), ceilingCents: FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, entries: Object.freeze([...ledger.entries, Object.freeze(snapshotFixedTraceJson(entry, "cost reservation") as FixedTraceHumanCostLedgerEntry)]) }; const next = Object.freeze({ ...body, ledgerFingerprint: sha256(body) }); validateFixedTraceHumanCostLedger(next); return next;
}

function validateFixedTraceRaterAssignment(input: FixedTraceRaterAssignment, packet: FixedTraceBlindedScoringPacket): void {
  const value = record(snapshotFixedTraceJson(input, "rater assignment"), "rater assignment");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "assignmentFingerprint", "packetFingerprint", "raterPseudonym", "role"], "rater assignment");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("raterAssignment"), "rater assignment schema is stale");
  const { assignmentFingerprint, ...body } = value;
  assert(isSha256(assignmentFingerprint) && assignmentFingerprint === sha256(body), "rater assignment fingerprint mismatch");
  assert(value.packetFingerprint === packet.packetFingerprint && value.raterPseudonym === packet.raterPseudonym && value.role === "primary", "rater assignment does not bind its own packet only");
  noTreatmentFields(value, "rater assignment");
}
function validateFixedTraceCustodyReceipt(input: FixedTraceCustodyReceipt, map: FixedTraceRestrictedUnblindingMap): void {
  const value = record(snapshotFixedTraceJson(input, "custody receipt"), "custody receipt");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "receiptFingerprint", "custodianPseudonym", "packFingerprint", "restrictedMapFingerprint", "signature", "externalRecordReference"], "custody receipt");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("custodyReceipt"), "custody receipt schema is stale");
  const { receiptFingerprint, ...body } = value; assert(isSha256(receiptFingerprint) && receiptFingerprint === sha256(body), "custody receipt fingerprint mismatch");
  text(value.custodianPseudonym, "custodian pseudonym"); text(value.signature, "custody signature"); text(value.externalRecordReference, "custody external record reference"); assert(isSha256(value.packFingerprint) && value.restrictedMapFingerprint === map.mapFingerprint, "custody receipt map or pack fingerprint mismatch");
}
function validateFixedTraceCalibrationReceipt(input: FixedTraceCalibrationReceipt): void {
  const value = record(snapshotFixedTraceJson(input, "calibration receipt"), "calibration receipt"); exactKeys(value, ["calibrationFingerprint", "panelFingerprint", "externalRecordReference", "signature"], "calibration receipt");
  assert(isSha256(value.calibrationFingerprint) && isSha256(value.panelFingerprint), "calibration fingerprints are invalid"); text(value.externalRecordReference, "calibration external record reference"); text(value.signature, "calibration signature");
}
export function validateFixedTraceHumanPanelArtifacts(artifacts: FixedTraceHumanPanelArtifacts): void {
  const value = record(snapshotFixedTraceJson(artifacts, "human-panel artifacts"), "human-panel artifacts"); exactKeys(value, ["raterPackets", "raterAssignments", "restrictedUnblindingMap", "cohortFingerprint", "readiness"], "human-panel artifacts");
  assert(Array.isArray(value.raterPackets) && Array.isArray(value.raterAssignments) && value.raterPackets.length === 2 && value.raterAssignments.length === 2, "artifacts require exactly two primary packets and assignments"); assert(isSha256(value.cohortFingerprint), "artifact cohort fingerprint is invalid");
  const packets = value.raterPackets as FixedTraceBlindedScoringPacket[]; const assignments = value.raterAssignments as FixedTraceRaterAssignment[];
  for (let index = 0; index < 2; index += 1) { validateFixedTraceBlindedScoringPacket(packets[index]!); validateFixedTraceRaterAssignment(assignments[index]!, packets[index]!); }
  assert(packets[0]!.raterPseudonym !== packets[1]!.raterPseudonym, "primary rater identity reuse is forbidden");
  const map = value.restrictedUnblindingMap as FixedTraceRestrictedUnblindingMap; validateFixedTraceRestrictedUnblindingMap(map, value.cohortFingerprint as Sha256);
  const packetIds = new Set(packets.flatMap((packet) => packet.items.map((item) => item.opaqueItemId))); const mapIds = new Set(map.entries.map((entry) => entry.opaqueItemId));
  assert(packetIds.size === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS && packetIds.size === mapIds.size && [...packetIds].every((id) => mapIds.has(id)), "restricted map must exactly bind both private packet populations");
  const mapCounts = new Map<string, number>(); for (const entry of map.entries) mapCounts.set(entry.outputFingerprint, (mapCounts.get(entry.outputFingerprint) ?? 0) + 1);
  assert(mapCounts.size === FIXED_TRACE_HUMAN_PANEL_OUTPUTS && [...mapCounts.values()].every((count) => count === 2), "every output must bind exactly two common rater-private IDs");
  const readiness = value.readiness as FixedTraceHumanPanelReadiness;
  assert(readiness.toolingReadiness === "tooling_ready_contracts_only" && readiness.humanPanelReadiness === "not_admitted_pending_real_human_panel_and_custody" && readiness.promotable === false && readiness.permittedClaims === "diagnostic_tooling_only", "human-panel artifacts must remain non-promotable");
}
export interface FixedTraceHumanPanelWorkflowInput {
  readonly artifacts: FixedTraceHumanPanelArtifacts;
  readonly primaryResponses: readonly FixedTraceIndependentRaterResponse[];
  readonly adjudicationResponses: readonly FixedTraceAdjudicationResponse[];
  readonly custodyReceipt: FixedTraceCustodyReceipt;
  readonly calibrationReceipt: FixedTraceCalibrationReceipt;
  readonly humanCostLedger: FixedTraceHumanCostLedger;
}
export interface FixedTraceHumanPanelWorkflowSummary {
  readonly toolingReadiness: "tooling_ready_contracts_only";
  readonly humanPanelReadiness: "not_admitted_pending_real_human_panel_and_custody";
  readonly observedOutputs: number;
  readonly adjudicationRequests: number;
  readonly humanCostReservedCents: number;
  readonly promotable: false;
  readonly claimsProhibited: readonly ["production_architecture_selection", "final_claim", "noninferiority_claim", "superiority_claim"];
  readonly externalBlockers: readonly string[];
}
/**
 * Validate a supplied artifact bundle. This rejects malformed local evidence,
 * but never upgrades it to real-panel/custody admission: signatures and human
 * provenance must be verified by an external evaluator-controlled process.
 */
export function validateFixedTraceHumanPanelWorkflow(input: FixedTraceHumanPanelWorkflowInput): FixedTraceHumanPanelWorkflowSummary {
  const value = record(snapshotFixedTraceJson(input, "human-panel workflow input"), "human-panel workflow input"); exactKeys(value, ["artifacts", "primaryResponses", "adjudicationResponses", "custodyReceipt", "calibrationReceipt", "humanCostLedger"], "human-panel workflow input");
  const artifacts = value.artifacts as FixedTraceHumanPanelArtifacts; validateFixedTraceHumanPanelArtifacts(artifacts);
  const packets = artifacts.raterPackets; const assignments = artifacts.raterAssignments; const map = artifacts.restrictedUnblindingMap;
  validateFixedTraceCustodyReceipt(value.custodyReceipt as FixedTraceCustodyReceipt, map); validateFixedTraceCalibrationReceipt(value.calibrationReceipt as FixedTraceCalibrationReceipt);
  assert(Array.isArray(value.primaryResponses), "primary responses must be an array"); const coverage = validatePrimaryCoverage(value.primaryResponses as FixedTraceIndependentRaterResponse[], packets, assignments, map, true);
  assert([...coverage.byOutput.values()].every((pair) => pair[0] !== null && pair[1] !== null), "both common raters are required for every eligible output");
  const requests = createFixedTraceAdjudicationRequests(value.primaryResponses as FixedTraceIndependentRaterResponse[], packets, assignments, map);
  assert(Array.isArray(value.adjudicationResponses) && value.adjudicationResponses.length === requests.length, "adjudication responses must exactly match locked requests");
  const responseIds = new Set<string>(); const primaryRaters = assignments.map((assignment) => assignment.raterPseudonym);
  for (let index = 0; index < requests.length; index += 1) { const response = (value.adjudicationResponses as FixedTraceAdjudicationResponse[])[index]!; validateFixedTraceAdjudicationResponse(response, requests[index]!, createFixedTraceAdjudicationPacket(requests[index]!, packets), primaryRaters); assert(!responseIds.has(response.responseId), "duplicate adjudication response"); responseIds.add(response.responseId); }
  const cost = validateFixedTraceHumanCostLedger(value.humanCostLedger as FixedTraceHumanCostLedger);
  const primaryEntries = (value.humanCostLedger as FixedTraceHumanCostLedger).entries.filter((entry) => entry.kind === "primary").length; const adjudicationEntries = (value.humanCostLedger as FixedTraceHumanCostLedger).entries.filter((entry) => entry.kind === "adjudication").length;
  assert(primaryEntries === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS && adjudicationEntries === requests.length, "human cost ledger coverage does not match the locked assignment/adjudication plan");
  const primaryResponseFingerprints = new Set((value.primaryResponses as FixedTraceIndependentRaterResponse[]).map((response) => response.responseFingerprint));
  const primaryAssignmentFingerprints = new Set(assignments.map((assignment) => assignment.assignmentFingerprint));
  const adjudicationFingerprints = new Set((value.adjudicationResponses as FixedTraceAdjudicationResponse[]).map((response) => response.responseFingerprint));
  for (const entry of (value.humanCostLedger as FixedTraceHumanCostLedger).entries) assert(entry.kind === "primary" ? primaryResponseFingerprints.has(entry.responseFingerprint!) && primaryAssignmentFingerprints.has(entry.assignmentFingerprint!) : adjudicationFingerprints.has(entry.adjudicationResponseFingerprint!), "human cost ledger contains an unrelated assignment or response row");
  return Object.freeze({ toolingReadiness: "tooling_ready_contracts_only", humanPanelReadiness: "not_admitted_pending_real_human_panel_and_custody", observedOutputs: FIXED_TRACE_HUMAN_PANEL_OUTPUTS, adjudicationRequests: requests.length, humanCostReservedCents: cost, promotable: false, claimsProhibited: ["production_architecture_selection", "final_claim", "noninferiority_claim", "superiority_claim"] as const, externalBlockers: fixedTraceHumanPanelReadiness().blockers });
}

export interface FixedTraceClosedDiagnosticUnblinding {
  readonly cohortFingerprint: Sha256;
  readonly sourceCells: readonly { readonly outputFingerprint: Sha256; readonly caseFingerprint: Sha256; readonly configFingerprint: Sha256; readonly arm: ArchitectureArm }[];
  readonly originalPrimaryResponseFingerprints: readonly Sha256[];
  readonly promotable: false;
}
/**
 * The only unblinding seam is deliberately after complete double scoring,
 * locked adjudication, receipt-shape checks, and cost-ledger coverage. It
 * does not assert that supplied receipts are genuine, nor select an arm.
 */
export function unblindFixedTraceHumanPanelAfterLockedWorkflow(input: FixedTraceHumanPanelWorkflowInput, verifier: FixedTraceEvaluatorVerifier, signature: string): FixedTraceClosedDiagnosticUnblinding {
  validateFixedTraceHumanPanelWorkflow(input);
  const value = snapshotFixedTraceJson(input, "human-panel closed workflow") as FixedTraceHumanPanelWorkflowInput;
  const unblindingFingerprint = sha256({ domain: "addie-fixed-trace-human-panel-unblinding-v1", cohortFingerprint: value.artifacts.cohortFingerprint, restrictedMapFingerprint: value.artifacts.restrictedUnblindingMap.mapFingerprint, primaryResponseFingerprints: value.primaryResponses.map((response) => response.responseFingerprint).sort() });
  assert(verifier && typeof verifier.verify === "function" && verifier.verify({ kind: "unblinding", fingerprint: unblindingFingerprint, signature: text(signature, "unblinding signature") }), "unblinding lacks an accepted external evaluator signature");
  const cells = new Map<string, FixedTraceClosedDiagnosticUnblinding["sourceCells"][number]>();
  for (const entry of value.artifacts.restrictedUnblindingMap.entries) {
    cells.set(entry.outputFingerprint, Object.freeze({ outputFingerprint: entry.outputFingerprint, caseFingerprint: entry.caseFingerprint, configFingerprint: entry.configFingerprint, arm: entry.arm }));
  }
  assert(cells.size === FIXED_TRACE_HUMAN_PANEL_OUTPUTS, "unblinding map is not a complete 216-output cohort");
  return Object.freeze({ cohortFingerprint: value.artifacts.cohortFingerprint, sourceCells: Object.freeze([...cells.values()].sort((a, b) => a.outputFingerprint.localeCompare(b.outputFingerprint))), originalPrimaryResponseFingerprints: Object.freeze(value.primaryResponses.map((response) => response.responseFingerprint).sort()), promotable: false });
}
