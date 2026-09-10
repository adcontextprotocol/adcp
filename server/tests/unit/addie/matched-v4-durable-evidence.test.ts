import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMatchedV4GcsDurableEvidenceCapabilityForTest } from "../../../src/addie/eval/matched-v4-immutable-artifact-sink.js";

const commitment = Object.freeze({
  reservationId: `mv4_${"a".repeat(32)}`,
  stage: "screening" as const,
  selectorFingerprint: "b".repeat(64),
  dispatchCap: 403,
  mergeSha: "c".repeat(40),
  authorityManifestSha256: "d".repeat(64),
  evaluationVersion: "addie-matched-v4",
});
const artifactEvidence = Object.freeze({
  kind: "addie_matched_v4_execution_artifact_evidence",
  version: "addie-matched-v4",
  stage: "screening",
  selectorFingerprint: "b".repeat(64),
  requestSetSha256: "f".repeat(64),
  artifactSha256: "e".repeat(64),
});

function lockedBucket(
  overrides: Record<string, unknown> = {},
  retentionExpirationTime = "2030-01-01T00:00:00.000Z",
) {
  const writes: Array<{ name: string; bytes: Buffer; options: any }> = [];
  const fileCalls: Array<{ name: string; options: any }> = [];
  return {
    writes,
    fileCalls,
    async getMetadata() {
      return [
        {
          retentionPolicy: {
            isLocked: true,
            retentionPeriod: "31536000",
            // Policy activation is historical in production; it is not an expiry.
            effectiveTime: "2020-01-01T00:00:00.000Z",
          },
          ...overrides,
        },
      ];
    },
    file(name: string, options?: any) {
      fileCalls.push({ name, options });
      return {
        async save(bytes: Buffer, options: any) {
          writes.push({ name, bytes, options });
        },
        async getMetadata() {
          const written = writes.find((entry) => entry.name === name)!;
          return [
            {
              bucket: "matched-v4-test-evidence",
              name,
              generation: String(writes.indexOf(written) + 1),
              md5Hash: createHash("md5").update(written.bytes).digest("base64"),
              metadata: {
                evidence_sha256: createHash("sha256")
                  .update(written.bytes)
                  .digest("hex"),
              },
              retentionExpirationTime,
            },
          ];
        },
        async download() {
          return [writes.find((entry) => entry.name === name)!.bytes];
        },
      };
    },
  };
}

describe("matched-v4 GCS durable evidence adapter", () => {
  it.each([
    [
      "Bucket Lock metadata",
      (bucket: any) => {
        bucket.getMetadata = () => new Promise(() => undefined);
      },
    ],
    [
      "immutable evidence save",
      (bucket: any) => {
        const file = bucket.file.bind(bucket);
        bucket.file = (name: string, options?: unknown) => ({
          ...file(name, options),
          save: () => new Promise(() => undefined),
        });
      },
    ],
    [
      "immutable evidence metadata",
      (bucket: any) => {
        const file = bucket.file.bind(bucket);
        bucket.file = (name: string, options?: unknown) => ({
          ...file(name, options),
          getMetadata: () => new Promise(() => undefined),
        });
      },
    ],
    [
      "generation-pinned readback",
      (bucket: any) => {
        const file = bucket.file.bind(bucket);
        bucket.file = (name: string, options?: unknown) => ({
          ...file(name, options),
          download: () => new Promise(() => undefined),
        });
      },
    ],
  ])("fails closed when %s never settles", async (_operation, configure) => {
    vi.useFakeTimers();
    try {
      const bucket = lockedBucket();
      configure(bucket);
      const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
        "matched-v4-test-evidence",
        bucket,
      );
      const pending = capability.reserve(commitment).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBeInstanceOf(Error);
      await expect(pending).resolves.toMatchObject({
        message: expect.stringMatching(
          /Matched v4 durable evidence I\/O timed out while/,
        ),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not allow a competing terminal record after finalization times out, but reconciles its original terminal identity", async () => {
    vi.useFakeTimers();
    try {
      const bucket: any = lockedBucket();
      const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
        "matched-v4-test-evidence",
        bucket,
      );
      const reservation = await capability.reserve(commitment);
      const file = bucket.file.bind(bucket);
      bucket.file = (name: string, options?: unknown) =>
        name.includes("/final/")
          ? { ...file(name, options), save: () => new Promise(() => undefined) }
          : file(name, options);
      const pending = capability
        .finalize({
          reservation,
          artifactSha256: "e".repeat(64),
          artifactEvidence,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({
        message: expect.stringMatching(/I\/O timed out while saving/),
      });
      await expect(
        capability.recordRefusal({
          reservation,
          reasonCode: "execution_refused",
        }),
      ).rejects.toThrow(/original terminal operation/);
      // Simulate the original create committing after its caller deadline. A
      // retry of the same deterministic completion is allowed to observe the
      // conditional-create 412 and verify the already-written bytes.
      let committed = false;
      bucket.file = (name: string, options?: unknown) => {
        const recovered = file(name, options);
        if (!name.includes("/final/")) return recovered;
        return {
          ...recovered,
          save: async (bytes: Buffer, saveOptions: unknown) => {
            if (!committed) {
              bucket.writes.push({ name, bytes, options: saveOptions });
              committed = true;
            }
            throw Object.assign(new Error("precondition failed"), {
              code: 412,
            });
          },
        };
      };
      await expect(
        capability.finalize({
          reservation,
          artifactSha256: "e".repeat(64),
          artifactEvidence,
        }),
      ).resolves.toMatchObject({ generation: "2" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves before finalizing with Bucket Lock retention and create-only generations", async () => {
    const bucket = lockedBucket();
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    const reservation = await capability.reserve(commitment);
    const final = await capability.finalize({
      reservation,
      artifactSha256: "e".repeat(64),
      artifactEvidence,
    });

    expect(reservation.object).toMatchObject({
      generation: "1",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(final).toMatchObject({
      generation: "2",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(bucket.writes).toHaveLength(2);
    expect(
      bucket.writes.every(
        (write) =>
          write.options.preconditionOpts.ifGenerationMatch === 0 &&
          write.options.timeout === 30_000,
      ),
    ).toBe(true);
    expect(bucket.fileCalls.filter((call) => call.options?.generation)).toEqual(
      [
        expect.objectContaining({
          name: reservation.object.name,
          options: { generation: reservation.object.generation },
        }),
        expect.objectContaining({
          name: final.name,
          options: { generation: final.generation },
        }),
      ],
    );
    const reservationBody = JSON.parse(
      bucket.writes[0]!.bytes.toString("utf8"),
    );
    const finalBody = JSON.parse(bucket.writes[1]!.bytes.toString("utf8"));
    expect(reservationBody.commitment).toEqual(commitment);
    expect(finalBody.reservation).toMatchObject({
      generation: reservation.object.generation,
      sha256: reservation.object.sha256,
    });
  });

  it("fails closed before writing when the bucket policy is unlocked or lacks retention", async () => {
    const bucket = lockedBucket({
      retentionPolicy: {
        isLocked: false,
        retentionPeriod: "31536000",
        effectiveTime: "2020-01-01T00:00:00.000Z",
      },
    });
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    await expect(capability.reserve(commitment)).rejects.toThrow(
      /Bucket Lock retention policy/,
    );
    expect(bucket.writes).toHaveLength(0);
  });

  it("refuses an invalid stage commitment before it writes", async () => {
    const bucket = lockedBucket();
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    await expect(
      capability.reserve({ ...commitment, stage: "forged" as any }),
    ).rejects.toThrow(/reservation commitment is malformed/);
    expect(bucket.writes).toEqual([]);
  });

  it("fails closed when the written object lacks a future retention expiration", async () => {
    const bucket = lockedBucket();
    const originalFile = bucket.file.bind(bucket);
    bucket.file = (name: string) => {
      const file = originalFile(name);
      return {
        ...file,
        getMetadata: async () => [
          {
            bucket: "matched-v4-test-evidence",
            name,
            generation: "1",
            md5Hash: "wrong",
            metadata: { evidence_sha256: "wrong" },
            retentionExpirationTime: "2020-01-01T00:00:00.000Z",
          },
        ],
      };
    };
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    await expect(capability.reserve(commitment)).rejects.toThrow(
      /retained exact generation/,
    );
  });

  it("refuses a locked bucket object whose remaining retention is too short for reconciliation", async () => {
    const bucket = lockedBucket({}, new Date(Date.now() + 1_000).toISOString());
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    await expect(capability.reserve(commitment)).rejects.toThrow(
      /retained exact generation/,
    );
  });

  it("fails closed if a generation readback does not match the written SHA-256", async () => {
    const bucket = lockedBucket();
    const originalFile = bucket.file.bind(bucket);
    bucket.file = (name: string) => ({
      ...originalFile(name),
      download: async () => [Buffer.from("tampered")],
    });
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    await expect(capability.reserve(commitment)).rejects.toThrow(
      /readback digest/,
    );
  });

  it("cannot be monkey-patched through its reflected prototype", async () => {
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      lockedBucket(),
    );
    const prototype = Object.getPrototypeOf(capability);
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(() =>
      Object.defineProperty(prototype, "finalize", { value: async () => ({}) }),
    ).toThrow();
  });

  it("rejects unissued reservations without consuming the adapter-issued one", async () => {
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      lockedBucket(),
    );
    const reservation = await capability.reserve(commitment);
    await expect(
      capability.finalize({
        reservation: Object.freeze({ ...reservation }),
        artifactSha256: "e".repeat(64),
        artifactEvidence,
      }),
    ).rejects.toThrow(/original terminal operation/);
    await expect(
      capability.finalize({
        reservation,
        artifactSha256: "e".repeat(64),
        artifactEvidence,
      }),
    ).resolves.toMatchObject({ generation: "2" });
  });

  it("rejects a regex-valid terminal reason that is outside the Addie allowlist", async () => {
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      lockedBucket(),
    );
    const reservation = await capability.reserve(commitment);
    await expect(
      capability.recordRefusal({
        reservation,
        reasonCode: "plausible_but_unapproved" as any,
      }),
    ).rejects.toThrow(/refusal reason/);
  });

  it("resets a terminal reservation after a transient write failure so it can retry", async () => {
    const bucket = lockedBucket();
    const originalFile = bucket.file.bind(bucket);
    let failOnce = true;
    bucket.file = (name: string, options?: any) => {
      const file = originalFile(name, options);
      if (!name.includes("/final/") || !failOnce) return file;
      return {
        ...file,
        save: async () => {
          failOnce = false;
          throw Object.assign(new Error("temporary storage failure"), {
            code: 503,
          });
        },
      };
    };
    const capability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      bucket,
    );
    const reservation = await capability.reserve(commitment);
    await expect(
      capability.finalize({
        reservation,
        artifactSha256: "e".repeat(64),
        artifactEvidence,
      }),
    ).rejects.toThrow(/temporary storage failure/);
    await expect(
      capability.finalize({
        reservation,
        artifactSha256: "e".repeat(64),
        artifactEvidence,
      }),
    ).resolves.toMatchObject({ generation: "2" });
  });
});
