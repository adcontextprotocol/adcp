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
import { createHash, verify as verifySignature } from "node:crypto";
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

/**
 * This registry is deliberately module-owned.  There is no evaluator public
 * key in this no-spend repository, so all evidence that purports to be real
 * custody fails closed until a separately reviewed deployment pins one here.
 * Artifact callers cannot replace this registry or supply a boolean verifier.
 */
const FIXED_TRACE_HUMAN_PANEL_TRUST_ROOTS = Object.freeze({
  "addie-human-panel-evaluator-v1": Object.freeze({
    publicKeyPem: null as string | null,
    status: "unprovisioned_no_real_evaluator_key_or_custody" as const,
  }),
});
type SignedArtifactKind = "diagnostic_manifest" | "schedule" | "nonce_consumption" | "rate_authorization" | "unblinding";

function verifyPinnedEvaluatorSignature(kind: SignedArtifactKind, trustRootId: unknown, fingerprint: unknown, signature: unknown): void {
  const rootId = text(trustRootId, "evaluator trust-root ID");
  const root = FIXED_TRACE_HUMAN_PANEL_TRUST_ROOTS[rootId as keyof typeof FIXED_TRACE_HUMAN_PANEL_TRUST_ROOTS];
  assert(root, "evaluator trust-root ID is not pinned by this module");
  assert(root.publicKeyPem, "real evaluator trust root is not provisioned in this no-spend repository");
  assert(isSha256(fingerprint), "signed evaluator artifact fingerprint is invalid");
  const encoded = text(signature, "evaluator signature");
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), "evaluator signature must be base64");
  assert(verifySignature(null, Buffer.from(canonicalJson({ domain: "addie-fixed-trace-human-panel-signature-v1", kind, trustRootId: rootId, fingerprint })), root.publicKeyPem, Buffer.from(encoded, "base64")), "pinned evaluator signature verification failed");
}

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
  restrictedUnblindingMap: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "mapFingerprint", "cohortFingerprint", "manifestFingerprint", "scheduleFingerprint", "trustRootId", "entries"]), access: "evaluator_custody_only_not_repository_private_storage" }),
  raterAssignment: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "assignmentFingerprint", "packetFingerprint", "raterPseudonym", "opaqueItemId", "role"]), role: "primary_per_blinded_item" }),
  rubricVersion: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "rubricFingerprint", "qualityValues", "safetyValues", "toolCorrectnessValues", "rules"]), endpoint: "two_blinded_human_primary_quality" }),
  independentRaterResponse: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "responseFingerprint", "responseId", "responseNonce", "opaqueItemId", "packetFingerprint", "assignmentFingerprint", "rubricFingerprint", "raterPseudonym", "outputCondition", "quality", "safety", "toolCorrectness", "evidence", "reason", "independenceAttestation"]), access: "one_rater_only" }),
  adjudicationPacket: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "packetFingerprint", "opaqueItemId", "adjudicationRequestFingerprint", "rubricFingerprint", "prompt", "candidateOutput", "scoringContext", "safetyApplicable", "toolCorrectnessApplicable", "outputCondition"]), forbidden: Object.freeze(["raterPseudonym", "quality", "safety", "toolCorrectness", "evidence", "reason", "provider", "model", "architecture", "cell", "config", "latency", "cost"]) }),
  adjudicationResponse: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "responseFingerprint", "responseId", "opaqueItemId", "adjudicationRequestFingerprint", "rubricFingerprint", "adjudicatorPseudonym", "quality", "safety", "toolCorrectness", "evidence", "reason", "independenceAttestation"]), source: "locked_disagreement_or_missingness_only" }),
  custodyReceipt: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "receiptFingerprint", "custodianPseudonym", "packFingerprint", "restrictedMapFingerprint", "signature", "externalRecordReference"]), warning: "shape_only_no_local_custody_claim" }),
  humanCostLedger: Object.freeze({ fields: Object.freeze(["schemaVersion", "contractFingerprint", "ledgerFingerprint", "ceilingCents", "events"]), eventChain: "signed_monotonic_reservation_then_assignment_then_reconciliation", ceilingCents: FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, payment: "not_implemented" }),
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
export interface FixedTraceOneUseNonceAuthority {
  /**
   * An evaluator-held durable capability.  Its output is not trusted merely
   * because this method returned: module-owned cryptographic verification of
   * the returned receipt is mandatory.
   */
  readonly consumeOnce: (binding: Readonly<{ nonceCommitment: Sha256; manifestFingerprint: Sha256; scheduleFingerprint: Sha256 }>) => FixedTraceNonceConsumptionReceipt;
}
export interface FixedTraceCustodiedDiagnosticManifest {
  readonly trustRootId: string;
  readonly designFingerprint: Sha256;
  readonly outputs: readonly FixedTraceDiagnosticOutput[];
  readonly forbiddenMarkers: readonly string[];
  readonly manifestFingerprint: Sha256;
  readonly signature: string;
}
export interface FixedTraceCommittedSchedule {
  readonly trustRootId: string;
  readonly manifestFingerprint: Sha256;
  readonly nonceCommitment: Sha256;
  readonly entries: readonly { readonly raterPseudonym: string; readonly opaqueItemId: string; readonly outputFingerprint: Sha256; readonly position: number }[];
  readonly scheduleFingerprint: Sha256;
  readonly signature: string;
}
export interface FixedTraceNonceConsumptionReceipt {
  readonly trustRootId: string;
  readonly nonceCommitment: Sha256;
  readonly manifestFingerprint: Sha256;
  readonly scheduleFingerprint: Sha256;
  readonly consumptionId: string;
  readonly nonceConsumptionFingerprint: Sha256;
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
  readonly manifestFingerprint: Sha256;
  readonly scheduleFingerprint: Sha256;
  readonly trustRootId: string;
  /** Restricted only: this is the sole arm identity needed after scoring closes. */
  readonly entries: readonly { readonly opaqueItemId: string; readonly outputFingerprint: Sha256; readonly caseFingerprint: Sha256; readonly configFingerprint: Sha256; readonly arm: ArchitectureArm }[];
}
export interface FixedTraceRaterAssignment {
  readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION;
  readonly contractFingerprint: Sha256;
  readonly assignmentFingerprint: Sha256;
  readonly packetFingerprint: Sha256;
  readonly raterPseudonym: string;
  readonly opaqueItemId: string;
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
function expectedCaseSpecs(): readonly (readonly [string, string])[] {
  const specs = FIXED_TRACE_EXPERIMENTAL_DESIGN.hybridArchitectureDiagnostic.caseSpecs;
  return Object.freeze([
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
  const seenOutputs = new Set<string>(); const caseIdentities = new Map<number, Readonly<{ identity: string; caseFingerprint: string }>>();
  const specs = expectedCaseSpecs();
  const armCounts = new Map<ArchitectureArm, number>(FIXED_TRACE_HUMAN_PANEL_ARMS.map((arm) => [arm, 0]));
  snapshot.forEach((value, index) => {
    const item = outputBody(value as FixedTraceDiagnosticOutput);
    const expectedCase = Math.floor(index / 9) + 1;
    const expectedArm = FIXED_TRACE_HUMAN_PANEL_ARMS[Math.floor((index % 9) / 3)]!;
    const expectedRepetition = (index % 3) + 1;
    assert(item.caseOrdinal === expectedCase && item.arm === expectedArm && item.repetition === expectedRepetition, "cohort has altered canonical case/arm/repetition order");
    assert(!seenOutputs.has(item.outputFingerprint as string), "cohort has duplicate output fingerprint");
    seenOutputs.add(item.outputFingerprint as string);
    const expectedIdentity = specs[expectedCase - 1]!;
    assert(item.caseSpecId === expectedIdentity[0] && item.stratum === expectedIdentity[1], "cohort case specification/stratum is swapped from the predeclared ordinal");
    const identity = canonicalJson({ caseOrdinal: item.caseOrdinal, caseSpecId: item.caseSpecId, stratum: item.stratum, caseFingerprint: item.caseFingerprint });
    const knownCase = caseIdentities.get(item.caseOrdinal as number);
    assert(!knownCase || knownCase.identity === identity, "immutable case ordinal/specification/stratum/fingerprint changes within a case");
    caseIdentities.set(item.caseOrdinal as number, Object.freeze({ identity, caseFingerprint: item.caseFingerprint as string }));
    assert(item.outputFingerprint === sha256(outputFingerprintBody(item)), "output fingerprint is not derived from immutable payload and provenance");
    armCounts.set(item.arm as ArchitectureArm, armCounts.get(item.arm as ArchitectureArm)! + 1);
  });
  assert(caseIdentities.size === FIXED_TRACE_HUMAN_PANEL_CASES && new Set([...caseIdentities.values()].map((identity) => identity.caseFingerprint)).size === FIXED_TRACE_HUMAN_PANEL_CASES, "cohort must contain 24 unique immutable case fingerprints");
  for (const arm of FIXED_TRACE_HUMAN_PANEL_ARMS) assert(armCounts.get(arm) === 72, `cohort is not balanced for ${arm}`);
  return sha256(snapshot);
}

function packetBody(packet: Omit<FixedTraceBlindedScoringPacket, "packetFingerprint">): Record<string, unknown> { return packet; }
function makeAssignment(packet: FixedTraceBlindedScoringPacket, opaqueItemId: string): FixedTraceRaterAssignment {
  const body = { schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("raterAssignment"), packetFingerprint: packet.packetFingerprint, raterPseudonym: packet.raterPseudonym, opaqueItemId, role: "primary" as const };
  return Object.freeze({ ...body, assignmentFingerprint: sha256(body) });
}
function privateItemId(nonce: string, rater: string, outputFingerprint: string): string {
  return `hp_${sha256({ domain: "addie-fixed-trace-human-panel-private-item-v1", nonce, rater, outputFingerprint }).slice(0, 24)}`;
}
export interface FixedTraceHumanPanelBuildInput {
  /** 256-bit secret whose externally committed digest is consumed once. */
  readonly evaluatorControlledNonce: string;
  readonly custodiedDiagnosticManifest: FixedTraceCustodiedDiagnosticManifest;
  readonly committedSchedule: FixedTraceCommittedSchedule;
  /** A real evaluator-held, durable nonce service; a boolean callback is not accepted. */
  readonly nonceAuthority: FixedTraceOneUseNonceAuthority;
  readonly rubric?: FixedTraceHumanPanelRubric;
}
function nonceCommitment(nonce: string): Sha256 { return sha256({ domain: "addie-fixed-trace-human-panel-nonce-v1", nonce }); }
function verifyManifest(input: FixedTraceCustodiedDiagnosticManifest): readonly FixedTraceDiagnosticOutput[] {
  const manifest = record(snapshotFixedTraceJson(input, "custodied diagnostic manifest"), "custodied diagnostic manifest");
  exactKeys(manifest, ["trustRootId", "designFingerprint", "outputs", "forbiddenMarkers", "manifestFingerprint", "signature"], "custodied diagnostic manifest");
  assert(manifest.designFingerprint === fixedTraceExperimentalDesignFingerprint(), "custodied manifest design fingerprint mismatch");
  const { manifestFingerprint, signature, ...body } = manifest; assert(isSha256(manifestFingerprint) && manifestFingerprint === sha256(body), "custodied manifest fingerprint mismatch");
  verifyPinnedEvaluatorSignature("diagnostic_manifest", manifest.trustRootId, manifestFingerprint, signature);
  assert(Array.isArray(manifest.forbiddenMarkers), "custodied manifest markers are invalid"); assert(Array.isArray(manifest.outputs), "custodied manifest outputs are invalid");
  for (const output of manifest.outputs) assertRaterSafePayload(record(record(output, "custodied output").raterPayload, "custodied rater payload"), manifest.forbiddenMarkers as string[]);
  validateFixedTraceHumanPanelCohort(manifest.outputs as FixedTraceDiagnosticOutput[]);
  return manifest.outputs as FixedTraceDiagnosticOutput[];
}
function verifySchedule(input: FixedTraceCommittedSchedule, manifest: FixedTraceCustodiedDiagnosticManifest, outputs: readonly FixedTraceDiagnosticOutput[], nonce?: string): FixedTraceCommittedSchedule {
  const schedule = record(snapshotFixedTraceJson(input, "committed schedule"), "committed schedule"); exactKeys(schedule, ["trustRootId", "manifestFingerprint", "nonceCommitment", "entries", "scheduleFingerprint", "signature"], "committed schedule");
  assert(schedule.trustRootId === manifest.trustRootId && schedule.manifestFingerprint === manifest.manifestFingerprint, "schedule is not bound to the signed manifest/trust root");
  if (nonce !== undefined) assert(schedule.nonceCommitment === nonceCommitment(nonce), "schedule is not bound to the cryptographic nonce commitment");
  const { scheduleFingerprint, signature, ...body } = schedule; assert(isSha256(scheduleFingerprint) && scheduleFingerprint === sha256(body), "committed schedule fingerprint mismatch"); verifyPinnedEvaluatorSignature("schedule", schedule.trustRootId, scheduleFingerprint, signature);
  assert(Array.isArray(schedule.entries) && schedule.entries.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "committed schedule must have exactly 432 entries");
  const ids = new Set<string>(); const byRater = new Map<string, Set<string>>(); const positionsByRater = new Map<string, Set<number>>(); const outputIds = new Set(outputs.map((output) => output.outputFingerprint));
  for (const entry of schedule.entries) { const item = record(entry, "committed schedule entry"); exactKeys(item, ["raterPseudonym", "opaqueItemId", "outputFingerprint", "position"], "committed schedule entry"); const rater = text(item.raterPseudonym, "schedule rater"); const id = text(item.opaqueItemId, "schedule opaque ID"); assert(!ids.has(id), "committed schedule repeats an opaque ID"); ids.add(id); if (nonce !== undefined) assert(id === privateItemId(nonce, rater, text(item.outputFingerprint, "schedule output fingerprint")), "committed schedule opaque mapping is swapped or forged"); const position = integer(item.position, "schedule position"); assert(outputIds.has(item.outputFingerprint as string) && position >= 1 && position <= 216, "committed schedule binding is invalid"); const group = byRater.get(rater) ?? new Set<string>(); const positions = positionsByRater.get(rater) ?? new Set<number>(); assert(!group.has(item.outputFingerprint as string) && !positions.has(position), "committed schedule repeats an output or position for a rater"); group.add(item.outputFingerprint as string); positions.add(position); byRater.set(rater, group); positionsByRater.set(rater, positions); }
  assert(byRater.size === 2 && [...byRater.values()].every((items) => items.size === 216), "committed schedule must assign every output to the same two raters");
  return schedule as unknown as FixedTraceCommittedSchedule;
}
function verifyNonceConsumption(input: FixedTraceNonceConsumptionReceipt, schedule: FixedTraceCommittedSchedule): FixedTraceNonceConsumptionReceipt {
  const receipt = record(snapshotFixedTraceJson(input, "nonce consumption receipt"), "nonce consumption receipt");
  exactKeys(receipt, ["trustRootId", "nonceCommitment", "manifestFingerprint", "scheduleFingerprint", "consumptionId", "nonceConsumptionFingerprint", "signature"], "nonce consumption receipt");
  const { nonceConsumptionFingerprint, signature, ...body } = receipt;
  assert(isSha256(nonceConsumptionFingerprint) && nonceConsumptionFingerprint === sha256(body), "nonce consumption receipt fingerprint mismatch");
  assert(receipt.trustRootId === schedule.trustRootId && receipt.nonceCommitment === schedule.nonceCommitment && receipt.manifestFingerprint === schedule.manifestFingerprint && receipt.scheduleFingerprint === schedule.scheduleFingerprint, "nonce consumption receipt is not bound to the signed schedule");
  text(receipt.consumptionId, "durable nonce consumption ID"); verifyPinnedEvaluatorSignature("nonce_consumption", receipt.trustRootId, nonceConsumptionFingerprint, signature);
  return receipt as unknown as FixedTraceNonceConsumptionReceipt;
}
export interface FixedTraceHumanPanelArtifacts {
  /** Evaluator-only source evidence; never send this object to a rater. */
  readonly custodiedDiagnosticManifest: FixedTraceCustodiedDiagnosticManifest;
  readonly committedSchedule: FixedTraceCommittedSchedule;
  readonly nonceConsumptionReceipt: FixedTraceNonceConsumptionReceipt;
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
  const { evaluatorControlledNonce, custodiedDiagnosticManifest, committedSchedule, rubric: inputRubric, nonceAuthority } = input;
  const serializable = { evaluatorControlledNonce, custodiedDiagnosticManifest, committedSchedule, ...(inputRubric === undefined ? {} : { rubric: inputRubric }) };
  const snapshot = { ...(snapshotFixedTraceJson(serializable, "human-panel build input") as Omit<FixedTraceHumanPanelBuildInput, "nonceAuthority">), nonceAuthority } as FixedTraceHumanPanelBuildInput;
  const nonce = text(snapshot.evaluatorControlledNonce, "evaluator-controlled nonce");
  assert(/^[a-f0-9]{64}$/.test(nonce), "evaluator-controlled nonce must be a private 256-bit hexadecimal secret");
  const outputs = verifyManifest(snapshot.custodiedDiagnosticManifest); const schedule = verifySchedule(snapshot.committedSchedule, snapshot.custodiedDiagnosticManifest, outputs, nonce);
  assert(snapshot.nonceAuthority && typeof snapshot.nonceAuthority.consumeOnce === "function", "no evaluator-held durable nonce authority was supplied");
  const nonceConsumptionReceipt = verifyNonceConsumption(snapshot.nonceAuthority.consumeOnce({ nonceCommitment: schedule.nonceCommitment, manifestFingerprint: schedule.manifestFingerprint, scheduleFingerprint: schedule.scheduleFingerprint }), schedule);
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
  const mapBody = Object.freeze({ schemaVersion: FIXED_TRACE_HUMAN_PANEL_VERSION, contractFingerprint: contract("restrictedUnblindingMap"), cohortFingerprint, manifestFingerprint: snapshot.custodiedDiagnosticManifest.manifestFingerprint, scheduleFingerprint: schedule.scheduleFingerprint, trustRootId: schedule.trustRootId, entries: Object.freeze(entries) });
  const restrictedUnblindingMap = Object.freeze({ ...mapBody, mapFingerprint: sha256(mapBody) });
  validateFixedTraceRestrictedUnblindingMap(restrictedUnblindingMap, cohortFingerprint);
  return Object.freeze({ custodiedDiagnosticManifest: snapshot.custodiedDiagnosticManifest, committedSchedule: schedule, nonceConsumptionReceipt, raterPackets: Object.freeze(packets), raterAssignments: Object.freeze(packets.flatMap((packet) => packet.items.map((item) => makeAssignment(packet, item.opaqueItemId)))), restrictedUnblindingMap, cohortFingerprint, readiness: fixedTraceHumanPanelReadiness() });
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
    assert(entry.outputCondition === "complete" || entry.outputCondition === "missing", "packet output condition is invalid"); noTreatmentFields(entry, "blinded scoring packet"); assertRaterSafePayload(entry, []);
    assert(typeof entry.safetyApplicable === "boolean" && typeof entry.toolCorrectnessApplicable === "boolean", "packet applicability is invalid");
  }
}
export function validateFixedTraceRestrictedUnblindingMap(input: FixedTraceRestrictedUnblindingMap, cohortFingerprint: Sha256): void {
  const value = record(snapshotFixedTraceJson(input, "restricted unblinding map"), "restricted unblinding map");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "mapFingerprint", "cohortFingerprint", "manifestFingerprint", "scheduleFingerprint", "trustRootId", "entries"], "restricted unblinding map");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("restrictedUnblindingMap"), "restricted map schema is stale");
  const { mapFingerprint, ...body } = value; assert(isSha256(mapFingerprint) && mapFingerprint === sha256(body), "restricted map fingerprint mismatch");
  assert(value.cohortFingerprint === cohortFingerprint && isSha256(value.manifestFingerprint) && isSha256(value.scheduleFingerprint), "restricted map source fingerprint mismatch"); text(value.trustRootId, "restricted map trust-root ID"); assert(Array.isArray(value.entries) && value.entries.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "restricted map must contain 432 rater-private entries");
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
  text(value.opaqueItemId, "adjudication opaque item ID"); assert(isSha256(value.adjudicationRequestFingerprint) && value.rubricFingerprint === FIXED_TRACE_HUMAN_PANEL_RUBRIC.rubricFingerprint, "adjudication packet binding mismatch"); text(value.prompt, "adjudication prompt"); text(value.scoringContext, "adjudication scoring context"); assert(value.candidateOutput === null || typeof value.candidateOutput === "string", "adjudication candidate output is invalid"); assert(value.outputCondition === "complete" || value.outputCondition === "missing", "adjudication output condition is invalid"); assert(typeof value.safetyApplicable === "boolean" && typeof value.toolCorrectnessApplicable === "boolean", "adjudication applicability is invalid"); noTreatmentFields(value, "adjudication packet"); assertRaterSafePayload(value, []);
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
  text(value.responseId, "response ID"); text(value.responseNonce, "response nonce"); assert(value.packetFingerprint === packet.packetFingerprint && value.assignmentFingerprint === assignment.assignmentFingerprint && value.opaqueItemId === assignment.opaqueItemId && value.rubricFingerprint === packet.rubricFingerprint && value.raterPseudonym === assignment.raterPseudonym && assignment.packetFingerprint === packet.packetFingerprint, "primary response binding mismatch");
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
  assert(packet.safetyApplicable ? value.safety !== "not_applicable" : value.safety === "not_applicable", "adjudication safety applicability must match the predeclared case");
  assert(packet.toolCorrectnessApplicable ? value.toolCorrectness !== "not_applicable" : value.toolCorrectness === "not_applicable", "adjudication tool correctness applicability must match the predeclared case");
  assert(value.quality !== "pass" || packet.safetyApplicable || packet.toolCorrectnessApplicable, "adjudication cannot pass when both decision dimensions are not applicable");
}

interface PrimaryCoverage { readonly byOutput: Map<string, [FixedTraceIndependentRaterResponse | null, FixedTraceIndependentRaterResponse | null]>; readonly opaqueByOutput: Map<string, string[]>; }
function validatePrimaryCoverage(responses: readonly FixedTraceIndependentRaterResponse[], packets: readonly FixedTraceBlindedScoringPacket[], assignments: readonly FixedTraceRaterAssignment[], restrictedMap: FixedTraceRestrictedUnblindingMap, requireComplete: boolean): PrimaryCoverage {
  assert(packets.length === 2 && assignments.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "exactly two common primary packets and 432 item assignments are required");
  const raterIds = [...new Set(assignments.map((assignment) => assignment.raterPseudonym))]; assert(raterIds.length === 2, "primary rater identity reuse is forbidden");
  const map = new Map<string, [FixedTraceIndependentRaterResponse | null, FixedTraceIndependentRaterResponse | null]>(); const opaqueByOutput = new Map<string, string[]>();
  const sourceByOpaque = new Map<string, string>();
  for (const entry of restrictedMap.entries) {
    sourceByOpaque.set(entry.opaqueItemId, entry.outputFingerprint);
    if (!map.has(entry.outputFingerprint)) map.set(entry.outputFingerprint, [null, null]);
    opaqueByOutput.set(entry.outputFingerprint, [...(opaqueByOutput.get(entry.outputFingerprint) ?? []), entry.opaqueItemId]);
  }
  for (const packet of packets) validateFixedTraceBlindedScoringPacket(packet);
  const seenAssignments = new Set<string>();
  for (const assignment of assignments) {
    const packet = packets.find((candidate) => candidate.packetFingerprint === assignment.packetFingerprint);
    assert(packet, "assignment packet is not one of the two primary packets"); validateFixedTraceRaterAssignment(assignment, packet);
    assert(!seenAssignments.has(assignment.assignmentFingerprint), "duplicate item assignment fingerprint"); seenAssignments.add(assignment.assignmentFingerprint);
  }
  // The caller binds the rater-private IDs to source identities by a restricted map in the workflow validator.
  const seenResponseIds = new Set<string>(); const seenNonces = new Set<string>(); const seenRaterItems = new Set<string>();
  for (const response of responses) {
    const assignment = assignments.find((candidate) => candidate.assignmentFingerprint === response.assignmentFingerprint && candidate.raterPseudonym === response.raterPseudonym && candidate.opaqueItemId === response.opaqueItemId); assert(assignment, "response is not bound to an assigned blinded item");
    const packet = packets.find((candidate) => candidate.packetFingerprint === assignment.packetFingerprint)!;
    validateFixedTraceIndependentRaterResponse(response, assignment, packet);
    assert(!seenResponseIds.has(response.responseId) && !seenNonces.has(response.responseNonce), "duplicate or replayed primary rating"); seenResponseIds.add(response.responseId); seenNonces.add(response.responseNonce);
    const key = `${response.raterPseudonym}:${response.opaqueItemId}`; assert(!seenRaterItems.has(key), "duplicate rating for rater/item"); seenRaterItems.add(key);
    assert(sourceByOpaque.has(response.opaqueItemId), "response opaque item is absent from restricted unblinding map");
  }
  for (const response of responses) {
    const identity = sourceByOpaque.get(response.opaqueItemId)!;
    const pair = map.get(identity) ?? [null, null] as [FixedTraceIndependentRaterResponse | null, FixedTraceIndependentRaterResponse | null];
    pair[raterIds.indexOf(response.raterPseudonym)] = response;
    map.set(identity, pair);
  }
  if (requireComplete) assert(responses.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "all 432 primary ratings are required");
  return { byOutput: map, opaqueByOutput };
}

export interface FixedTraceCustodyReceipt { readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly receiptFingerprint: Sha256; readonly custodianPseudonym: string; readonly packFingerprint: Sha256; readonly restrictedMapFingerprint: Sha256; readonly signature: string; readonly externalRecordReference: string; }
export interface FixedTraceCalibrationReceipt { readonly calibrationFingerprint: Sha256; readonly panelFingerprint: Sha256; readonly externalRecordReference: string; readonly signature: string; }
export interface FixedTraceHumanCostReservation {
  readonly phase: "reservation";
  readonly trustRootId: string;
  readonly reservationId: string;
  /** Primary assignment fingerprint, or locked adjudication-request fingerprint. */
  readonly subjectFingerprint: Sha256;
  readonly authorizedRateCents: number;
  readonly committedCents: number;
  readonly eventIndex: number;
  readonly previousEventDigest: Sha256 | null;
  readonly timestamp: string;
  readonly eventFingerprint: Sha256;
  readonly signature: string;
}
/** Signed dispatch evidence. This is deliberately separate from the planned assignment artifact. */
export interface FixedTraceHumanCostAssignment {
  readonly phase: "assignment";
  readonly trustRootId: string;
  readonly reservationId: string;
  /** The primary assignment fingerprint or locked adjudication-request fingerprint. */
  readonly subjectFingerprint: Sha256;
  readonly eventIndex: number;
  readonly previousEventDigest: Sha256 | null;
  readonly timestamp: string;
  readonly eventFingerprint: Sha256;
  readonly signature: string;
}
export interface FixedTraceHumanCostReconciliation {
  readonly phase: "reconciliation";
  readonly trustRootId: string;
  readonly reservationId: string;
  readonly subjectFingerprint: Sha256;
  readonly completedResponseFingerprint: Sha256;
  readonly actualCents: number;
  readonly eventIndex: number;
  readonly previousEventDigest: Sha256 | null;
  readonly timestamp: string;
  readonly eventFingerprint: Sha256;
  readonly signature: string;
}
export type FixedTraceHumanCostEvent = FixedTraceHumanCostReservation | FixedTraceHumanCostAssignment | FixedTraceHumanCostReconciliation;
export interface FixedTraceHumanCostLedger { readonly schemaVersion: typeof FIXED_TRACE_HUMAN_PANEL_VERSION; readonly contractFingerprint: Sha256; readonly ledgerFingerprint: Sha256; readonly ceilingCents: typeof FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS; readonly events: readonly FixedTraceHumanCostEvent[]; }
export interface FixedTraceCostReconciliationExpectation { readonly subjectFingerprint: Sha256; readonly completedResponseFingerprint: Sha256; }
interface ValidatedCostChain { readonly reservations: Map<string, FixedTraceHumanCostReservation>; readonly assignments: Map<string, FixedTraceHumanCostAssignment>; readonly reconciliations: Map<string, FixedTraceHumanCostReconciliation>; readonly exposureCents: number; }
function costEventFingerprintBody(event: Record<string, unknown>): Record<string, unknown> { const { eventFingerprint: _fingerprint, signature: _signature, ...body } = event; return body; }
function costEventShape(event: unknown): Record<string, unknown> {
  const value = record(event, "human cost event");
  const common = ["phase", "trustRootId", "reservationId", "subjectFingerprint", "eventIndex", "previousEventDigest", "timestamp", "eventFingerprint", "signature"];
  if (value.phase === "reservation") exactKeys(value, [...common, "authorizedRateCents", "committedCents"], "human cost reservation");
  else if (value.phase === "assignment") exactKeys(value, common, "human cost assignment");
  else if (value.phase === "reconciliation") exactKeys(value, [...common, "completedResponseFingerprint", "actualCents"], "human cost reconciliation");
  else assert(false, "human cost event phase is invalid");
  text(value.trustRootId, "cost event trust-root ID"); text(value.reservationId, "cost reservation ID"); assert(isSha256(value.subjectFingerprint) && isSha256(value.eventFingerprint), "cost event fingerprint is invalid");
  assert(value.previousEventDigest === null || isSha256(value.previousEventDigest), "cost event previous digest is invalid"); integer(value.eventIndex, "cost event index");
  assert(typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)), "cost event timestamp is invalid"); text(value.signature, "cost event signature");
  if (value.phase === "reservation") { const rate = integer(value.authorizedRateCents, "authorized rate"); const commitment = integer(value.committedCents, "committed reservation"); assert(rate > 0 && commitment >= rate && commitment > 0, "reservation requires a positive authorized rate and committed cents"); }
  else if (value.phase === "reconciliation") { assert(isSha256(value.completedResponseFingerprint), "reconciliation completed response fingerprint is invalid"); integer(value.actualCents, "reconciled actual cents"); }
  assert(value.eventFingerprint === sha256(costEventFingerprintBody(value)), "cost event fingerprint mismatch"); return value;
}
export function validateFixedTraceHumanCostLedger(input: FixedTraceHumanCostLedger, expectedReconciliations?: readonly FixedTraceCostReconciliationExpectation[]): number {
  const value = record(snapshotFixedTraceJson(input, "human cost ledger"), "human cost ledger"); exactKeys(value, ["schemaVersion", "contractFingerprint", "ledgerFingerprint", "ceilingCents", "events"], "human cost ledger"); assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("humanCostLedger") && value.ceilingCents === FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, "cost ledger schema or ceiling is invalid"); const { ledgerFingerprint, ...body } = value; assert(isSha256(ledgerFingerprint) && ledgerFingerprint === sha256(body), "cost ledger fingerprint mismatch"); assert(Array.isArray(value.events), "cost ledger events are invalid");
  const reservations = new Map<string, FixedTraceHumanCostReservation>(); const assignments = new Map<string, FixedTraceHumanCostAssignment>(); const reconciliations = new Map<string, FixedTraceHumanCostReconciliation>(); const subjects = new Set<string>(); let previous: Sha256 | null = null; let previousTimestamp = -Infinity;
  for (const [offset, raw] of value.events.entries()) {
    const event = costEventShape(raw); assert(event.eventIndex === offset + 1 && event.previousEventDigest === previous, "cost event chain is reordered, forked, or has a gap"); const parsedTimestamp = Date.parse(text(event.timestamp, "cost event timestamp")); assert(parsedTimestamp > previousTimestamp, "cost event timestamps are not strictly monotonic"); previousTimestamp = parsedTimestamp; previous = event.eventFingerprint as Sha256;
    if (event.phase === "reservation") { assert(!reservations.has(event.reservationId as string) && !subjects.has(event.subjectFingerprint as string), "duplicate cost reservation subject or ID"); reservations.set(event.reservationId as string, event as unknown as FixedTraceHumanCostReservation); subjects.add(event.subjectFingerprint as string); }
    else if (event.phase === "assignment") { const reservation = reservations.get(event.reservationId as string); assert(reservation && reservation.subjectFingerprint === event.subjectFingerprint, "assignment precedes or is mismatched with its reservation"); assert(!assignments.has(event.reservationId as string), "duplicate cost assignment"); assignments.set(event.reservationId as string, event as unknown as FixedTraceHumanCostAssignment); }
    else { const assignment = assignments.get(event.reservationId as string); assert(assignment && assignment.subjectFingerprint === event.subjectFingerprint, "reconciliation precedes or is mismatched with its reservation/assignment"); assert(!reconciliations.has(event.reservationId as string), "duplicate cost reconciliation"); reconciliations.set(event.reservationId as string, event as unknown as FixedTraceHumanCostReconciliation); }
  }
  let exposure = 0;
  for (const reservation of reservations.values()) exposure += Math.max(reservation.committedCents, reconciliations.get(reservation.reservationId)?.actualCents ?? 0);
  if (expectedReconciliations !== undefined) {
    assert(expectedReconciliations.length === reservations.size && expectedReconciliations.length === assignments.size && expectedReconciliations.length === reconciliations.size, "cost chain has missing or unrelated reservation/assignment/reconciliation subjects");
    const expected = new Map(expectedReconciliations.map((entry) => [entry.subjectFingerprint, entry.completedResponseFingerprint]));
    assert(expected.size === expectedReconciliations.length, "cost chain has duplicate expected subjects");
    for (const reconciliation of reconciliations.values()) assert(expected.get(reconciliation.subjectFingerprint) === reconciliation.completedResponseFingerprint, "cost reconciliation completed response does not match its reserved subject");
  }
  assert(exposure <= FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, "human cost reservation/reconciliation exposure exceeds $650 ceiling");
  return exposure;
}
function validateSignedCostChain(input: FixedTraceHumanCostLedger, expectedReconciliations: readonly FixedTraceCostReconciliationExpectation[]): ValidatedCostChain {
  validateFixedTraceHumanCostLedger(input, expectedReconciliations);
  const reservations = new Map<string, FixedTraceHumanCostReservation>(); const assignments = new Map<string, FixedTraceHumanCostAssignment>(); const reconciliations = new Map<string, FixedTraceHumanCostReconciliation>();
  for (const event of input.events) { verifyPinnedEvaluatorSignature("rate_authorization", event.trustRootId, event.eventFingerprint, event.signature); if (event.phase === "reservation") reservations.set(event.reservationId, event); else if (event.phase === "assignment") assignments.set(event.reservationId, event); else reconciliations.set(event.reservationId, event); }
  return { reservations, assignments, reconciliations, exposureCents: validateFixedTraceHumanCostLedger(input, expectedReconciliations) };
}

function validateFixedTraceRaterAssignment(input: FixedTraceRaterAssignment, packet: FixedTraceBlindedScoringPacket): void {
  const value = record(snapshotFixedTraceJson(input, "rater assignment"), "rater assignment");
  exactKeys(value, ["schemaVersion", "contractFingerprint", "assignmentFingerprint", "packetFingerprint", "raterPseudonym", "opaqueItemId", "role"], "rater assignment");
  assert(value.schemaVersion === FIXED_TRACE_HUMAN_PANEL_VERSION && value.contractFingerprint === contract("raterAssignment"), "rater assignment schema is stale");
  const { assignmentFingerprint, ...body } = value;
  assert(isSha256(assignmentFingerprint) && assignmentFingerprint === sha256(body), "rater assignment fingerprint mismatch");
  assert(value.packetFingerprint === packet.packetFingerprint && value.raterPseudonym === packet.raterPseudonym && typeof value.opaqueItemId === "string" && packet.items.some((item) => item.opaqueItemId === value.opaqueItemId) && value.role === "primary", "rater assignment does not bind its own packet item only");
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
  const value = record(snapshotFixedTraceJson(artifacts, "human-panel artifacts"), "human-panel artifacts"); exactKeys(value, ["custodiedDiagnosticManifest", "committedSchedule", "nonceConsumptionReceipt", "raterPackets", "raterAssignments", "restrictedUnblindingMap", "cohortFingerprint", "readiness"], "human-panel artifacts");
  const manifest = value.custodiedDiagnosticManifest as FixedTraceCustodiedDiagnosticManifest;
  const outputs = verifyManifest(manifest);
  const schedule = verifySchedule(value.committedSchedule as FixedTraceCommittedSchedule, manifest, outputs);
  verifyNonceConsumption(value.nonceConsumptionReceipt as FixedTraceNonceConsumptionReceipt, schedule);
  assert(value.cohortFingerprint === validateFixedTraceHumanPanelCohort(outputs), "artifact cohort is not the signed manifest cohort");
  assert(Array.isArray(value.raterPackets) && Array.isArray(value.raterAssignments) && value.raterPackets.length === 2 && value.raterAssignments.length === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS, "artifacts require exactly two primary packets and 432 item assignments"); assert(isSha256(value.cohortFingerprint), "artifact cohort fingerprint is invalid");
  const packets = value.raterPackets as FixedTraceBlindedScoringPacket[]; const assignments = value.raterAssignments as FixedTraceRaterAssignment[];
  for (const packet of packets) validateFixedTraceBlindedScoringPacket(packet);
  for (const assignment of assignments) { const packet = packets.find((candidate) => candidate.packetFingerprint === assignment.packetFingerprint); assert(packet, "assignment is not bound to a primary packet"); validateFixedTraceRaterAssignment(assignment, packet); }
  const expectedAssignmentFingerprints = new Set(packets.flatMap((packet) => packet.items.map((item) => makeAssignment(packet, item.opaqueItemId).assignmentFingerprint)));
  const suppliedAssignmentFingerprints = new Set(assignments.map((assignment) => assignment.assignmentFingerprint));
  assert(expectedAssignmentFingerprints.size === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS && suppliedAssignmentFingerprints.size === expectedAssignmentFingerprints.size && [...expectedAssignmentFingerprints].every((fingerprint) => suppliedAssignmentFingerprints.has(fingerprint)), "item assignments must cover every blinded rater/item exactly once");
  assert(new Set(packets.map((packet) => packet.raterPseudonym)).size === 2, "primary rater identity reuse is forbidden");
  const map = value.restrictedUnblindingMap as FixedTraceRestrictedUnblindingMap; validateFixedTraceRestrictedUnblindingMap(map, value.cohortFingerprint as Sha256);
  assert(map.manifestFingerprint === manifest.manifestFingerprint && map.scheduleFingerprint === schedule.scheduleFingerprint && map.trustRootId === schedule.trustRootId, "restricted map is not bound to the signed manifest and schedule");
  const packetIds = new Set(packets.flatMap((packet) => packet.items.map((item) => item.opaqueItemId))); const mapIds = new Set(map.entries.map((entry) => entry.opaqueItemId));
  assert(packetIds.size === FIXED_TRACE_HUMAN_PANEL_PRIMARY_RATINGS && packetIds.size === mapIds.size && [...packetIds].every((id) => mapIds.has(id)), "restricted map must exactly bind both private packet populations");
  const mapCounts = new Map<string, number>(); for (const entry of map.entries) mapCounts.set(entry.outputFingerprint, (mapCounts.get(entry.outputFingerprint) ?? 0) + 1);
  assert(mapCounts.size === FIXED_TRACE_HUMAN_PANEL_OUTPUTS && [...mapCounts.values()].every((count) => count === 2), "every output must bind exactly two common rater-private IDs");
  const sourceByFingerprint = new Map(outputs.map((output) => [output.outputFingerprint, output]));
  const scheduleByOpaque = new Map(schedule.entries.map((entry) => [entry.opaqueItemId, entry]));
  for (const packet of packets) for (const item of packet.items) {
    const scheduled = scheduleByOpaque.get(item.opaqueItemId); assert(scheduled && scheduled.raterPseudonym === packet.raterPseudonym, "packet item is absent from the signed rater schedule");
    const source = sourceByFingerprint.get(scheduled.outputFingerprint); assert(source, "packet item is absent from the signed source manifest");
    assert(canonicalJson(item) === canonicalJson({ opaqueItemId: scheduled.opaqueItemId, prompt: source.raterPayload.prompt, candidateOutput: source.raterPayload.candidateOutput, scoringContext: source.raterPayload.scoringContext, safetyApplicable: source.raterPayload.safetyApplicable, toolCorrectnessApplicable: source.raterPayload.toolCorrectnessApplicable, outputCondition: source.raterPayload.candidateOutput === null ? "missing" : "complete" }), "packet item differs from the signed rater-safe manifest payload");
  }
  for (const entry of map.entries) {
    const scheduled = scheduleByOpaque.get(entry.opaqueItemId); const source = scheduled && sourceByFingerprint.get(scheduled.outputFingerprint);
    assert(source && entry.outputFingerprint === source.outputFingerprint && entry.caseFingerprint === source.caseFingerprint && entry.configFingerprint === source.configFingerprint && entry.arm === source.arm, "restricted map entry differs from the signed manifest/schedule");
  }
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
  const responseIds = new Set<string>(); const primaryRaters = [...new Set(assignments.map((assignment) => assignment.raterPseudonym))];
  for (let index = 0; index < requests.length; index += 1) { const response = (value.adjudicationResponses as FixedTraceAdjudicationResponse[])[index]!; validateFixedTraceAdjudicationResponse(response, requests[index]!, createFixedTraceAdjudicationPacket(requests[index]!, packets), primaryRaters); assert(!responseIds.has(response.responseId), "duplicate adjudication response"); responseIds.add(response.responseId); }
  const primaryByAssignment = new Map((value.primaryResponses as FixedTraceIndependentRaterResponse[]).map((response) => [response.assignmentFingerprint, response]));
  const adjudicationByRequest = new Map(requests.map((request, index) => [request.adjudicationRequestFingerprint, (value.adjudicationResponses as FixedTraceAdjudicationResponse[])[index]! ]));
  const expectedSubjects = new Set<string>([...assignments.map((assignment) => assignment.assignmentFingerprint), ...requests.map((request) => request.adjudicationRequestFingerprint)]);
  const expectedReconciliations = [...primaryByAssignment.entries(), ...adjudicationByRequest.entries()].map(([subjectFingerprint, response]) => ({ subjectFingerprint, completedResponseFingerprint: response.responseFingerprint }));
  const chain = validateSignedCostChain(value.humanCostLedger as FixedTraceHumanCostLedger, expectedReconciliations);
  const reservationBySubject = new Map([...chain.reservations.values()].map((reservation) => [reservation.subjectFingerprint, reservation]));
  assert(chain.reservations.size === expectedSubjects.size && reservationBySubject.size === expectedSubjects.size && [...expectedSubjects].every((subject) => reservationBySubject.has(subject)), "human cost chain must reserve exactly once for every assignment/adjudication request before response");
  assert(chain.assignments.size === expectedSubjects.size, "human cost chain must dispatch exactly once after reservation for every assignment/adjudication subject");
  assert(chain.reconciliations.size === expectedSubjects.size, "human cost chain must reconcile exactly once for every assignment/adjudication subject");
  for (const [subject, reservation] of reservationBySubject) {
    const assignment = chain.assignments.get(reservation.reservationId); assert(assignment && assignment.subjectFingerprint === subject, "cost assignment does not follow its exact reservation subject");
    const reconciliation = chain.reconciliations.get(reservation.reservationId); assert(reconciliation && reconciliation.subjectFingerprint === subject, "cost reconciliation does not close its exact reservation subject");
    const primary = primaryByAssignment.get(subject); const adjudication = adjudicationByRequest.get(subject);
    assert((primary || adjudication) && reconciliation.completedResponseFingerprint === (primary?.responseFingerprint ?? adjudication?.responseFingerprint), "cost reconciliation response does not match its reserved assignment/adjudication subject");
  }
  const cost = chain.exposureCents;
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
export function unblindFixedTraceHumanPanelAfterLockedWorkflow(input: FixedTraceHumanPanelWorkflowInput, signature: string): FixedTraceClosedDiagnosticUnblinding {
  validateFixedTraceHumanPanelWorkflow(input);
  const value = snapshotFixedTraceJson(input, "human-panel closed workflow") as FixedTraceHumanPanelWorkflowInput;
  const unblindingFingerprint = sha256({ domain: "addie-fixed-trace-human-panel-unblinding-v1", cohortFingerprint: value.artifacts.cohortFingerprint, restrictedMapFingerprint: value.artifacts.restrictedUnblindingMap.mapFingerprint, primaryResponseFingerprints: value.primaryResponses.map((response) => response.responseFingerprint).sort() });
  verifyPinnedEvaluatorSignature("unblinding", value.artifacts.custodiedDiagnosticManifest.trustRootId, unblindingFingerprint, signature);
  const cells = new Map<string, FixedTraceClosedDiagnosticUnblinding["sourceCells"][number]>();
  for (const entry of value.artifacts.restrictedUnblindingMap.entries) {
    cells.set(entry.outputFingerprint, Object.freeze({ outputFingerprint: entry.outputFingerprint, caseFingerprint: entry.caseFingerprint, configFingerprint: entry.configFingerprint, arm: entry.arm }));
  }
  assert(cells.size === FIXED_TRACE_HUMAN_PANEL_OUTPUTS, "unblinding map is not a complete 216-output cohort");
  return Object.freeze({ cohortFingerprint: value.artifacts.cohortFingerprint, sourceCells: Object.freeze([...cells.values()].sort((a, b) => a.outputFingerprint.localeCompare(b.outputFingerprint))), originalPrimaryResponseFingerprints: Object.freeze(value.primaryResponses.map((response) => response.responseFingerprint).sort()), promotable: false });
}
