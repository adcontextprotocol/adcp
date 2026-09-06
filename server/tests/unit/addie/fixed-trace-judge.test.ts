import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
  fixedTraceJudgeSummaryUnavailable,
  fixedTraceJudgeUnavailable,
} from "../../../src/addie/eval/fixed-trace-judge.js";
import {
  FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
} from "../../../src/addie/eval/fixed-trace-evidence-prerequisite.js";

describe("fixed-trace judge refusal boundary", () => {
  it("exports only unavailable state and one exhaustive shared C schema manifest", () => {
    const result = fixedTraceJudgeUnavailable();
    expect(result).toMatchObject({
      status: "unavailable",
      admission: FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
      requiredSealedEvidence: FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS,
    });
    expect(Object.keys(FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS)).toEqual([
      "schemaVersion", "plan", "assignment", "invocation", "requestIntegrity",
      "toolAndSimulatorEvidence", "configuration", "timingAndOutcome",
      "usageAndPricing", "denominatorAndSequence", "judgeAndCustody", "replayProtection",
    ]);
  });

  it("has no positive dispatch/configuration entrypoint to consume hostile values", () => {
    const reads = { get: 0, primitive: 0 };
    const hostile = new Proxy({
      [Symbol.toPrimitive]: () => { reads.primitive += 1; throw new Error("coerced"); },
    }, { get: () => { reads.get += 1; throw new Error("read"); } });
    const entry = fixedTraceJudgeUnavailable as unknown as (...args: unknown[]) => unknown;
    const summaryEntry = fixedTraceJudgeSummaryUnavailable as unknown as (...args: unknown[]) => unknown;
    expect(entry(hostile)).toMatchObject({ status: "unavailable" });
    expect(summaryEntry(hostile)).toMatchObject({ status: "unavailable" });
    expect(reads).toEqual({ get: 0, primitive: 0 });
  });

  it("cannot be mistaken for complete observations or comparison eligibility", () => {
    expect(fixedTraceJudgeSummaryUnavailable()).toMatchObject({
      status: "unavailable",
      expectedCases: 0,
      observedJudgments: 0,
      expectedRecordCountObserved: false,
      comparisonEligible: false,
      totalEstimatedCostUsd: null,
    });
  });
});
