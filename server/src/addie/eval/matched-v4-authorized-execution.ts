/**
 * Explicit operational entrypoint for the post-merge evaluator job.
 *
 * This does not create an admission or accept a selector, receipt, artifact,
 * provider, ledger, or merge SHA from its caller. The sealed factory checks
 * the deployment-supplied ADDIE_MATCHED_V4_MERGE_SHA against the one-use
 * operator-authorized database admission before any provider adapter exists.
 */
import { createAddieMatchedV4PaidAuthority } from "./matched-v4-private-authority.js";

export async function runAuthorizedAddieMatchedV4Execution(
  input: Readonly<{
    anthropicApiKey: string;
    openaiApiKey: string;
    googleApiKey: string;
    stage?: "screening" | "full";
  }>,
): Promise<void> {
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
  if (requestedStage === "screening") return;
  const result = await authority.execute("full");
  if (result.status !== "completed")
    throw new Error(
      `Matched v4 authorized execution refused: ${result.reason}`,
    );
}
