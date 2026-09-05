import type {
  ModelProviderId,
  ModelReasoningEffort,
} from "../model-providers/model-provider.js";

/**
 * This integration slice deliberately has no evaluator-issued custody
 * boundary. The A protocol has neither a custodied schedule nor a dated
 * prospective pricing descriptor, and this module does not own a durable
 * signer/nonce store. It therefore must not turn caller supplied plans, keys,
 * or evidence into apparently authenticated ledger records.
 *
 * A later privileged integration may replace this refusal with an opaque
 * issuer that derives every field from validated A artifacts and atomically
 * consumes a durable nonce. It must use a closed evidence schema and
 * recompute derived evidence before it issues even diagnostic records.
 */
export const FIXED_TRACE_EVALUATOR_COORDINATOR_VERSION =
  "addie-fixed-trace-evaluator-coordinator-v1" as const;
export const FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION =
  "not_admitted_missing_privileged_schedule_pricing_and_durable_custody" as const;

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

export class FixedTraceEvaluatorCoordinatorUnavailableError extends Error {
  constructor() {
    super(FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION);
    this.name = "FixedTraceEvaluatorCoordinatorUnavailableError";
  }
}

/** Declaration-only contract. This module cannot issue it. */
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

/**
 * Declaration only. A privileged issuer must add A's repetition, episode,
 * block, position, seed, schedule, worker, adjudication, custody, and
 * missingness bindings before dispatch.
 */
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

/** No value of this shape can be produced by this non-admitting module. */
export interface FixedTraceEvidenceLedger {
  readonly admission: typeof FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION;
  readonly contract: FixedTraceExpectedSequenceContract;
  readonly entries: readonly FixedTraceActualInvocation[];
  readonly diagnosticSequenceStatus: "unavailable";
  readonly halted: boolean;
  readonly plannedDenominator: number;
  readonly observedDenominator: number;
  readonly hardFailureDenominator: number;
  readonly signature: string;
}

export interface FixedTraceEvaluatorCoordinator {
  readonly admission: typeof FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION;
  issueExpectedSequence(
    input: Omit<FixedTraceExpectedSequenceContract, "version" | "keyId" | "signature">,
  ): never;
  validate(
    contract: FixedTraceExpectedSequenceContract,
    actualEntries: readonly FixedTraceActualInvocation[],
  ): never;
}

/**
 * Refuse without reading `evaluatorConfig`. An imported HMAC key is not an
 * evaluator authority and cannot mint replayable contracts.
 */
export function createFixedTraceEvaluatorCoordinator(
  _evaluatorConfig: unknown,
): FixedTraceEvaluatorCoordinator {
  const unavailable = (): never => {
    throw new FixedTraceEvaluatorCoordinatorUnavailableError();
  };
  return Object.freeze({
    admission: FIXED_TRACE_EVALUATOR_COORDINATOR_ADMISSION,
    issueExpectedSequence: (_input: unknown): never => unavailable(),
    validate: (_contract: unknown, _actualEntries: unknown): never => unavailable(),
  });
}
