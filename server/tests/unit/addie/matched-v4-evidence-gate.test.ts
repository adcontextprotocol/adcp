import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("../../../src/db/client.js", () => ({ getPool }));

import { createAddieMatchedV4PaidAuthority } from "../../../src/addie/eval/matched-v4-private-authority.js";
import { createMatchedV4GcsDurableEvidenceCapabilityForTest } from "../../../src/addie/eval/matched-v4-immutable-artifact-sink.js";
import * as durableEvidenceModule from "../../../src/addie/eval/matched-v4-immutable-artifact-sink.js";

const originalMergeSha = process.env.ADDIE_MATCHED_V4_MERGE_SHA;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  getPool.mockReset();
  fetchSpy.mockRestore();
  if (originalMergeSha === undefined)
    delete process.env.ADDIE_MATCHED_V4_MERGE_SHA;
  else process.env.ADDIE_MATCHED_V4_MERGE_SHA = originalMergeSha;
});

describe("matched-v4 paid evidence gate", () => {
  it("does not publicly export the production durable-evidence issuer", () => {
    expect(durableEvidenceModule).not.toHaveProperty(
      "createMatchedV4SanctionedDurableEvidenceCapability",
    );
  });

  it("rejects a test-issued evidence capability as a caller-supplied authority", async () => {
    const testCapability = createMatchedV4GcsDurableEvidenceCapabilityForTest(
      "matched-v4-test-evidence",
      {
        getMetadata: async () => [{ retentionPolicy: {} }],
        file: () => ({
          save: async () => undefined,
          getMetadata: async () => [{}],
          download: async () => [Buffer.alloc(0)],
        }),
      },
    );
    await expect(
      createAddieMatchedV4PaidAuthority({
        authorizePaidDispatch: true,
        anthropicApiKey: "fixture-anthropic",
        openaiApiKey: "fixture-openai",
        googleApiKey: "fixture-google",
        // The paid factory's closed key set deliberately has no capability slot.
        durableEvidence: testCapability,
      } as any),
    ).rejects.toThrow(/rejects caller-supplied execution inputs/);
    expect(getPool).not.toHaveBeenCalled();
  });

  it("does not open the database or use fetch while no sanctioned evidence sink exists", async () => {
    process.env.ADDIE_MATCHED_V4_MERGE_SHA = "a".repeat(40);

    await expect(
      createAddieMatchedV4PaidAuthority({
        authorizePaidDispatch: true,
        anthropicApiKey: "fixture-anthropic",
        openaiApiKey: "fixture-openai",
        googleApiKey: "fixture-google",
      }),
    ).rejects.toThrow(/paid authority construction refused/);
    expect(getPool).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
