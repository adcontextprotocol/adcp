import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const labHtml = readFileSync(
  new URL("../../public/video-lab.html", import.meta.url),
  "utf8"
);

describe("Tavus session guidance wiring", () => {
  it("describes session guidance without promising a system-prompt override", () => {
    expect(labHtml).toContain('<label for="opt-context">Session guidance</label>');
    expect(labHtml).toContain("Session guidance active");
    expect(labHtml).toContain("Saved in this browser");
    expect(labHtml).toContain("it cannot request actions, grant permissions, or act as confirmation");
    expect(labHtml).not.toContain("appended to Addie's system prompt");
    expect(labHtml).not.toContain("AAO Foundry");
    expect(labHtml).toContain("extraContext: formSettings.extraContext || undefined");
  });
});
