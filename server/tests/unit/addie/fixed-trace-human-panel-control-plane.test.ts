import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS,
  FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS,
  FIXED_TRACE_HUMAN_PANEL_OUTPUTS,
  FIXED_TRACE_HUMAN_PANEL_RUBRIC,
  buildFixedTraceHumanPanelArtifacts,
  createFixedTraceAdjudicationRequests,
  fixedTraceHumanPanelReadiness,
  reserveFixedTraceHumanCost,
  unblindFixedTraceHumanPanelAfterLockedWorkflow,
  validateFixedTraceBlindedScoringPacket,
  validateFixedTraceHumanCostLedger,
  validateFixedTraceHumanPanelArtifacts,
  validateFixedTraceHumanPanelRubric,
  validateFixedTraceHumanPanelWorkflow,
  validateFixedTraceIndependentRaterResponse,
  validateFixedTraceRestrictedUnblindingMap,
  type FixedTraceDiagnosticOutput,
  type FixedTraceHumanCostLedger,
  type FixedTraceIndependentRaterResponse,
} from "../../../src/addie/eval/fixed-trace-human-panel-control-plane.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function hash(number: number): string { return number.toString(16).padStart(64, "0"); }
function outputs(): FixedTraceDiagnosticOutput[] {
  const arms = ["direct_generation", "two_stage_llm_router", "deterministic_policy_llm_fallback_hybrid"] as const;
  return Array.from({ length: 24 }, (_, caseIndex) => arms.flatMap((arm, armIndex) => Array.from({ length: 3 }, (_, repetitionIndex) => {
    const identity = caseIndex * 9 + armIndex * 3 + repetitionIndex + 1;
    return {
      caseOrdinal: caseIndex + 1, caseFingerprint: hash(caseIndex + 10_000), outputFingerprint: hash(identity), configFingerprint: hash(armIndex + 20_000), arm, repetition: repetitionIndex + 1,
      raterPayload: { prompt: `Prompt ${caseIndex + 1}`, candidateOutput: `Candidate ${identity}`, scoringContext: "Score the candidate against the supplied task facts." },
    };
  }))).flat();
}
function bundle() {
  return buildFixedTraceHumanPanelArtifacts({ evaluatorControlledNonce: "test-only-evaluator-nonce-0001", primaryRaterPseudonyms: ["rater-alpha", "rater-beta"], outputs: outputs() });
}
function response(bundleValue: ReturnType<typeof bundle>, raterIndex: number, itemIndex: number, overrides: Partial<FixedTraceIndependentRaterResponse> = {}): FixedTraceIndependentRaterResponse {
  const packet = bundleValue.raterPackets[raterIndex]!; const assignment = bundleValue.raterAssignments[raterIndex]!; const item = packet.items[itemIndex]!;
  const body = {
    schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const,
    contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.independentRaterResponse,
    responseId: `response-${raterIndex}-${itemIndex}`, responseNonce: `nonce-${raterIndex}-${itemIndex}`,
    opaqueItemId: item.opaqueItemId, packetFingerprint: packet.packetFingerprint, assignmentFingerprint: assignment.assignmentFingerprint, rubricFingerprint: packet.rubricFingerprint, raterPseudonym: packet.raterPseudonym,
    outputCondition: "complete" as const, quality: "pass" as const, safety: "safe" as const, toolCorrectness: "correct" as const, evidence: ["Candidate satisfies the stated task facts."], reason: "All required behavior is present.", independenceAttestation: "no_other_rater_score_or_identity_seen" as const,
    ...overrides,
  };
  const { responseFingerprint: _unused, ...withoutFingerprint } = body as typeof body & { responseFingerprint?: string };
  return { ...body, responseFingerprint: digest(withoutFingerprint) } as FixedTraceIndependentRaterResponse;
}
function allResponses(bundleValue: ReturnType<typeof bundle>): FixedTraceIndependentRaterResponse[] {
  return [0, 1].flatMap((raterIndex) => Array.from({ length: FIXED_TRACE_HUMAN_PANEL_OUTPUTS }, (_, itemIndex) => response(bundleValue, raterIndex, itemIndex)));
}
function ledger(entries: FixedTraceHumanCostLedger["entries"]): FixedTraceHumanCostLedger {
  const body = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.humanCostLedger, ceilingCents: FIXED_TRACE_HUMAN_PANEL_CEILING_CENTS, entries };
  return { ...body, ledgerFingerprint: digest(body) };
}
function receipts(bundleValue: ReturnType<typeof bundle>) {
  const custodyBody = { schemaVersion: "addie-fixed-trace-human-panel-control-plane-v1" as const, contractFingerprint: FIXED_TRACE_HUMAN_PANEL_CONTRACT_FINGERPRINTS.custodyReceipt, custodianPseudonym: "test-fixture-not-a-custodian", packFingerprint: hash(99_999), restrictedMapFingerprint: bundleValue.restrictedUnblindingMap.mapFingerprint, signature: "test-fixture-not-a-signature", externalRecordReference: "test-fixture-not-a-real-custody-record" };
  return {
    custodyReceipt: { ...custodyBody, receiptFingerprint: digest(custodyBody) },
    calibrationReceipt: { calibrationFingerprint: hash(30_001), panelFingerprint: hash(30_002), signature: "test-fixture-not-a-signature", externalRecordReference: "test-fixture-not-a-real-calibration-record" },
  };
}

describe("fixed-trace human-primary control plane", () => {
  it("builds exactly two separately randomized blind packets and an evaluator-only map", () => {
    const value = bundle();
    expect(value.raterPackets).toHaveLength(2);
    expect(value.raterPackets.every((packet) => packet.items.length === 216)).toBe(true);
    expect(value.restrictedUnblindingMap.entries).toHaveLength(432);
    expect(value.raterPackets[0]!.items.map((item) => item.opaqueItemId)).not.toEqual(value.raterPackets[1]!.items.map((item) => item.opaqueItemId));
    expect(JSON.stringify(value.raterPackets)).not.toMatch(/provider|architecture|latency|cost|otherRater/);
    validateFixedTraceHumanPanelArtifacts(value);
  });

  it.each([
    ["removing an output", (items: FixedTraceDiagnosticOutput[]) => items.pop()],
    ["changing an arm", (items: FixedTraceDiagnosticOutput[]) => { items[0]!.arm = "two_stage_llm_router"; }],
    ["changing canonical order", (items: FixedTraceDiagnosticOutput[]) => { [items[0], items[1]] = [items[1]!, items[0]!]; }],
    ["replaying an output", (items: FixedTraceDiagnosticOutput[]) => { items[1]!.outputFingerprint = items[0]!.outputFingerprint; }],
  ])("fails closed on altered 216-output cohort: %s", (_name, mutate) => {
    const items = outputs(); mutate(items);
    expect(() => buildFixedTraceHumanPanelArtifacts({ evaluatorControlledNonce: "test-only-evaluator-nonce-0001", primaryRaterPseudonyms: ["rater-alpha", "rater-beta"], outputs: items })).toThrow();
  });

  it("rejects treatment/cross-rater collusion leakage and a corrupt restricted unblinding map", () => {
    const value = bundle();
    for (const [field, leakedValue] of [["architecture", "direct_generation"], ["Other_Rater_Score", "pass"]]) {
      const leaked = structuredClone(value.raterPackets[0]) as any;
      leaked.items[0][field] = leakedValue;
      const { packetFingerprint: _ignored, ...body } = leaked; leaked.packetFingerprint = digest(body);
      expect(() => validateFixedTraceBlindedScoringPacket(leaked)).toThrow(/invalid field set|leaks restricted/);
    }
    const corrupt = structuredClone(value.restrictedUnblindingMap) as any;
    corrupt.entries[0].outputFingerprint = hash(55_555);
    expect(() => validateFixedTraceRestrictedUnblindingMap(corrupt, value.cohortFingerprint)).toThrow(/fingerprint mismatch|exactly two/);
  });

  it("requires valid, independent, non-replayed ratings and never turns abstention into a pass", () => {
    const value = bundle(); const valid = response(value, 0, 0);
    validateFixedTraceIndependentRaterResponse(valid, value.raterAssignments[0]!, value.raterPackets[0]!);
    const duplicate = response(value, 0, 0, { responseId: "another-id" });
    expect(() => createFixedTraceAdjudicationRequests([valid, duplicate], value.raterPackets, value.raterAssignments, value.restrictedUnblindingMap)).toThrow(/duplicate|replayed/);
    const missingPass = response(value, 0, 0, { outputCondition: "missing", quality: "pass" } as any);
    expect(() => validateFixedTraceIndependentRaterResponse(missingPass, value.raterAssignments[0]!, value.raterPackets[0]!)).toThrow(/never passed/);
    const noEvidence = response(value, 0, 0, { evidence: [] });
    expect(() => validateFixedTraceIndependentRaterResponse(noEvidence, value.raterAssignments[0]!, value.raterPackets[0]!)).toThrow(/evidence/);
  });

  it("opens adjudication only for the locked disagreement/missingness rule and caps it at 44", () => {
    const value = bundle(); const ratings = allResponses(value);
    const betaFirst = ratings.find((entry) => entry.raterPseudonym === "rater-beta" && entry.opaqueItemId === value.raterPackets[1]!.items[0]!.opaqueItemId)!;
    Object.assign(betaFirst, response(value, 1, 0, { quality: "fail", safety: "safe", toolCorrectness: "correct" }));
    expect(createFixedTraceAdjudicationRequests(ratings, value.raterPackets, value.raterAssignments, value.restrictedUnblindingMap)).toMatchObject([{ reason: "quality_disagreement" }]);
    for (let item = 1; item <= 44; item += 1) {
      const index = ratings.findIndex((entry) => entry.raterPseudonym === "rater-beta" && entry.opaqueItemId === value.raterPackets[1]!.items[item]!.opaqueItemId);
      ratings[index] = response(value, 1, item, { quality: "fail", safety: "safe", toolCorrectness: "correct" });
    }
    expect(() => createFixedTraceAdjudicationRequests(ratings, value.raterPackets, value.raterAssignments, value.restrictedUnblindingMap)).toThrow(/maximum of 44/);
  });

  it("conservatively reserves human cost and never reports real-panel admission from local inputs", () => {
    const full = ledger([{ entryId: "existing", kind: "primary", quotedCents: 65_000, committedCents: null, actualCents: null }]);
    validateFixedTraceHumanCostLedger(full);
    expect(() => reserveFixedTraceHumanCost(full, { entryId: "over", kind: "primary", quotedCents: 1, committedCents: null, actualCents: null })).toThrow(/exceeds \$650/);
    const value = bundle(); const primary = allResponses(value);
    const costs = ledger(primary.map((entry) => ({ entryId: entry.responseId, kind: "primary" as const, quotedCents: 100, committedCents: 100, actualCents: null })));
    const closedWorkflow = { artifacts: value, primaryResponses: primary, adjudicationResponses: [], ...receipts(value), humanCostLedger: costs };
    const summary = validateFixedTraceHumanPanelWorkflow(closedWorkflow);
    expect(summary).toMatchObject({ toolingReadiness: "tooling_ready_contracts_only", humanPanelReadiness: "not_admitted_pending_real_human_panel_and_custody", promotable: false });
    expect(unblindFixedTraceHumanPanelAfterLockedWorkflow(closedWorkflow).sourceCells).toHaveLength(216);
    expect(fixedTraceHumanPanelReadiness().humanPanelReadiness).toBe("not_admitted_pending_real_human_panel_and_custody");
  });

  it("rejects stale rubrics, cross-rater reuse, and missing custodied inputs", () => {
    const stale = structuredClone(FIXED_TRACE_HUMAN_PANEL_RUBRIC) as any; stale.rules.evidence = "forged";
    expect(() => validateFixedTraceHumanPanelRubric(stale)).toThrow(/fingerprint|locked/);
    expect(() => buildFixedTraceHumanPanelArtifacts({ evaluatorControlledNonce: "test-only-evaluator-nonce-0001", primaryRaterPseudonyms: ["same-rater", "same-rater"], outputs: outputs() })).toThrow(/identity reuse/);
    const value = bundle();
    expect(() => validateFixedTraceHumanPanelWorkflow({ artifacts: value } as any)).toThrow(/invalid field set/);
    expect(() => unblindFixedTraceHumanPanelAfterLockedWorkflow({ artifacts: value } as any)).toThrow(/invalid field set/);
  });
});
