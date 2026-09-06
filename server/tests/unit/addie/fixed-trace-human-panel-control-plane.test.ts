import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS,
  FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS,
  FIXED_TRACE_HUMAN_PANEL_RUBRIC,
  buildFixedTraceHumanPanelArtifacts,
  fixedTraceHumanPanelReadiness,
  validateFixedTraceAdjudicationResponse,
  validateFixedTraceBlindedScoringPacket,
  validateFixedTraceHumanCostLedger,
  validateFixedTraceHumanPanelArtifacts,
  validateFixedTraceHumanPanelCohort,
  validateFixedTraceHumanPanelRubric,
  validateFixedTraceIndependentRaterResponse,
  validateFixedTraceRestrictedUnblindingMap,
  type FixedTraceDiagnosticOutput,
} from "../../../src/addie/eval/fixed-trace-human-panel-control-plane.js";
import { fixedTraceExperimentalDesignFingerprint } from "../../../src/addie/eval/fixed-trace-experimental-design.js";

function canonical(value: unknown): string {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function hash(number: number): string { return number.toString(16).padStart(64, "0"); }
const specs = ["arch-l01-dm-ignore", "arch-l02-private-react", "arch-l03-private-thanks", "arch-l04-dm-done", "arch-l05-dm-sounds-good", "arch-l06-dm-will-do", "arch-l07-private-hello", "arch-l08-dm-thank-you", "arch-n01-thread-ignore", "arch-n02-public-react", "arch-n03-unknown-privacy", "arch-n04-mutating-suffix", "arch-n05-admin-sounds-good", "arch-n06-thread-will-do", "arch-n07-control-delimiter", "arch-n08-negated-thanks", "knowledge-task-model", "dev-auth-no-disclosure", "billing-invoice-confirmed", "admin-member-records-without-slack", "dev-tool-error-retry", "dev-date-relative", "arch-r02-public-channel-injection", "arch-r08-long-truncation"];
function outputs(): FixedTraceDiagnosticOutput[] {
  const arms = ["direct_generation", "two_stage_llm_router", "deterministic_policy_llm_fallback_hybrid"] as const;
  return Array.from({ length: 24 }, (_, caseIndex) => arms.flatMap((arm, armIndex) => Array.from({ length: 3 }, (_, repetitionIndex) => {
    const body = { caseOrdinal: caseIndex + 1, caseSpecId: specs[caseIndex]!, stratum: caseIndex < 8 ? "local_terminal_eligible" as const : caseIndex < 16 ? "matched_hybrid_fallback_near_miss" as const : "routed_tool_or_safety" as const, caseFingerprint: hash(caseIndex + 1), configFingerprint: hash(100 + armIndex), arm, repetition: repetitionIndex + 1, raterPayload: { prompt: `Prompt ${caseIndex}`, candidateOutput: `Candidate ${caseIndex}-${armIndex}-${repetitionIndex}`, scoringContext: "Score supplied task facts.", safetyApplicable: true, toolCorrectnessApplicable: true } };
    return { ...body, outputFingerprint: digest({ domain: "addie-fixed-trace-human-panel-output-v2", ...body }) };
  }))).flat();
}
function packet(raterPseudonym = "rater-alpha") {
  const items = Array.from({ length: 216 }, (_, index) => ({ opaqueItemId: `${raterPseudonym}-${index}`, prompt: `Prompt ${index}`, candidateOutput: `Candidate ${index}`, scoringContext: "Score supplied task facts.", safetyApplicable: true, toolCorrectnessApplicable: true, outputCondition: "complete" as const }));
  const body = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.blindedScoringPacket, raterPseudonym, rubricFingerprint: FIXED_TRACE_HUMAN_PANEL_RUBRIC.rubricFingerprint, items };
  return { ...body, packetFingerprint: digest(body) };
}
function assignment(value: ReturnType<typeof packet>) {
  const body = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.raterAssignment, packetFingerprint: value.packetFingerprint, raterPseudonym: value.raterPseudonym, role: "primary" as const };
  return { ...body, assignmentFingerprint: digest(body) };
}
function signedLookingInput(items = outputs()) {
  const manifestBody = { trustRootId: "addie-human-panel-evaluator-v1", designFingerprint: fixedTraceExperimentalDesignFingerprint(), outputs: items, forbiddenMarkers: ["case-secret-marker"] };
  const manifest = { ...manifestBody, manifestFingerprint: digest(manifestBody), signature: "YW55dGhpbmc=" };
  const nonce = "a".repeat(64); const scheduleBody = { trustRootId: manifest.trustRootId, manifestFingerprint: manifest.manifestFingerprint, nonceCommitment: digest({ domain: "addie-fixed-trace-human-panel-nonce-v1", nonce }), entries: ["rater-alpha", "rater-beta"].flatMap((rater) => items.map((output, index) => ({ raterPseudonym: rater, opaqueItemId: `hp_${digest({ domain: "addie-fixed-trace-human-panel-private-item-v1", nonce, rater, outputFingerprint: output.outputFingerprint }).slice(0, 24)}`, outputFingerprint: output.outputFingerprint, position: index + 1 }))) };
  const committedSchedule = { ...scheduleBody, scheduleFingerprint: digest(scheduleBody), signature: "YW55dGhpbmc=" };
  return { evaluatorControlledNonce: nonce, custodiedDiagnosticManifest: manifest, committedSchedule, nonceAuthority: { consumeOnce: () => ({ trustRootId: manifest.trustRootId, nonceCommitment: scheduleBody.nonceCommitment, manifestFingerprint: manifest.manifestFingerprint, scheduleFingerprint: committedSchedule.scheduleFingerprint, consumptionId: "forged", nonceConsumptionFingerprint: hash(900), signature: "YW55dGhpbmc=" }) } };
}

describe("fixed-trace human-primary control plane", () => {
  it("rejects permissive verifier and nonce callbacks because the module-owned trust root is unprovisioned", () => expect(() => buildFixedTraceHumanPanelArtifacts(signedLookingInput())).toThrow(/trust root is not provisioned/));
  it("requires 24 unique immutable ordinal/specification/stratum/fingerprint tuples", () => {
    expect(validateFixedTraceHumanPanelCohort(outputs())).toMatch(/^[a-f0-9]{64}$/);
    const swapped = outputs(); [swapped[0]!.caseSpecId, swapped[9]!.caseSpecId] = [swapped[9]!.caseSpecId, swapped[0]!.caseSpecId]; expect(() => validateFixedTraceHumanPanelCohort(swapped)).toThrow(/swapped/);
    const duplicated = outputs(); duplicated[9]!.caseFingerprint = duplicated[0]!.caseFingerprint; expect(() => validateFixedTraceHumanPanelCohort(duplicated)).toThrow(/immutable|fingerprint/);
  });
  it("derives every output fingerprint from immutable payload and provenance", () => { const altered = outputs(); altered[0]!.raterPayload.candidateOutput = "altered after provenance commit"; expect(() => validateFixedTraceHumanPanelCohort(altered)).toThrow(/not derived/); });
  it("rejects treatment and cross-rater leakage even when packet hashes are recomputed", () => {
    const leaked = packet() as any; leaked.items[0].candidateOutput = "provider model architecture latency cost"; const { packetFingerprint: _ignored, ...body } = leaked; leaked.packetFingerprint = digest(body); expect(() => validateFixedTraceBlindedScoringPacket(leaked)).toThrow(/treatment-bearing/);
    const colluding = packet() as any; colluding.items[0].otherRaterScore = "pass"; const { packetFingerprint: _alsoIgnored, ...colludingBody } = colluding; colluding.packetFingerprint = digest(colludingBody); expect(() => validateFixedTraceBlindedScoringPacket(colluding)).toThrow(/invalid field set|leaks restricted/);
  });
  it("rejects stale rubric fingerprints and never changes local readiness", () => { const stale = structuredClone(FIXED_TRACE_HUMAN_PANEL_RUBRIC) as any; stale.rules.evidence = "forged"; expect(() => validateFixedTraceHumanPanelRubric(stale)).toThrow(/fingerprint|locked/); expect(fixedTraceHumanPanelReadiness()).toMatchObject({ humanPanelReadiness: "not_admitted_pending_real_human_panel_and_custody", promotable: false }); });
  it("rejects recomputed restricted-map self-hashes without a pinned source signature", () => { const value = signedLookingInput(); const forged = { custodiedDiagnosticManifest: value.custodiedDiagnosticManifest, committedSchedule: value.committedSchedule, nonceConsumptionReceipt: value.nonceAuthority.consumeOnce({} as any), raterPackets: [], raterAssignments: [], restrictedUnblindingMap: {}, cohortFingerprint: hash(1), readiness: fixedTraceHumanPanelReadiness() }; expect(() => validateFixedTraceHumanPanelArtifacts(forged as any)).toThrow(/trust root is not provisioned/); });
  it("rejects missing output passes and malformed independent ratings", () => { const value = packet(); const assigned = assignment(value); const body = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.independentRaterResponse, responseId: "response", responseNonce: "replayed", opaqueItemId: value.items[0]!.opaqueItemId, packetFingerprint: value.packetFingerprint, assignmentFingerprint: assigned.assignmentFingerprint, rubricFingerprint: value.rubricFingerprint, raterPseudonym: value.raterPseudonym, outputCondition: "missing" as const, quality: "pass" as const, safety: "safe" as const, toolCorrectness: "correct" as const, evidence: ["evidence"], reason: "reason", independenceAttestation: "no_other_rater_score_or_identity_seen" as const }; expect(() => validateFixedTraceIndependentRaterResponse({ ...body, responseFingerprint: digest(body) } as any, assigned, value)).toThrow(/never passed/); });
  it("applies predeclared applicability to adjudication too", () => { const source = packet().items[0]!; const request = { opaqueItemId: source.opaqueItemId, rubricFingerprint: FIXED_TRACE_HUMAN_PANEL_RUBRIC.rubricFingerprint, reason: "quality_disagreement" as const, adjudicationRequestFingerprint: hash(2) }; const adjBody = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.adjudicationPacket, opaqueItemId: "adj-opaque", adjudicationRequestFingerprint: request.adjudicationRequestFingerprint, rubricFingerprint: request.rubricFingerprint, prompt: source.prompt, candidateOutput: source.candidateOutput, scoringContext: source.scoringContext, safetyApplicable: false, toolCorrectnessApplicable: false, outputCondition: "complete" as const }; const adjPacket = { ...adjBody, packetFingerprint: digest(adjBody) }; const responseBody = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.adjudicationResponse, responseId: "adj-response", opaqueItemId: adjPacket.opaqueItemId, adjudicationRequestFingerprint: request.adjudicationRequestFingerprint, rubricFingerprint: request.rubricFingerprint, adjudicatorPseudonym: "adj", quality: "pass" as const, safety: "safe" as const, toolCorrectness: "correct" as const, evidence: ["evidence"], reason: "reason", independenceAttestation: "no_primary_rater_identity_or_score_seen" as const }; expect(() => validateFixedTraceAdjudicationResponse({ ...responseBody, responseFingerprint: digest(responseBody) } as any, request, adjPacket, ["rater-alpha", "rater-beta"])).toThrow(/applicability|both decision/); });
  it("requires one committed reservation per unique subject and caps cost", () => { const entry = { entryId: "entry", kind: "primary" as const, assignmentFingerprint: hash(1), responseFingerprint: hash(2), adjudicationResponseFingerprint: null, rateAuthorizationFingerprint: hash(3), quotedCents: 1, committedCents: 1, actualCents: null }; const ledger = (entries: unknown[]) => { const body = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.humanCostLedger, ceilingCents: FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, entries }; return { ...body, ledgerFingerprint: digest(body) }; }; expect(() => validateFixedTraceHumanCostLedger(ledger([{ ...entry, committedCents: null }]) as any)).toThrow(/committed reservation/); expect(() => validateFixedTraceHumanCostLedger(ledger([entry, { ...entry, entryId: "other" }]) as any)).toThrow(/duplicate response/); expect(() => validateFixedTraceHumanCostLedger(ledger([{ ...entry, committedCents: 65_001, quotedCents: 65_001 }]) as any)).toThrow(/exceeds \$650/); });
  it("has no real custody escape hatch, network call, payment path, or promotable result", () => { expect(() => validateFixedTraceRestrictedUnblindingMap({} as any, hash(1))).toThrow(); expect(() => validateFixedTraceHumanPanelArtifacts({} as any)).toThrow(); });
});
