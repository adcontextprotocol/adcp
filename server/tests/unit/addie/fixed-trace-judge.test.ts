import { describe, expect, it } from "vitest";
import {
  FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
  fixedTraceJudgeSummaryUnavailable,
  fixedTraceJudgeUnavailable,
} from "../../../src/addie/eval/fixed-trace-judge.js";

describe("fixed-trace judge refusal boundary", () => {
  it("exports only a non-admitting result and C-owned evidence requirements", () => {
    const result = fixedTraceJudgeUnavailable();
    expect(result).toMatchObject({
      status: "unavailable",
      admission: FIXED_TRACE_JUDGE_CALIBRATION_ADMISSION,
    });
    expect(result.requiredSealedEvidence).toEqual(expect.arrayContaining([
      "protocolFingerprint", "scheduleDigest", "pricingCohortDigest",
      "calibrationDigest", "providerExposureLedgerDigest", "repetition",
      "episodeId", "blockId", "position", "custodyBinding",
    ]));
  });

  it("has no caller-configured entrypoint to read a hostile proxy", () => {
    let reads = 0;
    const hostile = new Proxy({}, { get: () => { reads += 1; throw new Error("read"); } });
    void hostile;
    expect(fixedTraceJudgeUnavailable().status).toBe("unavailable");
    expect(reads).toBe(0);
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
