import { describe, expect, it, vi } from "vitest";
import { collectWorkOSPages } from "../../src/services/workos-pagination.js";

describe("collectWorkOSPages", () => {
  it("collects every page and follows each after cursor", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        data: ["member-1", "member-2"],
        listMetadata: { after: "cursor-2" },
      })
      .mockResolvedValueOnce({
        data: ["member-3"],
        listMetadata: { after: "cursor-3" },
      })
      .mockResolvedValueOnce({
        data: ["member-4"],
        listMetadata: { after: null },
      });

    await expect(collectWorkOSPages(fetchPage)).resolves.toEqual([
      "member-1",
      "member-2",
      "member-3",
      "member-4",
    ]);
    expect(fetchPage.mock.calls).toEqual([
      [undefined],
      ["cursor-2"],
      ["cursor-3"],
    ]);
  });

  it("returns an empty list for an empty first page", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      data: [],
      listMetadata: {},
    });

    await expect(collectWorkOSPages(fetchPage)).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });
});
