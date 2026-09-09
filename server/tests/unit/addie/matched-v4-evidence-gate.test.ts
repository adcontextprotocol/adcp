import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("../../../src/db/client.js", () => ({ getPool }));

import { createAddieMatchedV4PaidAuthority } from "../../../src/addie/eval/matched-v4-private-authority.js";

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
  it("does not open the database or use fetch while no sanctioned evidence sink exists", async () => {
    process.env.ADDIE_MATCHED_V4_MERGE_SHA = "a".repeat(40);

    await expect(createAddieMatchedV4PaidAuthority({
      authorizePaidDispatch: true,
      anthropicApiKey: "fixture-anthropic",
      openaiApiKey: "fixture-openai",
      googleApiKey: "fixture-google",
    })).rejects.toThrow(/sanctioned immutable artifact sink adapter/);
    expect(getPool).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
