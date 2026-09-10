/** Provider-neutral durable evidence boundary for the paid matched-v4 run. */
import { createHash } from "node:crypto";

const EVIDENCE_PREFIX = "addie-matched-v4/v1";
/** Bounds a single non-resumable GCS write; client retry totals bound reads. */
const ADDIE_MATCHED_V4_GCS_IO_TIMEOUT_MS = 30_000;
/** One year covers delayed provider billing reconciliation and audit review. */
export const ADDIE_MATCHED_V4_MIN_EVIDENCE_RETENTION_MS =
  365.25 * 24 * 60 * 60 * 1_000;

export interface AddieMatchedV4EvidenceCommitment {
  readonly reservationId: string;
  readonly stage: "screening" | "full";
  readonly selectorFingerprint: string;
  readonly dispatchCap: number;
  readonly mergeSha: string;
  readonly authorityManifestSha256: string;
  readonly evaluationVersion: string;
}
export interface AddieMatchedV4DurableObject {
  readonly bucket: string;
  readonly name: string;
  readonly generation: string;
  readonly sha256: string;
  readonly retentionExpirationTime: string;
}
export interface AddieMatchedV4DurableEvidenceReservation {
  readonly commitment: AddieMatchedV4EvidenceCommitment;
  readonly object: AddieMatchedV4DurableObject;
}
export type AddieMatchedV4TerminalReasonCode =
  | "paired_ci_gate"
  | "dispatch_timeout"
  | "settlement_refused"
  | "intent_refused"
  | "provider_response_invalid"
  | "execution_refused";
const terminalReasonCodes = new Set<AddieMatchedV4TerminalReasonCode>([
  "paired_ci_gate",
  "dispatch_timeout",
  "settlement_refused",
  "intent_refused",
  "provider_response_invalid",
  "execution_refused",
]);
const validTerminalReasonCode = (
  value: unknown,
): value is AddieMatchedV4TerminalReasonCode =>
  typeof value === "string" &&
  terminalReasonCodes.has(value as AddieMatchedV4TerminalReasonCode);
export interface AddieMatchedV4DurableEvidenceCapability {
  reserve(
    commitment: AddieMatchedV4EvidenceCommitment,
  ): Promise<AddieMatchedV4DurableEvidenceReservation>;
  finalize(
    input: Readonly<{
      reservation: AddieMatchedV4DurableEvidenceReservation;
      artifactSha256: string;
      artifactEvidence: object;
    }>,
  ): Promise<AddieMatchedV4DurableObject>;
  recordRefusal(
    input: Readonly<{
      reservation: AddieMatchedV4DurableEvidenceReservation;
      reasonCode: AddieMatchedV4TerminalReasonCode;
      artifactSha256?: string;
      artifactEvidence?: object;
    }>,
  ): Promise<AddieMatchedV4DurableObject>;
}

type GcsObjectMetadata = Readonly<Record<string, unknown>>;
interface GcsFile {
  save(data: Buffer, options: Readonly<Record<string, unknown>>): Promise<void>;
  getMetadata(): Promise<[object, ...unknown[]]>;
  download(): Promise<[Buffer, ...unknown[]]>;
}
interface GcsBucket {
  getMetadata(): Promise<[object, ...unknown[]]>;
  file(name: string, options?: Readonly<{ generation: string }>): GcsFile;
}
class MatchedV4GcsIoDeadlineError extends Error {
  constructor(operation: string) {
    super(`Matched v4 durable evidence I/O timed out while ${operation}`);
    this.name = "MatchedV4GcsIoDeadlineError";
  }
}
/**
 * ServiceOptions.timeout reaches the SDK's HTTP requests. This independent
 * wall-clock guard also bounds credential or stream setup that occurs before
 * the request layer, and gives the authority a deterministic fail-closed
 * outcome if an SDK seam never settles.
 */
function withinGcsDeadline<T>(
  operation: string,
  invoke: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MatchedV4GcsIoDeadlineError(operation)),
      ADDIE_MATCHED_V4_GCS_IO_TIMEOUT_MS,
    );
    try {
      void invoke().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("base64");
const validSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validReservationId = (value: string) => /^mv4_[a-f0-9]{32}$/.test(value);
const validRfc3339 = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const retainedThroughEvidenceHorizon = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) >= Date.now() + ADDIE_MATCHED_V4_MIN_EVIDENCE_RETENTION_MS;
function canonicalJson(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string")
    throw new Error("durable evidence is not serializable");
  return Buffer.from(encoded, "utf8");
}
function assertBucketLock(metadata: GcsObjectMetadata): void {
  const retention = metadata.retentionPolicy as
    Record<string, unknown> | undefined;
  // effectiveTime is when the policy took effect, so a real locked bucket
  // normally reports a historical timestamp. Object retention, by contrast,
  // must still be in the future when a record is accepted.
  if (
    !retention ||
    retention.isLocked !== true ||
    !Number.isSafeInteger(Number(retention.retentionPeriod)) ||
    Number(retention.retentionPeriod) <= 0 ||
    !validRfc3339(retention.effectiveTime)
  )
    throw new Error(
      "Matched v4 durable evidence requires a GCS Bucket Lock retention policy",
    );
}
function verifiedObject(
  bucket: string,
  expectedName: string,
  expectedSha256: string,
  expectedMd5: string,
  metadata: GcsObjectMetadata,
): AddieMatchedV4DurableObject {
  const generation = metadata.generation,
    retentionExpirationTime = metadata.retentionExpirationTime;
  const custom = metadata.metadata as Record<string, unknown> | undefined;
  if (
    metadata.bucket !== bucket ||
    metadata.name !== expectedName ||
    typeof generation !== "string" ||
    !/^[1-9][0-9]*$/.test(generation) ||
    metadata.md5Hash !== expectedMd5 ||
    custom?.evidence_sha256 !== expectedSha256 ||
    !retainedThroughEvidenceHorizon(retentionExpirationTime)
  )
    throw new Error(
      "Matched v4 durable evidence write did not return a retained exact generation",
    );
  return Object.freeze({
    bucket,
    name: expectedName,
    generation,
    sha256: expectedSha256,
    retentionExpirationTime,
  });
}

class GcsBucketLockDurableEvidenceCapability implements AddieMatchedV4DurableEvidenceCapability {
  #bucketChecked = false;
  #reservationStates = new WeakMap<
    AddieMatchedV4DurableEvidenceReservation,
    Readonly<{
      phase: "issued" | "finalizing" | "uncertain" | "consumed";
      terminalIdentity?: string;
    }>
  >();
  #bucketName: string;
  #bucket: GcsBucket;
  constructor(bucketName: string, bucket: GcsBucket) {
    this.#bucketName = bucketName;
    this.#bucket = bucket;
  }
  async #assertBucketLock(): Promise<void> {
    if (this.#bucketChecked) return;
    const [response] = await withinGcsDeadline(
      "reading Bucket Lock metadata",
      () => this.#bucket.getMetadata(),
    );
    assertBucketLock(response as GcsObjectMetadata);
    this.#bucketChecked = true;
  }
  async #write(
    kind: "reservation" | "final",
    name: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<AddieMatchedV4DurableObject> {
    await this.#assertBucketLock();
    const bytes = canonicalJson(payload),
      contentSha256 = sha256(bytes),
      file = this.#bucket.file(name);
    try {
      await withinGcsDeadline("saving immutable evidence", () =>
        file.save(bytes, {
          resumable: false,
          timeout: ADDIE_MATCHED_V4_GCS_IO_TIMEOUT_MS,
          validation: "md5",
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: "application/json; charset=utf-8",
            metadata: { evidence_kind: kind, evidence_sha256: contentSha256 },
          },
        }),
      );
    } catch (error) {
      // A retry may follow a lost response after GCS committed the first
      // conditional create. Only a 412 can be recovered, and it must verify
      // the exact immutable bytes below; every other failure stays closed.
      if ((error as { code?: unknown }).code !== 412) throw error;
    }
    const [response] = await withinGcsDeadline(
      "reading immutable evidence metadata",
      () => file.getMetadata(),
    );
    const metadata = response as GcsObjectMetadata;
    const verified = verifiedObject(
      this.#bucketName,
      name,
      contentSha256,
      md5(bytes),
      metadata,
    );
    // Metadata is mutable even under Bucket Lock. Re-read the exact returned
    // generation and verify its bytes with SHA-256, not metadata alone.
    const generationScopedFile = this.#bucket.file(name, {
      generation: verified.generation,
    });
    const [returnedBytes] = await withinGcsDeadline(
      "reading immutable evidence generation",
      () => generationScopedFile.download(),
    );
    if (
      !Buffer.isBuffer(returnedBytes) ||
      sha256(returnedBytes) !== contentSha256
    )
      throw new Error(
        "Matched v4 durable evidence readback digest does not match its write",
      );
    return verified;
  }
  async reserve(commitment: AddieMatchedV4EvidenceCommitment) {
    if (
      !validReservationId(commitment.reservationId) ||
      (commitment.stage !== "screening" && commitment.stage !== "full") ||
      !validSha256(commitment.selectorFingerprint) ||
      !validSha256(commitment.authorityManifestSha256) ||
      !/^[a-f0-9]{40}$/.test(commitment.mergeSha) ||
      !Number.isSafeInteger(commitment.dispatchCap) ||
      commitment.dispatchCap <= 0
    )
      throw new Error(
        "Matched v4 durable evidence reservation commitment is malformed",
      );
    const object = await this.#write(
      "reservation",
      `${EVIDENCE_PREFIX}/reservations/${commitment.reservationId}.json`,
      Object.freeze({
        kind: "addie_matched_v4_pre_dispatch_reservation",
        version: 1,
        commitment,
      }),
    );
    const reservation = Object.freeze({
      commitment: Object.freeze({ ...commitment }),
      object,
    });
    this.#reservationStates.set(
      reservation,
      Object.freeze({ phase: "issued" }),
    );
    return reservation;
  }
  async #finalizeReservation<T>(
    reservation: AddieMatchedV4DurableEvidenceReservation,
    terminalIdentity: string,
    write: () => Promise<T>,
  ): Promise<T> {
    const current = this.#reservationStates.get(reservation);
    if (
      !current ||
      (current.phase !== "issued" &&
        !(current.phase === "uncertain" &&
          current.terminalIdentity === terminalIdentity)) ||
      (current.terminalIdentity !== undefined &&
        current.terminalIdentity !== terminalIdentity)
    )
      throw new Error(
        "Matched v4 durable final evidence requires the issued reservation's original terminal operation",
      );
    this.#reservationStates.set(
      reservation,
      Object.freeze({ phase: "finalizing", terminalIdentity }),
    );
    try {
      const finalized = await write();
      this.#reservationStates.set(
        reservation,
        Object.freeze({ phase: "consumed", terminalIdentity }),
      );
      return finalized;
    } catch (error) {
      // A normal transient failure returns to issued so a retry can verify a
      // lost conditional-create response through its 412 exact-byte path. A
      // wall-clock expiry is different: its late SDK operation might still
      // commit, so block any competing terminal kind. The same deterministic
      // terminal identity may retry: a late create is then safely reconciled
      // by create-only 412 handling plus exact-byte generation readback.
      this.#reservationStates.set(
        reservation,
        Object.freeze({
          phase:
            error instanceof MatchedV4GcsIoDeadlineError
              ? "uncertain"
              : "issued",
          terminalIdentity,
        }),
      );
      throw error;
    }
  }
  #assertArtifactEvidence(
    reservation: AddieMatchedV4DurableEvidenceReservation,
    artifactSha256: string,
    artifactEvidence: object,
  ): void {
    const evidence = artifactEvidence as Record<string, unknown>;
    if (
      evidence.kind !== "addie_matched_v4_execution_artifact_evidence" ||
      evidence.version !== reservation.commitment.evaluationVersion ||
      evidence.stage !== reservation.commitment.stage ||
      evidence.selectorFingerprint !==
        reservation.commitment.selectorFingerprint ||
      evidence.artifactSha256 !== artifactSha256 ||
      !validSha256(evidence.requestSetSha256)
    )
      throw new Error(
        "Matched v4 durable final evidence does not cross-link the issued reservation",
      );
  }
  async finalize(
    input: Readonly<{
      reservation: AddieMatchedV4DurableEvidenceReservation;
      artifactSha256: string;
      artifactEvidence: object;
    }>,
  ) {
    if (!validSha256(input.artifactSha256))
      throw new Error(
        "Matched v4 durable final evidence commitment is malformed",
      );
    const reservation = input.reservation;
    this.#assertArtifactEvidence(
      reservation,
      input.artifactSha256,
      input.artifactEvidence,
    );
    return this.#finalizeReservation(
      reservation,
      `completed:${input.artifactSha256}`,
      () =>
        this.#write(
          "final",
          `${EVIDENCE_PREFIX}/final/${reservation.commitment.reservationId}-${input.artifactSha256}.json`,
          Object.freeze({
            kind: "addie_matched_v4_final_evidence",
            version: 1,
            reservation: {
              bucket: reservation.object.bucket,
              name: reservation.object.name,
              generation: reservation.object.generation,
              sha256: reservation.object.sha256,
            },
            artifactSha256: input.artifactSha256,
            artifactEvidence: input.artifactEvidence,
            evidenceId: sha256(
              canonicalJson({
                reservation: reservation.object,
                artifactSha256: input.artifactSha256,
              }),
            ),
          }),
        ),
    );
  }
  async recordRefusal(
    input: Readonly<{
      reservation: AddieMatchedV4DurableEvidenceReservation;
      reasonCode: AddieMatchedV4TerminalReasonCode;
      artifactSha256?: string;
      artifactEvidence?: object;
    }>,
  ) {
    if (!validTerminalReasonCode(input.reasonCode))
      throw new Error("Matched v4 durable refusal reason is malformed");
    if (
      (input.artifactSha256 === undefined) !==
      (input.artifactEvidence === undefined)
    )
      throw new Error(
        "Matched v4 durable refusal artifact evidence is incomplete",
      );
    if (input.artifactSha256 && input.artifactEvidence) {
      if (!validSha256(input.artifactSha256))
        throw new Error(
          "Matched v4 durable refusal artifact digest is malformed",
        );
      this.#assertArtifactEvidence(
        input.reservation,
        input.artifactSha256,
        input.artifactEvidence,
      );
    }
    const refusalDigest = sha256(
      canonicalJson({
        reservation: input.reservation.object,
        reasonCode: input.reasonCode,
        artifactSha256: input.artifactSha256 ?? null,
      }),
    );
    return this.#finalizeReservation(
      input.reservation,
      `refused:${refusalDigest}`,
      () =>
        this.#write(
          "final",
          `${EVIDENCE_PREFIX}/final/${input.reservation.commitment.reservationId}-refused-${refusalDigest}.json`,
          Object.freeze({
            kind: "addie_matched_v4_terminal_refusal_evidence",
            version: 1,
            reservation: {
              bucket: input.reservation.object.bucket,
              name: input.reservation.object.name,
              generation: input.reservation.object.generation,
              sha256: input.reservation.object.sha256,
            },
            reasonCode: input.reasonCode,
            ...(input.artifactSha256
              ? {
                  artifactSha256: input.artifactSha256,
                  artifactEvidence: input.artifactEvidence,
                }
              : {}),
            evidenceId: refusalDigest,
          }),
        ),
    );
  }
}
Object.freeze(GcsBucketLockDurableEvidenceCapability.prototype);

/** Test-only structural issuer; the paid authority never accepts its output. */
export function createMatchedV4GcsDurableEvidenceCapabilityForTest(
  bucketName: string,
  bucket: GcsBucket,
): AddieMatchedV4DurableEvidenceCapability {
  const capability = new GcsBucketLockDurableEvidenceCapability(
    bucketName,
    bucket,
  );
  return Object.freeze(capability);
}
