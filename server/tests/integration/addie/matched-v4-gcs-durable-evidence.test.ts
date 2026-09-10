/**
 * Explicit opt-in only: each successful execution creates two retained WORM
 * records and intentionally does not delete them. It never calls a model
 * provider or opens the evaluator database.
 */
import { createHash, randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { describe, expect, it } from "vitest";
import { createMatchedV4GcsDurableEvidenceCapabilityForTest } from "../../../src/addie/eval/matched-v4-immutable-artifact-sink.js";

const enabled = process.env.ADDIE_MATCHED_V4_GCS_INTEGRATION === "true";

describe.skipIf(!enabled)("matched-v4 GCS durable evidence integration", () => {
  it("creates independently retained reservation and final generations", async () => {
    const nonce = createHash("sha256").update(randomUUID()).digest("hex");
    const bucketName = process.env.ADDIE_MATCHED_V4_GCS_EVIDENCE_BUCKET;
    if (!bucketName)
      throw new Error("ADDIE_MATCHED_V4_GCS_EVIDENCE_BUCKET is required");
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      bucketName,
      new Storage().bucket(bucketName),
    );
    const reservation = await capability.reserve({
      reservationId: `mv4_${nonce.slice(0, 32)}`,
      stage: "screening",
      selectorFingerprint: nonce,
      dispatchCap: 1,
      mergeSha: "a".repeat(40),
      authorityManifestSha256: "b".repeat(64),
      evaluationVersion: "integration-only",
    });
    const final = await capability.finalize({
      reservation,
      artifactSha256: createHash("sha256")
        .update(`${nonce}:artifact`)
        .digest("hex"),
      artifactEvidence: {
        kind: "addie_matched_v4_execution_artifact_evidence",
        version: "integration-only",
        stage: "screening",
        selectorFingerprint: nonce,
        requestSetSha256: createHash("sha256")
          .update(`${nonce}:requests`)
          .digest("hex"),
        artifactSha256: createHash("sha256")
          .update(`${nonce}:artifact`)
          .digest("hex"),
      },
    });
    expect(reservation.object.retentionExpirationTime).not.toBeNull();
    expect(final.retentionExpirationTime).not.toBeNull();
    expect(final.name).toContain(reservation.commitment.reservationId);
  });
});
