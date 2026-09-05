import { describe, expect, it } from "vitest";
import {
  createFixedTraceEvaluatorCoordinator,
  FixedTraceLedgerValidationError,
  type FixedTraceActualInvocation,
  type FixedTraceExpectedInvocation,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";

const coordinator = createFixedTraceEvaluatorCoordinator({
  hmacKey: new Uint8Array(32).fill(7),
  keyId: "test-evaluator-custody-v1",
});
const expected = (
  caseId: string,
  invocation: number,
): FixedTraceExpectedInvocation => ({
  runId: "run-1",
  phaseId: "stage_1_smoke",
  caseId,
  armId: "arm-1",
  stage: "generation",
  invocation,
  attempt: 1,
  requested: {
    provider: "anthropic",
    model: "claude-sonnet-5",
    effort: "provider_default",
    identityPolicy: "exact_model_identity_v1",
  },
  controls: {
    promptSha256: "a",
    systemSha256: "b",
    messagesSha256: "c",
    toolSchemaSha256: "d",
    providerRequestSha256: "e",
    presentedToolNames: ["search_docs"],
    presentedToolOrderSha256: "f",
    simulatorReceiptProvenanceSha256: "g",
    simulatorControlsSha256: "h",
    architectureSha256: "i",
    admissionSha256: "j",
    configSha256: "k",
    pricingSha256: "l",
    limitsSha256: "m",
    retryCacheSamplingSha256: "n",
    failureDenominatorId: "all-planned-invocations-v1",
  },
});
const actual = (
  entry: FixedTraceExpectedInvocation,
): FixedTraceActualInvocation => ({
  ...entry,
  returned: {
    provider: "anthropic",
    model: "claude-sonnet-5",
    identityPolicy: "exact_model_identity_v1",
  },
  toolCallsSha256: "o",
  toolInputsSha256: "p",
  toolResultsSha256: "q",
  startedAt: "2026-09-05T00:00:00.000Z",
  finishedAt: "2026-09-05T00:00:01.000Z",
  latencyMs: 1_000,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  pricing: { profileId: "p", costUsd: 0.000001 },
  terminalStatus: "complete",
  errorCode: null,
});
const contract = () =>
  coordinator.issueExpectedSequence({
    runId: "run-1",
    protocolFingerprint: "protocol",
    manifestFingerprint: "manifest",
    entries: [expected("case-a", 1), expected("case-b", 2)],
  });

describe("fixed-trace evaluator-owned evidence coordinator", () => {
  it("authenticates and validates the complete pre-dispatch sequence", () => {
    const issued = contract();
    const ledger = coordinator.validate(issued, issued.entries.map(actual));
    expect(ledger).toMatchObject({
      complete: true,
      admission:
        "not_admitted_diagnostic_hmac_without_privileged_durable_authority",
      plannedDenominator: 2,
      observedDenominator: 2,
      hardFailureDenominator: 0,
    });
    expect(issued.keyId).toBe("test-evaluator-custody-v1");
    expect(ledger.signature).toMatch(/^[a-f0-9]{64}$/);
  });
  it("snapshots and freezes nested contracts and ledgers", () => {
    const entries = [expected("case-a", 1), expected("case-b", 2)];
    const issued = coordinator.issueExpectedSequence({
      runId: "run-1", protocolFingerprint: "protocol", manifestFingerprint: "manifest", entries,
    });
    (entries[0]!.controls.presentedToolNames as unknown as string[])[0] = "rewritten";
    expect(issued.entries[0]!.controls.presentedToolNames[0]).toBe("search_docs");
    const supplied = issued.entries.map((entry) => ({
      ...actual(entry),
      controls: {
        ...entry.controls,
        presentedToolNames: [...entry.controls.presentedToolNames],
      },
    }));
    const ledger = coordinator.validate(issued, supplied);
    (supplied[0]!.controls.presentedToolNames as unknown as string[])[0] = "rewritten-again";
    expect(ledger.entries[0]!.controls.presentedToolNames[0]).toBe("search_docs");
    expect(Object.isFrozen(ledger.entries[0]!.controls.presentedToolNames)).toBe(true);
    expect(() => {
      (ledger.entries[0]!.controls.presentedToolNames as unknown as string[])[0] = "tamper";
    }).toThrow();
  });
  it("never represents caller-keyed HMAC output as privileged custody", () => {
    const arbitraryImporter = createFixedTraceEvaluatorCoordinator({
      hmacKey: new Uint8Array(32).fill(9), keyId: "arbitrary-importer-key",
    });
    expect(arbitraryImporter.admission).toBe(
      "not_admitted_diagnostic_hmac_without_privileged_durable_authority",
    );
    const issued = arbitraryImporter.issueExpectedSequence({
      runId: "run-1", protocolFingerprint: "protocol", manifestFingerprint: "manifest",
      entries: [expected("case-a", 1)],
    });
    expect(arbitraryImporter.validate(issued, [actual(issued.entries[0]!)]).admission)
      .toBe("not_admitted_diagnostic_hmac_without_privileged_durable_authority");
  });
  it.each([
    [
      "omission",
      (issued: ReturnType<typeof contract>) => [actual(issued.entries[1]!)],
    ],
    [
      "insertion",
      (issued: ReturnType<typeof contract>) => [
        { ...actual(issued.entries[0]!), caseId: "unplanned" },
      ],
    ],
    [
      "duplication",
      (issued: ReturnType<typeof contract>) => [
        actual(issued.entries[0]!),
        actual(issued.entries[0]!),
        actual(issued.entries[1]!),
      ],
    ],
    [
      "substitution",
      (issued: ReturnType<typeof contract>) => [
        {
          ...actual(issued.entries[0]!),
          requested: { ...issued.entries[0]!.requested, model: "wrong-model" },
        },
      ],
    ],
    [
      "reordering",
      (issued: ReturnType<typeof contract>) => [
        actual(issued.entries[1]!),
        actual(issued.entries[0]!),
      ],
    ],
  ] as const)(
    "rejects %s through its distinct validation branch",
    (kind, build) => {
      const issued = contract();
      try {
        coordinator.validate(issued, build(issued));
      } catch (error) {
        expect(error).toBeInstanceOf(FixedTraceLedgerValidationError);
        expect((error as FixedTraceLedgerValidationError).tamperClass).toBe(
          kind,
        );
        return;
      }
      throw new Error("expected ledger validation failure");
    },
  );
  it("rejects contract restamping and halts unknown exposure", () => {
    const issued = contract();
    expect(() =>
      coordinator.validate(
        { ...issued, signature: "00".repeat(32) },
        issued.entries.map(actual),
      ),
    ).toThrow("authentication");
    expect(() => coordinator.validate(
      { ...issued, keyId: "wrong-custody-key" },
      issued.entries.map(actual),
    )).toThrow("authentication");
    expect(() =>
      coordinator.validate(issued, [
        { ...actual(issued.entries[0]!), terminalStatus: "unknown_exposure" },
      ]),
    ).toThrow("unknown provider exposure");
  });
});
