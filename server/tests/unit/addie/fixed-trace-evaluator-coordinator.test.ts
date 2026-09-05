import { describe, expect, it } from "vitest";
import {
  createFixedTraceEvaluatorCoordinator,
  FixedTraceLedgerValidationError,
  type FixedTraceActualInvocation,
  type FixedTraceExpectedInvocation,
} from "../../../src/addie/eval/fixed-trace-evaluator-coordinator.js";
import { resolveModelCostPricing } from "../../../src/addie/model-cost-pricing.js";

const digest = (value: string) => value.repeat(64);
const anthopicCohort = resolveModelCostPricing("anthropic", "claude-sonnet-5")!;

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
    promptSha256: digest("a"),
    systemSha256: digest("b"),
    messagesSha256: digest("c"),
    toolSchemaSha256: digest("d"),
    providerRequestSha256: digest("e"),
    presentedToolNames: ["search_docs"],
    presentedToolOrderSha256: digest("f"),
    simulatorReceiptProvenanceSha256: digest("a"),
    simulatorControlsSha256: digest("b"),
    architectureSha256: digest("c"),
    admissionSha256: digest("d"),
    configSha256: digest("e"),
    pricingSha256: digest("f"),
    limitsSha256: digest("a"),
    retryCacheSamplingSha256: digest("b"),
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
  toolCallsSha256: digest("a"),
  toolInputsSha256: digest("b"),
  toolResultsSha256: digest("c"),
  startedAt: "2026-09-05T00:00:00.000Z",
  finishedAt: "2026-09-05T00:00:01.000Z",
  latencyMs: 1_000,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  pricing: {
    profileId: anthopicCohort.version,
    costUsd: anthopicCohort.estimateCostMicros({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }) / 1_000_000,
  },
  terminalStatus: "complete",
  errorCode: null,
});
const contract = () =>
  coordinator.issueExpectedSequence({
    runId: "run-1",
    protocolFingerprint: digest("a"),
    manifestFingerprint: digest("b"),
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
      runId: "run-1", protocolFingerprint: digest("a"), manifestFingerprint: digest("b"), entries,
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
      runId: "run-1", protocolFingerprint: digest("a"), manifestFingerprint: digest("b"),
      entries: [expected("case-a", 1)],
    });
    expect(arbitraryImporter.validate(issued, [actual(issued.entries[0]!)]).admission)
      .toBe("not_admitted_diagnostic_hmac_without_privileged_durable_authority");
  });
  it("rejects getter/proxy inputs and detaches mutable key material", () => {
    const key = new Uint8Array(32).fill(3);
    const config = { hmacKey: key, keyId: "detached-key" };
    const detached = createFixedTraceEvaluatorCoordinator(config);
    key.fill(4);
    config.keyId = "rewritten-key";
    const issued = detached.issueExpectedSequence({
      runId: "run-1", protocolFingerprint: digest("a"), manifestFingerprint: digest("b"),
      entries: [expected("case-a", 1)],
    });
    expect(issued.keyId).toBe("detached-key");
    expect(detached.validate(issued, [actual(issued.entries[0]!)]).complete).toBe(true);
    const getterInput = {
      protocolFingerprint: digest("a"), manifestFingerprint: digest("b"), entries: [expected("case-a", 1)],
    } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(getterInput, "runId", {
      enumerable: true,
      get: () => (++reads === 1 ? "run-1" : "run-2"),
    });
    expect(() => detached.issueExpectedSequence(getterInput as any)).toThrow("own enumerable data property");
    expect(reads).toBe(0);
    expect(() => createFixedTraceEvaluatorCoordinator(new Proxy(config, {}))).toThrow("non-proxy");
    expect(() => detached.issueExpectedSequence(new Proxy({
      runId: "run-1", protocolFingerprint: digest("a"), manifestFingerprint: digest("b"), entries: [expected("case-a", 1)],
    }, {}))).toThrow("must not contain a Proxy");
    const actualEntries = [actual(issued.entries[0]!)];
    expect(() => detached.validate(issued, new Proxy(actualEntries, {}))).toThrow("must not contain a Proxy");
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
