/**
 * Explicit operational entrypoint for the post-merge evaluator job.
 *
 * This does not create an admission or accept a selector, receipt, artifact,
 * provider, ledger, or merge SHA from its caller. The sealed factory checks
 * the deployment-supplied ADDIE_MATCHED_V4_MERGE_SHA against the one-use
 * operator-authorized database admission before any provider adapter exists.
 */
import { createAddieMatchedV4PaidAuthority } from "./matched-v4-private-authority.js";

/** Serializable, non-authorizing evidence suitable for an immutable artifact. */
export interface AddieMatchedV4AuthorizedStageReport {
  readonly stage: "screening" | "full";
  readonly reservationId: string;
  readonly selectorFingerprint: string;
  readonly requestSetSha256: string;
  readonly artifactSha256: string;
  /** Full safe preimage for independently recomputing artifactSha256. */
  readonly artifactEvidence: Readonly<Record<string, unknown>>;
  readonly attemptedProviderDispatches: number;
  readonly completedProviderDispatches: number;
  readonly runtimeWireSurfacesSha256: string;
  readonly cells: ReadonlyArray<Readonly<{
    id: string;
    arm: string;
    provider: string;
    model: string;
    reasoningEffort: string;
    toolSurface: string;
    passed: number;
    total: number;
    passRate: number;
    totalCostUsd: number;
    medianLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalReasoningTokens: number | null;
  }>>;
  readonly pairedCiGate?: ReadonlyArray<Readonly<Record<string, number | string>>>;
}

export interface AddieMatchedV4AuthorizedExecutionReport {
  readonly kind: "addie_matched_v4_authorized_execution_report";
  readonly requestedStage: "screening" | "full";
  readonly stages: readonly AddieMatchedV4AuthorizedStageReport[];
}

function reportStage(result: any): AddieMatchedV4AuthorizedStageReport {
  return Object.freeze({
    stage: result.artifact.stage,
    reservationId: result.reservationId,
    selectorFingerprint: result.artifact.selectorFingerprint,
    requestSetSha256: result.artifact.requestSetSha256,
    artifactSha256: result.artifact.artifactSha256,
    artifactEvidence: result.artifactEvidence,
    attemptedProviderDispatches: result.artifact.attemptedProviderDispatches,
    completedProviderDispatches: result.artifact.completedProviderDispatches,
    runtimeWireSurfacesSha256: result.artifact.runtimeWireSurfacesSha256,
    cells: Object.freeze(result.metrics.map((metric: any) => Object.freeze({
      id: metric.cell.id,
      arm: metric.cell.arm,
      provider: metric.cell.provider,
      model: metric.cell.model,
      reasoningEffort: metric.cell.reasoningEffort,
      toolSurface: metric.cell.toolSurface,
      passed: metric.passed,
      total: metric.total,
      passRate: metric.passRate,
      totalCostUsd: metric.totalCostUsd,
      medianLatencyMs: metric.medianLatencyMs,
      totalInputTokens: metric.totalInputTokens,
      totalOutputTokens: metric.totalOutputTokens,
      totalCacheReadTokens: metric.totalCacheReadTokens,
      totalCacheWriteTokens: metric.totalCacheWriteTokens,
      totalReasoningTokens: metric.totalReasoningTokens,
    }))),
    ...(result.pairedCiGate ? { pairedCiGate: Object.freeze(result.pairedCiGate.map((ci: any) => Object.freeze({ ...ci }))) } : {}),
  });
}

export async function runAuthorizedAddieMatchedV4Execution(
  input: Readonly<{
    anthropicApiKey: string;
    openaiApiKey: string;
    googleApiKey: string;
    stage?: "screening" | "full";
  }>,
): Promise<AddieMatchedV4AuthorizedExecutionReport> {
  const authority = await createAddieMatchedV4PaidAuthority({
    authorizePaidDispatch: true,
    anthropicApiKey: input.anthropicApiKey,
    openaiApiKey: input.openaiApiKey,
    googleApiKey: input.googleApiKey,
  });
  // A full run is an explicit post-screening continuation on the same sealed
  // authority. Promotion is private state, so creating a fresh authority for
  // full would (correctly) fail with screening_required.
  const requestedStage = input.stage ?? "screening";
  const screening = await authority.execute("screening");
  if (screening.status !== "completed")
    throw new Error(
      `Matched v4 authorized screening refused: ${screening.reason}`,
    );
  const stages = [reportStage(screening)];
  if (requestedStage === "screening") {
    return Object.freeze({
      kind: "addie_matched_v4_authorized_execution_report",
      requestedStage,
      stages: Object.freeze(stages),
    });
  }
  const result = await authority.execute("full");
  if (result.status !== "completed")
    throw new Error(
      `Matched v4 authorized execution refused: ${result.reason}`,
    );
  stages.push(reportStage(result));
  return Object.freeze({
    kind: "addie_matched_v4_authorized_execution_report",
    requestedStage,
    stages: Object.freeze(stages),
  });
}
