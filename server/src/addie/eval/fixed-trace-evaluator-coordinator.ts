import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import type {
  ModelProviderId,
  ModelReasoningEffort,
} from "../model-providers/model-provider.js";
import { snapshotFixedTraceJson } from "./fixed-trace-safe-snapshot.js";

/**
 * Diagnostic integrity only. An importer supplies this module's key, so this
 * cannot establish evaluator custody or confirmatory evidence. A separately
 * injected opaque privileged signer and durable dispatcher/ledger boundary is
 * required before any admission can be made.
 */
export const FIXED_TRACE_EVALUATOR_COORDINATOR_VERSION =
  "addie-fixed-trace-evaluator-coordinator-v1" as const;

export type FixedTraceLedgerTamperClass =
  | "omission"
  | "insertion"
  | "duplication"
  | "substitution"
  | "reordering"
  | "authentication"
  | "unknown_exposure";
export class FixedTraceLedgerValidationError extends Error {
  constructor(
    readonly tamperClass: FixedTraceLedgerTamperClass,
    message: string,
  ) {
    super(message);
    this.name = "FixedTraceLedgerValidationError";
  }
}

export interface FixedTraceExpectedInvocation {
  readonly runId: string;
  readonly phaseId: string;
  readonly caseId: string;
  readonly armId: string;
  readonly stage: "router" | "generation" | "judge" | "simulator";
  readonly invocation: number;
  readonly attempt: number;
  readonly requested: {
    readonly provider: ModelProviderId;
    readonly model: string;
    readonly effort: ModelReasoningEffort;
    readonly identityPolicy: string;
  };
  readonly controls: {
    readonly promptSha256: string;
    readonly systemSha256: string;
    readonly messagesSha256: string;
    readonly toolSchemaSha256: string;
    readonly providerRequestSha256: string;
    readonly presentedToolNames: readonly string[];
    readonly presentedToolOrderSha256: string;
    readonly simulatorReceiptProvenanceSha256: string;
    readonly simulatorControlsSha256: string;
    readonly architectureSha256: string;
    readonly admissionSha256: string;
    readonly configSha256: string;
    readonly pricingSha256: string;
    readonly limitsSha256: string;
    readonly retryCacheSamplingSha256: string;
    readonly failureDenominatorId: string;
  };
}
export interface FixedTraceActualInvocation extends FixedTraceExpectedInvocation {
  readonly returned: {
    readonly provider: ModelProviderId | null;
    readonly model: string | null;
    readonly identityPolicy: string | null;
  };
  readonly toolCallsSha256: string | null;
  readonly toolInputsSha256: string | null;
  readonly toolResultsSha256: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  } | null;
  readonly pricing: {
    readonly profileId: string;
    readonly costUsd: number;
  } | null;
  readonly terminalStatus:
    | "complete"
    | "timeout_after_dispatch"
    | "provider_error"
    | "malformed"
    | "empty"
    | "truncated"
    | "tool_boundary"
    | "privacy_violation"
    | "not_dispatched_budget"
    | "unknown_exposure";
  readonly errorCode: string | null;
}
export interface FixedTraceExpectedSequenceContract {
  readonly version: typeof FIXED_TRACE_EVALUATOR_COORDINATOR_VERSION;
  readonly keyId: string;
  readonly runId: string;
  readonly protocolFingerprint: string;
  readonly manifestFingerprint: string;
  readonly entries: readonly FixedTraceExpectedInvocation[];
  readonly signature: string;
}
export interface FixedTraceEvidenceLedger {
  readonly admission: "not_admitted_diagnostic_hmac_without_privileged_durable_authority";
  readonly contract: FixedTraceExpectedSequenceContract;
  readonly entries: readonly FixedTraceActualInvocation[];
  readonly complete: boolean;
  readonly halted: boolean;
  readonly plannedDenominator: number;
  readonly observedDenominator: number;
  readonly hardFailureDenominator: number;
  readonly signature: string;
}

const DIAGNOSTIC_ADMISSION =
  "not_admitted_diagnostic_hmac_without_privileged_durable_authority" as const;
const hasExactKeys = (value: unknown, keys: readonly string[]) =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("non-finite evaluator ledger value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("non-JSON evaluator ledger value");
}
function deepSnapshot<T>(value: T): T {
  return snapshotFixedTraceJson(value, "fixed-trace evaluator coordinator") as T;
}
function snapshotCoordinatorConfig(value: unknown): {
  readonly hmacKey: Uint8Array;
  readonly keyId: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new Error("evaluator coordinator configuration must be a plain non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(",") !== "hmacKey,keyId")
    throw new Error("evaluator coordinator configuration has extra or missing fields");
  const key = descriptors.hmacKey;
  const keyId = descriptors.keyId;
  if (!key || !("value" in key) || !keyId || !("value" in keyId))
    throw new Error("evaluator coordinator configuration must use data properties");
  if (
    types.isProxy(key.value) ||
    !(key.value instanceof Uint8Array) ||
    key.value.byteLength < 32 ||
    typeof keyId.value !== "string" ||
    !keyId.value.trim()
  )
    throw new Error("evaluator-owned HMAC custody configuration is required");
  return Object.freeze({ hmacKey: new Uint8Array(key.value), keyId: keyId.value });
}
const isProvider = (value: unknown): value is ModelProviderId =>
  value === "anthropic" || value === "openai" || value === "google";
const isEffort = (value: unknown): value is ModelReasoningEffort =>
  value === "provider_default" || value === "none" || value === "low" || value === "medium" || value === "high";
const isNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
function assertExpectedInvocation(entry: FixedTraceExpectedInvocation, runId: string): void {
  if (!hasExactKeys(entry, [
    "runId", "phaseId", "caseId", "armId", "stage", "invocation", "attempt", "requested", "controls",
  ])) throw new Error("expected sequence entry has extra or missing fields");
  if (
    entry.runId !== runId ||
    !isNonemptyString(entry.phaseId) ||
    !isNonemptyString(entry.caseId) ||
    !isNonemptyString(entry.armId) ||
    !["router", "generation", "judge", "simulator"].includes(entry.stage) ||
    !Number.isSafeInteger(entry.invocation) || entry.invocation < 1 ||
    !Number.isSafeInteger(entry.attempt) || entry.attempt < 1
  ) throw new Error("expected sequence entry has invalid cross-field identity");
  if (!hasExactKeys(entry.requested, ["provider", "model", "effort", "identityPolicy"]) ||
    !isProvider(entry.requested.provider) || !isNonemptyString(entry.requested.model) ||
    !isEffort(entry.requested.effort) || !isNonemptyString(entry.requested.identityPolicy))
    throw new Error("expected sequence entry has invalid requested identity");
  const controls = entry.controls;
  if (!hasExactKeys(controls, [
    "promptSha256", "systemSha256", "messagesSha256", "toolSchemaSha256", "providerRequestSha256",
    "presentedToolNames", "presentedToolOrderSha256", "simulatorReceiptProvenanceSha256",
    "simulatorControlsSha256", "architectureSha256", "admissionSha256", "configSha256", "pricingSha256",
    "limitsSha256", "retryCacheSamplingSha256", "failureDenominatorId",
  ]) ||
    !Object.entries(controls).every(([key, value]) => key === "presentedToolNames"
      ? Array.isArray(value) && value.every(isNonemptyString)
      : isNonemptyString(value)))
    throw new Error("expected sequence entry has invalid controls");
}
const invocationKey = (
  entry: Pick<
    FixedTraceExpectedInvocation,
    | "runId"
    | "phaseId"
    | "caseId"
    | "armId"
    | "stage"
    | "invocation"
    | "attempt"
  >,
) =>
  [
    entry.runId,
    entry.phaseId,
    entry.caseId,
    entry.armId,
    entry.stage,
    entry.invocation,
    entry.attempt,
  ].join("\u0000");
const contractProjection = (
  contract: Omit<FixedTraceExpectedSequenceContract, "signature">,
) => canonical(contract);
const ledgerProjection = (ledger: Omit<FixedTraceEvidenceLedger, "signature">) =>
  canonical(ledger);
const sameExpected = (
  actual: FixedTraceActualInvocation,
  expected: FixedTraceExpectedInvocation,
) => {
  const {
    returned,
    toolCallsSha256,
    toolInputsSha256,
    toolResultsSha256,
    startedAt,
    finishedAt,
    latencyMs,
    usage,
    pricing,
    terminalStatus,
    errorCode,
    ...requested
  } = actual;
  void returned;
  void toolCallsSha256;
  void toolInputsSha256;
  void toolResultsSha256;
  void startedAt;
  void finishedAt;
  void latencyMs;
  void usage;
  void pricing;
  void terminalStatus;
  void errorCode;
  return canonical(requested) === canonical(expected);
};

export function createFixedTraceEvaluatorCoordinator(evaluatorConfig: {
  readonly hmacKey: Uint8Array;
  readonly keyId: string;
}) {
  const detachedConfig = snapshotCoordinatorConfig(evaluatorConfig);
  const sign = (projection: string) =>
    createHmac("sha256", detachedConfig.hmacKey)
      .update(
        `${FIXED_TRACE_EVALUATOR_COORDINATOR_VERSION}\u0000${detachedConfig.keyId}\u0000${projection}`,
      )
      .digest("hex");
  const verify = (contract: FixedTraceExpectedSequenceContract) => {
    if (!hasExactKeys(contract, [
      "version", "keyId", "runId", "protocolFingerprint", "manifestFingerprint", "entries", "signature",
    ]))
      throw new FixedTraceLedgerValidationError(
        "authentication",
        "expected sequence contract has extra or missing fields",
      );
    const projection = contractProjection({
      version: contract.version,
      keyId: contract.keyId,
      runId: contract.runId,
      protocolFingerprint: contract.protocolFingerprint,
      manifestFingerprint: contract.manifestFingerprint,
      entries: contract.entries,
    });
    const expected = Buffer.from(sign(projection), "hex");
    const supplied = Buffer.from(contract.signature, "hex");
    if (
      contract.version !== FIXED_TRACE_EVALUATOR_COORDINATOR_VERSION ||
      contract.keyId !== detachedConfig.keyId ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new FixedTraceLedgerValidationError(
        "authentication",
        "expected sequence contract authentication failed",
      );
  };
  return Object.freeze({
    admission: DIAGNOSTIC_ADMISSION,
    issueExpectedSequence(
      input: Omit<
        FixedTraceExpectedSequenceContract,
        "version" | "keyId" | "signature"
      >,
    ): FixedTraceExpectedSequenceContract {
      input = deepSnapshot(input);
      if (!hasExactKeys(input, ["runId", "protocolFingerprint", "manifestFingerprint", "entries"]))
        throw new Error("expected sequence has extra or missing fields");
      if (
        !input.runId.trim() ||
        !input.protocolFingerprint.trim() ||
        !input.manifestFingerprint.trim() ||
        input.entries.length === 0
      )
        throw new Error(
          "complete evaluator-owned expected sequence is required before dispatch",
        );
      const keys = new Set<string>();
      for (const entry of input.entries) {
        assertExpectedInvocation(entry, input.runId);
        const key = invocationKey(entry);
        if (entry.runId !== input.runId || keys.has(key))
          throw new Error(
            "expected sequence has a duplicate or wrong-run invocation",
          );
        keys.add(key);
      }
      const unsigned = deepSnapshot({
        version: FIXED_TRACE_EVALUATOR_COORDINATOR_VERSION,
        keyId: detachedConfig.keyId,
        ...input,
        entries: deepSnapshot(input.entries),
      } as const);
      return deepSnapshot({
        ...unsigned,
        signature: sign(contractProjection(unsigned)),
      });
    },
    validate(
      contract: FixedTraceExpectedSequenceContract,
      actualEntries: readonly FixedTraceActualInvocation[],
    ): FixedTraceEvidenceLedger {
      const trustedContract = deepSnapshot(contract);
      const trustedActualEntries = deepSnapshot(actualEntries);
      verify(trustedContract);
      const observed: FixedTraceActualInvocation[] = [];
      const seen = new Set<string>();
      let halted = false;
      for (const actual of trustedActualEntries) {
        if (halted)
          throw new FixedTraceLedgerValidationError(
            "unknown_exposure",
            "run was halted after unknown exposure",
          );
        const key = invocationKey(actual);
        const expected = trustedContract.entries[observed.length];
        const knownIndex = trustedContract.entries.findIndex(
          (entry) => invocationKey(entry) === key,
        );
        if (seen.has(key))
          throw new FixedTraceLedgerValidationError(
            "duplication",
            "ledger duplicated an invocation",
          );
        if (knownIndex < 0)
          throw new FixedTraceLedgerValidationError(
            "insertion",
            "ledger inserted an unplanned invocation",
          );
        if (!expected)
          throw new FixedTraceLedgerValidationError(
            "insertion",
            "ledger exceeded the pre-dispatch expected sequence",
          );
        if (knownIndex > observed.length) {
          const expectedKey = invocationKey(expected);
          const appearsLater = trustedActualEntries
            .slice(observed.length + 1)
            .some((entry) => invocationKey(entry) === expectedKey);
          throw new FixedTraceLedgerValidationError(
            appearsLater ? "reordering" : "omission",
            appearsLater
              ? "ledger reordered an expected invocation"
              : "ledger omitted an expected invocation before a later one",
          );
        }
        if (knownIndex < observed.length)
          throw new FixedTraceLedgerValidationError(
            "reordering",
            "ledger reordered an expected invocation",
          );
        if (!sameExpected(actual, expected))
          throw new FixedTraceLedgerValidationError(
            "substitution",
            "ledger substituted evaluator-owned requested identity or controls",
          );
        if (
          !Number.isFinite(actual.latencyMs) ||
          actual.latencyMs < 0 ||
          Number.isNaN(Date.parse(actual.startedAt)) ||
          Number.isNaN(Date.parse(actual.finishedAt))
        )
          throw new FixedTraceLedgerValidationError(
            "substitution",
            "ledger has invalid timing evidence",
          );
        if (Date.parse(actual.finishedAt) < Date.parse(actual.startedAt))
          throw new FixedTraceLedgerValidationError(
            "substitution",
            "ledger finished before it started",
          );
        if (actual.terminalStatus === "unknown_exposure") {
          halted = true;
          throw new FixedTraceLedgerValidationError(
            "unknown_exposure",
            "unknown provider exposure halts the run",
          );
        }
        if (actual.terminalStatus !== "not_dispatched_budget") {
          if (
            actual.returned.provider !== expected.requested.provider ||
            actual.returned.model !== expected.requested.model ||
            actual.returned.identityPolicy !== expected.requested.identityPolicy
          )
            throw new FixedTraceLedgerValidationError(
              "substitution",
              "ledger returned a different provider, model, or identity policy",
            );
          if (
            !actual.usage ||
            !actual.pricing ||
            !Number.isFinite(actual.pricing.costUsd) ||
            actual.pricing.costUsd < 0 ||
            Object.values(actual.usage).some(
              (value) => !Number.isSafeInteger(value) || value < 0,
            )
          )
            throw new FixedTraceLedgerValidationError(
              "substitution",
              "dispatched invocation lacks complete trusted usage or pricing",
            );
        }
        seen.add(key);
        observed.push(actual);
      }
      if (observed.length !== trustedContract.entries.length)
        throw new FixedTraceLedgerValidationError(
          "omission",
          "ledger ended before its planned denominator",
        );
      const hardFailureDenominator = observed.filter(
        (entry) => entry.terminalStatus !== "complete",
      ).length;
      const unsignedLedger = deepSnapshot({
        admission: DIAGNOSTIC_ADMISSION,
        contract: trustedContract,
        entries: observed,
        complete: true,
        halted: false,
        plannedDenominator: trustedContract.entries.length,
        observedDenominator: observed.length,
        hardFailureDenominator,
      });
      return deepSnapshot({
        ...unsignedLedger,
        signature: sign(ledgerProjection(unsignedLedger)),
      });
    },
  });
}
