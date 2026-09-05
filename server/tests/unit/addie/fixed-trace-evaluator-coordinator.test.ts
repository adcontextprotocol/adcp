import { describe, expect, it } from "vitest";
import {
  createFixedTraceEvaluatorCoordinator,
  FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
  FixedTraceEvaluatorCoordinatorUnavailableError,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";

const digest = "a".repeat(64);

/**
 * The A protocol deliberately has no custodied schedule or current dated
 * pricing cohort. Verify that all arbitrary contract/evidence shapes fail at
 * the custody boundary, before a caller getter/proxy can participate.
 */
describe("fixed-trace evaluator coordinator custody boundary", () => {
  it("has no caller-mintable signer, contract issuer, or replayable validator", () => {
    const coordinator = createFixedTraceEvaluatorCoordinator({
      hmacKey: new Uint8Array(32).fill(7),
      keyId: "forged-importer-key",
    });
    expect(coordinator.admission).toBe(FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION);
    const forgedContract = {
      runId: "forged-run",
      protocolFingerprint: digest,
      manifestFingerprint: digest,
      entries: [],
    } as any;
    expect(() => coordinator.issueExpectedSequence(forgedContract)).toThrow(
      FixedTraceEvaluatorCoordinatorUnavailableError,
    );
    expect(() => coordinator.issueExpectedSequence(forgedContract)).toThrow(
      FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
    );
  });

  it.each([
    ["missing terminal status", { terminalStatus: undefined }],
    ["unknown terminal status", { terminalStatus: "invented" }],
    ["success with error", { terminalStatus: "complete", errorCode: "error" }],
    ["provider error without error", { terminalStatus: "provider_error", errorCode: null }],
    ["impossible timestamp", { startedAt: "later", finishedAt: "earlier" }],
    ["unrelated tool hash", { toolCallsSha256: digest }],
    ["unknown nested field", { usage: { invented: true } }],
    ["zero completed usage", { usage: { inputTokens: 0, outputTokens: 0 } }],
    ["invented identity policy", { requested: { identityPolicy: "invented" } }],
    ["invented denominator", { controls: { failureDenominatorId: "invented" } }],
  ])("refuses %s before evidence can become a ledger", (_label, hostileEvidence) => {
    const coordinator = createFixedTraceEvaluatorCoordinator({});
    expect(() => coordinator.validate(
      { ...hostileEvidence } as any,
      [hostileEvidence] as any,
    )).toThrow(FixedTraceEvaluatorCoordinatorUnavailableError);
  });

  it("does not read caller configuration, contract, evidence, proxy, or nested getter", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "hmacKey", {
      enumerable: true,
      get: () => { reads += 1; return new Uint8Array(32); },
    });
    const coordinator = createFixedTraceEvaluatorCoordinator(new Proxy(getter, {}));
    const contract = new Proxy({
      version: "forged",
      get keyId() { reads += 1; return "forged"; },
      entries: [{ get controls() { reads += 1; return {}; } }],
    }, {});
    expect(() => coordinator.validate(contract as any, new Proxy([], {}))).toThrow(
      FixedTraceEvaluatorCoordinatorUnavailableError,
    );
    expect(reads).toBe(0);
  });
});
