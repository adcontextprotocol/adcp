import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("member content deletion UX", () => {
  it("surfaces the server-provided 403 message", () => {
    const html = readFileSync(
      join(process.cwd(), "server/public/admin-content.html"),
      "utf8"
    );
    const deleteHandler = html.match(
      /async function deleteMyContent\(id\) \{[\s\S]*?\n    \}/
    )?.[0];

    expect(deleteHandler).toBeDefined();
    expect(deleteHandler).toContain("res.status === 403");
    expect(deleteHandler).toContain(
      "alert(d.message || 'You do not have permission to delete this content.')"
    );
  });
});
