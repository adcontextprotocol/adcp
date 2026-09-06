/**
 * B's refusal-only prerequisite. It reads only the dependency-free A manifest
 * and an independent literal pin; neither is an execution authority.
 */
import { createHash } from "node:crypto";
import {
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON,
  FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON,
} from "./fixed-trace-a-prerequisite-manifest.js";

/** Independently pinned by this consumer; do not trust source-module policy. */
const FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES_PIN = 16 * 1024;
const FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_SHA256_PIN =
  "b9d4210347e9b8e8948971c92025ec932c2a5585485addd36cb2bd13562f2cef" as const;

function fixedTracePrerequisiteSourceSha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export const FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION =
  "not_admitted_missing_validated_A_schedule_pricing_custody_calibration_and_C_sealed_authority" as const;

declare const fixedTraceSha256Brand: unique symbol;
type FixedTraceSha256 = string & { readonly [fixedTraceSha256Brand]: "sha256" };
type FixedTraceUtcTimestamp = `${number}-${number}-${number}T${string}Z`;
type FixedTraceSealedEvidenceSchemaVersion = "addie-fixed-trace-sealed-evidence-v1";
type FixedTraceTerminalStatus =
  | "complete"
  | "ignored"
  | "reacted"
  | "refusal"
  | "truncated"
  | "empty"
  | "malformed"
  | "provider_error"
  | "timeout_after_dispatch"
  | "unknown_exposure"
  | "not_dispatched_budget"
  | "not_admitted_architecture";
type FixedTraceInvocationStage = "router" | "generation" | "judge" | "simulator";
type FixedTraceFinishReason = "stop" | "tool_calls" | "length" | "refusal" | "continue";
type FixedTraceCompleteness = "complete" | "incomplete" | "unknown_exposure";
type FixedTraceTamperClass = "none" | "omission" | "insertion" | "duplication" | "substitution" | "reordering";
type FixedTraceReplayStatus = "consumed";

/**
 * Exhaustive future-C record shape. It is a required schema declaration, not
 * a B-issued contract or an admission to dispatch. C must validate, snapshot,
 * and authenticate every nested value behind its sealed one-use authority.
 */
export interface FixedTraceSealedEvidenceRequirements {
  readonly schemaVersion: FixedTraceSealedEvidenceSchemaVersion;
  readonly plan: {
    readonly protocolFingerprint: FixedTraceSha256;
    readonly corpusSuiteVersion: string;
    readonly corpusSuiteSha256: FixedTraceSha256;
    readonly partitionManifestSha256: FixedTraceSha256;
    readonly experimentalDesignFingerprint: FixedTraceSha256;
    readonly measurementManifestSha256: FixedTraceSha256;
    readonly packManifestSha256: FixedTraceSha256;
    readonly packCustodySignature: string;
  };
  readonly assignment: {
    readonly runId: string;
    readonly phaseId: string;
    readonly armId: string;
    readonly architectureId: string;
    readonly caseId: string;
    readonly episodeId: string;
    readonly clusterId: string;
    readonly stratumId: string;
    readonly repetition: number;
    readonly blockId: string;
    readonly order: number;
    readonly position: number;
    readonly randomizationSeed: string;
    readonly scheduleDigest: FixedTraceSha256;
    readonly workerIdentity: string;
  };
  readonly invocation: {
    readonly stage: FixedTraceInvocationStage;
    readonly invocation: number;
    readonly attempt: number;
    readonly requestedProvider: string;
    readonly requestedModel: string;
    readonly requestedEffort: string;
    readonly returnedProvider: string | null;
    readonly returnedModel: string | null;
    readonly returnedEffort: string | null;
    readonly identityPolicy: string;
    readonly fallbackOfAttempt: number | null;
  };
  readonly requestIntegrity: {
    readonly systemSha256: FixedTraceSha256;
    readonly promptSha256: FixedTraceSha256;
    readonly messagesSha256: FixedTraceSha256;
    readonly toolSchemaSha256: FixedTraceSha256;
    readonly providerRequestSha256: FixedTraceSha256;
    readonly presentedToolNamesSha256: FixedTraceSha256;
    readonly presentedToolOrderSha256: FixedTraceSha256;
    readonly requestFactsSha256: FixedTraceSha256;
    readonly sourceThreadBindingSha256: FixedTraceSha256;
  };
  readonly toolAndSimulatorEvidence: {
    readonly toolCallSha256: FixedTraceSha256 | null;
    readonly toolInputSha256: FixedTraceSha256 | null;
    readonly toolResultSha256: FixedTraceSha256 | null;
    readonly simulatorReceiptSha256: FixedTraceSha256 | null;
    readonly simulatorFaultProvenanceSha256: FixedTraceSha256 | null;
    readonly simulatorControlsSha256: FixedTraceSha256;
  };
  readonly configuration: {
    readonly architectureSha256: FixedTraceSha256;
    readonly admissionSha256: FixedTraceSha256;
    readonly configSha256: FixedTraceSha256;
    readonly promptConfigSha256: FixedTraceSha256;
    readonly softwareSha256: FixedTraceSha256;
    readonly adapterSha256: FixedTraceSha256;
    readonly limitsSha256: FixedTraceSha256;
    readonly retryPolicySha256: FixedTraceSha256;
    readonly cachePolicySha256: FixedTraceSha256;
    readonly samplingPolicySha256: FixedTraceSha256;
  };
  readonly timingAndOutcome: {
    readonly preparedAt: FixedTraceUtcTimestamp;
    readonly dispatchedAt: FixedTraceUtcTimestamp | null;
    readonly completedAt: FixedTraceUtcTimestamp | null;
    readonly latencyMs: number | null;
    readonly timeout: boolean;
    readonly errorCode: string | null;
    readonly terminalStatus: FixedTraceTerminalStatus;
    /** Exact normalized finish reason returned by the provider. */
    readonly finishReason: FixedTraceFinishReason | null;
    readonly outputSha256: FixedTraceSha256 | null;
  };
  readonly usageAndPricing: {
    readonly usageSha256: FixedTraceSha256 | null;
    readonly inputTokens: number | null;
    readonly cachedInputTokens: number | null;
    readonly outputTokens: number | null;
    readonly pricingCohortId: string;
    readonly pricingCohortSha256: FixedTraceSha256;
    readonly pricingEffectiveFrom: FixedTraceUtcTimestamp;
    readonly pricingEffectiveBefore: FixedTraceUtcTimestamp | null;
    readonly computedCostUsd: number | null;
    readonly reservationId: string;
    readonly reservationCeilingUsd: number;
    readonly settlementSha256: FixedTraceSha256 | null;
  };
  readonly denominatorAndSequence: {
    readonly denominatorId: string;
    readonly failureEvidenceSha256: FixedTraceSha256;
    readonly missingnessSha256: FixedTraceSha256;
    readonly expectedSequenceSha256: FixedTraceSha256;
    readonly actualSequenceSha256: FixedTraceSha256;
    readonly completeness: FixedTraceCompleteness;
    readonly tamperClass: FixedTraceTamperClass;
  };
  readonly judgeAndCustody: {
    readonly calibrationDigest: FixedTraceSha256;
    readonly blindedPresentationSha256: FixedTraceSha256;
    readonly adjudicationBinding: FixedTraceSha256;
    readonly providerExposureLedgerSha256: FixedTraceSha256;
    readonly custodyBinding: FixedTraceSha256;
    readonly signerKeyId: string;
    readonly signature: string;
  };
  readonly replayProtection: {
    readonly authorityId: string;
    readonly nonce: string;
    readonly oneUseConsumptionSha256: FixedTraceSha256;
    readonly replayStatus: FixedTraceReplayStatus;
  };
}

type FixedTraceEvidenceLeafSchema<Value> =
  [Value] extends [FixedTraceSha256] ? { readonly type: "sha256" }
    : [Value] extends [FixedTraceUtcTimestamp] ? { readonly type: "utc_timestamp" }
      : [Value] extends [null] ? { readonly type: "null" }
        : [Exclude<Value, null>] extends [FixedTraceSha256]
          ? { readonly type: "nullable_sha256" }
          : [Exclude<Value, null>] extends [FixedTraceUtcTimestamp]
            ? { readonly type: "nullable_utc_timestamp" }
            : [Value] extends [number]
              ? { readonly type: "number" }
              : [Exclude<Value, null>] extends [number]
                ? { readonly type: "nullable_number" }
                : [Value] extends [boolean]
                  ? { readonly type: "boolean" }
                  : [Value] extends [string]
                    ? string extends Value
                      ? { readonly type: "string" }
                      : { readonly type: "enum"; readonly values: readonly Value[] }
                    : [Exclude<Value, null>] extends [string]
                      ? string extends Exclude<Value, null>
                        ? { readonly type: "nullable_string" }
                        : { readonly type: "nullable_enum"; readonly values: readonly Exclude<Value, null>[] }
                      : never;

type FixedTraceEvidenceRequirementManifest<Value> =
  [Value] extends [object]
    ? Value extends FixedTraceSha256 | FixedTraceUtcTimestamp
      ? FixedTraceEvidenceLeafSchema<Value>
      : { readonly [Key in keyof Value]: FixedTraceEvidenceRequirementManifest<Value[Key]> }
    : FixedTraceEvidenceLeafSchema<Value>;

export type FixedTraceSealedEvidenceRequirementManifest =
  FixedTraceEvidenceRequirementManifest<FixedTraceSealedEvidenceRequirements>;

type ExactEnumValues<Domain extends string, Values extends readonly Domain[]> =
  Exclude<Domain, Values[number]> extends never
    ? Exclude<Values[number], Domain> extends never ? Values : never
    : never;
type FixedTraceAssertTrue<Value extends true> = Value;
type FixedTraceEnumIsExhaustive<Domain extends string, Values extends readonly Domain[]> =
  Exclude<Domain, Values[number]> extends never
    ? Exclude<Values[number], Domain> extends never ? true : false
    : false;

/**
 * Contextual `readonly Domain[]` types permit omitted members. These helpers
 * retain the tuple literal and reject both missing and extra closed-domain
 * members before the schema is widened to its recursive manifest type.
 */
function fixedTraceEnum<Domain extends string>() {
  return <const Values extends readonly Domain[]>(
    values: Values & ExactEnumValues<Domain, Values>,
  ): { readonly type: "enum"; readonly values: Values } => ({ type: "enum", values });
}

function fixedTraceNullableEnum<Domain extends string>() {
  return <const Values extends readonly Domain[]>(
    values: Values & ExactEnumValues<Domain, Values>,
  ): { readonly type: "nullable_enum"; readonly values: Values } => ({ type: "nullable_enum", values });
}

// Compile-time negative probes: deleting a member from any closed domain is
// an error. These are type-only checks; no unreachable runtime statements.
// @ts-expect-error closed schemaVersion domain cannot omit its only value
type FixedTraceMissingSchemaVersion = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<"addie-fixed-trace-sealed-evidence-v1", []>>;
// @ts-expect-error invocation stages must be exhaustive
type FixedTraceMissingInvocationStage = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceInvocationStage, ["router"]>>;
// @ts-expect-error terminal statuses must be exhaustive
type FixedTraceMissingTerminalStatus = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceTerminalStatus, ["complete"]>>;
// @ts-expect-error finish reasons must be exhaustive
type FixedTraceMissingFinishReason = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceFinishReason, ["stop"]>>;
// @ts-expect-error completeness outcomes must be exhaustive
type FixedTraceMissingCompleteness = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceCompleteness, ["complete"]>>;
// @ts-expect-error tamper classes must be exhaustive
type FixedTraceMissingTamperClass = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceTamperClass, ["none"]>>;
// @ts-expect-error replay status cannot omit its only value
type FixedTraceMissingReplayStatus = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceReplayStatus, []>>;
// @ts-expect-error schemaVersion cannot admit a member outside its closed domain
type FixedTraceExtraSchemaVersion = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceSealedEvidenceSchemaVersion, ["addie-fixed-trace-sealed-evidence-v1", "v2"]>>;
// @ts-expect-error invocation stages cannot admit a member outside their closed domain
type FixedTraceExtraInvocationStage = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceInvocationStage, ["router", "generation", "judge", "simulator", "forged"]>>;
// @ts-expect-error terminal statuses cannot admit a member outside their closed domain
type FixedTraceExtraTerminalStatus = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceTerminalStatus, ["complete", "ignored", "reacted", "refusal", "truncated", "empty", "malformed", "provider_error", "timeout_after_dispatch", "unknown_exposure", "not_dispatched_budget", "not_admitted_architecture", "forged"]>>;
// @ts-expect-error finish reasons cannot admit a member outside their closed domain
type FixedTraceExtraFinishReason = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceFinishReason, ["stop", "tool_calls", "length", "refusal", "continue", "forged"]>>;
// @ts-expect-error completeness outcomes cannot admit a member outside their closed domain
type FixedTraceExtraCompleteness = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceCompleteness, ["complete", "incomplete", "unknown_exposure", "forged"]>>;
// @ts-expect-error tamper classes cannot admit a member outside their closed domain
type FixedTraceExtraTamperClass = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceTamperClass, ["none", "omission", "insertion", "duplication", "substitution", "reordering", "forged"]>>;
// @ts-expect-error replay status cannot admit a member outside its closed domain
type FixedTraceExtraReplayStatus = FixedTraceAssertTrue<FixedTraceEnumIsExhaustive<FixedTraceReplayStatus, ["consumed", "available"]>>;

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Recursively typed canonical C schema. Unlike a boolean key marker, each
 * leaf binds a concrete runtime kind and every closed literal domain.
 */
export const FIXED_TRACE_SEALED_EVIDENCE_REQUIREMENTS:
  FixedTraceSealedEvidenceRequirementManifest = deepFreeze({
  schemaVersion: fixedTraceEnum<FixedTraceSealedEvidenceSchemaVersion>()(["addie-fixed-trace-sealed-evidence-v1"]),
  plan: {
    protocolFingerprint: { type: "sha256" }, corpusSuiteVersion: { type: "string" }, corpusSuiteSha256: { type: "sha256" },
    partitionManifestSha256: { type: "sha256" }, experimentalDesignFingerprint: { type: "sha256" },
    measurementManifestSha256: { type: "sha256" }, packManifestSha256: { type: "sha256" }, packCustodySignature: { type: "string" },
  },
  assignment: {
    runId: { type: "string" }, phaseId: { type: "string" }, armId: { type: "string" }, architectureId: { type: "string" }, caseId: { type: "string" },
    episodeId: { type: "string" }, clusterId: { type: "string" }, stratumId: { type: "string" }, repetition: { type: "number" }, blockId: { type: "string" },
    order: { type: "number" }, position: { type: "number" }, randomizationSeed: { type: "string" }, scheduleDigest: { type: "sha256" }, workerIdentity: { type: "string" },
  },
  invocation: {
    stage: fixedTraceEnum<FixedTraceInvocationStage>()(["router", "generation", "judge", "simulator"]), invocation: { type: "number" }, attempt: { type: "number" }, requestedProvider: { type: "string" }, requestedModel: { type: "string" },
    requestedEffort: { type: "string" }, returnedProvider: { type: "nullable_string" }, returnedModel: { type: "nullable_string" }, returnedEffort: { type: "nullable_string" },
    identityPolicy: { type: "string" }, fallbackOfAttempt: { type: "nullable_number" },
  },
  requestIntegrity: {
    systemSha256: { type: "sha256" }, promptSha256: { type: "sha256" }, messagesSha256: { type: "sha256" }, toolSchemaSha256: { type: "sha256" },
    providerRequestSha256: { type: "sha256" }, presentedToolNamesSha256: { type: "sha256" }, presentedToolOrderSha256: { type: "sha256" },
    requestFactsSha256: { type: "sha256" }, sourceThreadBindingSha256: { type: "sha256" },
  },
  toolAndSimulatorEvidence: {
    toolCallSha256: { type: "nullable_sha256" }, toolInputSha256: { type: "nullable_sha256" }, toolResultSha256: { type: "nullable_sha256" },
    simulatorReceiptSha256: { type: "nullable_sha256" }, simulatorFaultProvenanceSha256: { type: "nullable_sha256" }, simulatorControlsSha256: { type: "sha256" },
  },
  configuration: {
    architectureSha256: { type: "sha256" }, admissionSha256: { type: "sha256" }, configSha256: { type: "sha256" }, promptConfigSha256: { type: "sha256" },
    softwareSha256: { type: "sha256" }, adapterSha256: { type: "sha256" }, limitsSha256: { type: "sha256" }, retryPolicySha256: { type: "sha256" },
    cachePolicySha256: { type: "sha256" }, samplingPolicySha256: { type: "sha256" },
  },
  timingAndOutcome: {
    preparedAt: { type: "utc_timestamp" }, dispatchedAt: { type: "nullable_utc_timestamp" }, completedAt: { type: "nullable_utc_timestamp" }, latencyMs: { type: "nullable_number" }, timeout: { type: "boolean" },
    errorCode: { type: "nullable_string" }, terminalStatus: fixedTraceEnum<FixedTraceTerminalStatus>()(["complete", "ignored", "reacted", "refusal", "truncated", "empty", "malformed", "provider_error", "timeout_after_dispatch", "unknown_exposure", "not_dispatched_budget", "not_admitted_architecture"]),
    finishReason: fixedTraceNullableEnum<FixedTraceFinishReason>()(["stop", "tool_calls", "length", "refusal", "continue"]), outputSha256: { type: "nullable_sha256" },
  },
  usageAndPricing: {
    usageSha256: { type: "nullable_sha256" }, inputTokens: { type: "nullable_number" }, cachedInputTokens: { type: "nullable_number" }, outputTokens: { type: "nullable_number" },
    pricingCohortId: { type: "string" }, pricingCohortSha256: { type: "sha256" }, pricingEffectiveFrom: { type: "utc_timestamp" },
    pricingEffectiveBefore: { type: "nullable_utc_timestamp" }, computedCostUsd: { type: "nullable_number" }, reservationId: { type: "string" },
    reservationCeilingUsd: { type: "number" }, settlementSha256: { type: "nullable_sha256" },
  },
  denominatorAndSequence: {
    denominatorId: { type: "string" }, failureEvidenceSha256: { type: "sha256" }, missingnessSha256: { type: "sha256" },
    expectedSequenceSha256: { type: "sha256" }, actualSequenceSha256: { type: "sha256" }, completeness: fixedTraceEnum<FixedTraceCompleteness>()(["complete", "incomplete", "unknown_exposure"]), tamperClass: fixedTraceEnum<FixedTraceTamperClass>()(["none", "omission", "insertion", "duplication", "substitution", "reordering"]),
  },
  judgeAndCustody: {
    calibrationDigest: { type: "sha256" }, blindedPresentationSha256: { type: "sha256" }, adjudicationBinding: { type: "sha256" },
    providerExposureLedgerSha256: { type: "sha256" }, custodyBinding: { type: "sha256" }, signerKeyId: { type: "string" }, signature: { type: "string" },
  },
  replayProtection: {
    authorityId: { type: "string" }, nonce: { type: "string" }, oneUseConsumptionSha256: { type: "sha256" }, replayStatus: fixedTraceEnum<FixedTraceReplayStatus>()(["consumed"]),
  },
});

export interface FixedTraceEvidencePrerequisitePin {
  readonly version: string;
  readonly protocolVersion: string;
  readonly corpusSuiteVersion: string;
  readonly corpusSuiteSha256: string;
  readonly partitionManifestSha256: string;
  readonly experimentalDesignFingerprint: string;
  readonly measurement: { readonly version: string; readonly sha256: string };
  readonly authorityDigests: { readonly finalPrerequisitesSha256: string };
  readonly randomization: {
    readonly scheduleDigest: null;
    readonly episodeClusterManifestDigest: null;
  };
  readonly pricingWindow: {
    readonly id: null;
    readonly effectiveFrom: null;
    readonly effectiveBefore: null;
    readonly digest: null;
  };
  readonly calibration: {
    readonly status: "unavailable";
    readonly allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only";
    readonly digest: null;
  };
  readonly providerExposure: { readonly status: "unavailable"; readonly digest: null };
  readonly custody: {
    readonly status: "unavailable";
    readonly custodianIdentity: null;
    readonly packDigest: null;
    readonly signature: null;
    readonly collisionAuditDigest: null;
  };
}

export const FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN: FixedTraceEvidencePrerequisitePin =
  Object.freeze({
    version: "addie-fixed-trace-A-prerequisite-manifest-v3",
    protocolVersion: "addie-fixed-trace-evaluation-protocol-v3",
    corpusSuiteVersion: "addie-fixed-traces-v32",
    corpusSuiteSha256: "5f7f0a6d653a4757991728a1d9de8aee69b40d580dafb65e98941c1f9e3fea83",
    partitionManifestSha256: "99a0727723fd84bcc4c7f40852a0e2392b578964bb4e7b0954739946451e4b96",
    experimentalDesignFingerprint: "23ad5b971ecf8c110283fc3944125c5889cd1083d5402a49dc795889a6fd93d6",
    measurement: Object.freeze({
      version: "addie-fixed-trace-measurement-manifest-v1",
      sha256: "c465bc7b5b69f3bf6e8151a5b4ff57d10d630d3f8ddc64c1cce4d504ad80fb5a",
    }),
    authorityDigests: Object.freeze({
      finalPrerequisitesSha256: "fa4755eb1357c6a52bfe59f71b95700dd33d1cce66cee414847c8d14d29a8623",
    }),
    randomization: Object.freeze({ scheduleDigest: null, episodeClusterManifestDigest: null }),
    pricingWindow: Object.freeze({
      id: null, effectiveFrom: null,
      effectiveBefore: null, digest: null,
    }),
    calibration: Object.freeze({
      status: "unavailable", allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only", digest: null,
    }),
    providerExposure: Object.freeze({ status: "unavailable", digest: null }),
    custody: Object.freeze({
      status: "unavailable", custodianIdentity: null, packDigest: null,
      signature: null, collisionAuditDigest: null,
    }),
  });

export type FixedTraceEvidencePrerequisiteDiagnostic =
  | Readonly<{
    status: "ordinary_unavailable";
    code: typeof FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION;
    reason: "A_manifest_is_pinned_but_required_artifacts_are_unavailable";
  }>
  | Readonly<{
    status: "pin_drift";
    code: "fixed_trace_A_prerequisite_pin_drift";
    reason: "manifest_invalid_or_pin_mismatch";
    mismatchedFields: readonly string[];
  }>;

interface ParsedFixedTraceAPrerequisiteManifest {
  readonly version: string;
  readonly protocolVersion: string;
  readonly corpus: { readonly suiteVersion: string; readonly suiteSha256: string };
  readonly partitionManifestSha256: string;
  readonly experimentalDesignFingerprint: string;
  readonly measurement: { readonly version: string; readonly sha256: string };
  readonly authorityDigests: { readonly finalPrerequisitesSha256: string };
  readonly finalPrerequisites: {
    readonly randomization: { readonly scheduleDigest: null; readonly episodeClusterManifestDigest: null };
    readonly pricingWindow: { readonly id: null; readonly effectiveFrom: null; readonly effectiveBefore: null; readonly digest: null };
    readonly calibration: { readonly status: "unavailable"; readonly allowedRelationshipToScoredDevelopment: "separate_or_cross_fitted_only"; readonly digest: null };
    readonly custody: { readonly status: "unavailable"; readonly custodianIdentity: null; readonly packDigest: null; readonly signature: null; readonly collisionAuditDigest: null };
    readonly providerExposure: { readonly status: "unavailable"; readonly digest: null };
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/** The only B parser is private and accepts only a primitive JSON string. */
function parseFixedTraceAPrerequisiteManifest(): ParsedFixedTraceAPrerequisiteManifest | null {
  if (typeof FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON !== "string") return null;
  // This is a canonical serialized authority, not an interchange format:
  // exact bytes reject duplicate fields, whitespace padding, alternate key
  // order, and prototype-pollution encodings before JSON.parse can collapse
  // any of them. Bound the byte length first to cap hostile reload work.
  if (Buffer.byteLength(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON, "utf8")
    > FIXED_TRACE_A_PREREQUISITE_MANIFEST_MAX_BYTES_PIN
    || FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON
      !== FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_JSON
    || fixedTracePrerequisiteSourceSha256(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON)
      !== FIXED_TRACE_A_PREREQUISITE_MANIFEST_CANONICAL_SHA256_PIN) return null;
  try {
    const parsed: unknown = JSON.parse(FIXED_TRACE_A_PREREQUISITE_MANIFEST_JSON);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    if (!exactKeys(root, ["version", "protocolVersion", "corpus", "partitionManifestSha256", "experimentalDesignFingerprint", "measurement", "authorityDigests", "finalPrerequisites"])) return null;
    const corpus = root.corpus;
    const measurement = root.measurement;
    const authorityDigests = root.authorityDigests;
    const final = root.finalPrerequisites;
    if (!corpus || typeof corpus !== "object" || Array.isArray(corpus)
      || !measurement || typeof measurement !== "object" || Array.isArray(measurement)
      || !authorityDigests || typeof authorityDigests !== "object" || Array.isArray(authorityDigests)
      || !final || typeof final !== "object" || Array.isArray(final)
      || !exactKeys(corpus as Record<string, unknown>, ["suiteVersion", "suiteSha256"])
      || !exactKeys(measurement as Record<string, unknown>, ["version", "sha256"])
      || !exactKeys(authorityDigests as Record<string, unknown>, ["finalPrerequisitesSha256"])
      || !exactKeys(final as Record<string, unknown>, ["randomization", "pricingWindow", "calibration", "custody", "providerExposure"])) return null;
    const f = final as Record<string, unknown>;
    const objects = [f.randomization, f.pricingWindow, f.calibration, f.custody, f.providerExposure];
    if (objects.some((value) => !value || typeof value !== "object" || Array.isArray(value))) return null;
    if (!exactKeys(f.randomization as Record<string, unknown>, ["scheduleDigest", "episodeClusterManifestDigest"])
      || !exactKeys(f.pricingWindow as Record<string, unknown>, ["id", "effectiveFrom", "effectiveBefore", "digest"])
      || !exactKeys(f.calibration as Record<string, unknown>, ["status", "allowedRelationshipToScoredDevelopment", "digest"])
      || !exactKeys(f.custody as Record<string, unknown>, ["status", "custodianIdentity", "packDigest", "signature", "collisionAuditDigest"])
      || !exactKeys(f.providerExposure as Record<string, unknown>, ["status", "digest"])) return null;
    return parsed as ParsedFixedTraceAPrerequisiteManifest;
  } catch {
    return null;
  }
}

function mismatchedFields(manifest: ParsedFixedTraceAPrerequisiteManifest): readonly string[] {
  const pin = FIXED_TRACE_EVIDENCE_PREREQUISITE_PIN;
  const final = manifest.finalPrerequisites;
  return Object.freeze([
    ...(manifest.version !== pin.version ? ["version"] : []),
    ...(manifest.protocolVersion !== pin.protocolVersion ? ["protocolVersion"] : []),
    ...(manifest.corpus.suiteVersion !== pin.corpusSuiteVersion ? ["corpus.suiteVersion"] : []),
    ...(manifest.corpus.suiteSha256 !== pin.corpusSuiteSha256 ? ["corpus.suiteSha256"] : []),
    ...(manifest.partitionManifestSha256 !== pin.partitionManifestSha256 ? ["partitionManifestSha256"] : []),
    ...(manifest.experimentalDesignFingerprint !== pin.experimentalDesignFingerprint ? ["experimentalDesignFingerprint"] : []),
    ...(manifest.measurement.version !== pin.measurement.version ? ["measurement.version"] : []),
    ...(manifest.measurement.sha256 !== pin.measurement.sha256 ? ["measurement.sha256"] : []),
    ...(manifest.authorityDigests.finalPrerequisitesSha256 !== pin.authorityDigests.finalPrerequisitesSha256
      ? ["authorityDigests.finalPrerequisitesSha256"] : []),
    ...(final.randomization.scheduleDigest !== pin.randomization.scheduleDigest ? ["finalPrerequisites.randomization.scheduleDigest"] : []),
    ...(final.randomization.episodeClusterManifestDigest !== pin.randomization.episodeClusterManifestDigest ? ["finalPrerequisites.randomization.episodeClusterManifestDigest"] : []),
    ...(final.pricingWindow.id !== pin.pricingWindow.id ? ["finalPrerequisites.pricingWindow.id"] : []),
    ...(final.pricingWindow.effectiveFrom !== pin.pricingWindow.effectiveFrom ? ["finalPrerequisites.pricingWindow.effectiveFrom"] : []),
    ...(final.pricingWindow.effectiveBefore !== pin.pricingWindow.effectiveBefore ? ["finalPrerequisites.pricingWindow.effectiveBefore"] : []),
    ...(final.pricingWindow.digest !== pin.pricingWindow.digest ? ["finalPrerequisites.pricingWindow.digest"] : []),
    ...(final.calibration.status !== pin.calibration.status ? ["finalPrerequisites.calibration.status"] : []),
    ...(final.calibration.allowedRelationshipToScoredDevelopment !== pin.calibration.allowedRelationshipToScoredDevelopment ? ["finalPrerequisites.calibration.allowedRelationshipToScoredDevelopment"] : []),
    ...(final.calibration.digest !== pin.calibration.digest ? ["finalPrerequisites.calibration.digest"] : []),
    ...(final.custody.status !== pin.custody.status ? ["finalPrerequisites.custody.status"] : []),
    ...(final.custody.custodianIdentity !== pin.custody.custodianIdentity ? ["finalPrerequisites.custody.custodianIdentity"] : []),
    ...(final.custody.packDigest !== pin.custody.packDigest ? ["finalPrerequisites.custody.packDigest"] : []),
    ...(final.custody.signature !== pin.custody.signature ? ["finalPrerequisites.custody.signature"] : []),
    ...(final.custody.collisionAuditDigest !== pin.custody.collisionAuditDigest ? ["finalPrerequisites.custody.collisionAuditDigest"] : []),
    ...(final.providerExposure.status !== pin.providerExposure.status ? ["finalPrerequisites.providerExposure.status"] : []),
    ...(final.providerExposure.digest !== pin.providerExposure.digest ? ["finalPrerequisites.providerExposure.digest"] : []),
  ]);
}

/** No caller input: the B boundary always compares its literal pin to A's pure manifest. */
export function fixedTraceEvidencePrerequisiteDiagnostic(): FixedTraceEvidencePrerequisiteDiagnostic {
  const manifest = parseFixedTraceAPrerequisiteManifest();
  if (!manifest) return Object.freeze({
    status: "pin_drift",
    code: "fixed_trace_A_prerequisite_pin_drift",
    reason: "manifest_invalid_or_pin_mismatch",
    mismatchedFields: Object.freeze(["manifest_shape"]),
  });
  const fields = mismatchedFields(manifest);
  if (fields.length > 0) return Object.freeze({
      status: "pin_drift",
      code: "fixed_trace_A_prerequisite_pin_drift",
      reason: "manifest_invalid_or_pin_mismatch",
      mismatchedFields: fields,
  });
  return Object.freeze({
    status: "ordinary_unavailable",
    code: FIXED_TRACE_EVIDENCE_PREREQUISITE_ADMISSION,
    reason: "A_manifest_is_pinned_but_required_artifacts_are_unavailable",
  });
}

class FixedTraceEvidencePrerequisitePinDriftError extends Error {
  readonly status: "pin_drift";
  readonly code: "fixed_trace_A_prerequisite_pin_drift";
  readonly diagnostic: Extract<FixedTraceEvidencePrerequisiteDiagnostic, { status: "pin_drift" }>;

  constructor(diagnostic: Extract<FixedTraceEvidencePrerequisiteDiagnostic, { status: "pin_drift" }>) {
    const snapshot = Object.freeze({
      ...diagnostic,
      mismatchedFields: Object.freeze([...diagnostic.mismatchedFields]),
    });
    super(snapshot.code);
    this.name = "FixedTraceEvidencePrerequisitePinDriftError";
    this.status = "pin_drift";
    this.code = "fixed_trace_A_prerequisite_pin_drift";
    this.diagnostic = snapshot;
    Object.freeze(this);
  }
}

/** Propagate pin drift; ordinary unavailable remains a safe non-dispatch result. */
export function assertFixedTraceEvidencePrerequisitePinned(): Extract<
  FixedTraceEvidencePrerequisiteDiagnostic,
  { status: "ordinary_unavailable" }
> {
  const diagnostic = fixedTraceEvidencePrerequisiteDiagnostic();
  if (diagnostic.status === "pin_drift") {
    throw new FixedTraceEvidencePrerequisitePinDriftError(diagnostic);
  }
  return diagnostic;
}
