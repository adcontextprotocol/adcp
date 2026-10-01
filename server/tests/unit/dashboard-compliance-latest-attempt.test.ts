import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/dashboard-agents.html", import.meta.url), "utf8");
const start = source.indexOf("function renderLatestComplianceAttempt");
const end = source.indexOf("function renderAgentsSection", start);
if (start < 0 || end < 0) throw new Error("latest compliance attempt renderer not found");

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char] ?? char);
const context = vm.createContext({ escapeHtml, encodeURIComponent });
vm.runInContext(source.slice(start, end), context);
const render = context.renderLatestComplianceAttempt as (
  attempt: Record<string, unknown> | null,
  agentUrl: string,
  orgId?: string,
) => string;

describe("dashboard latest compliance attempt", () => {
  it("shows a timed-out run, coverage, blocker, and owner diagnostics without changing the verdict", () => {
    const html = render({
      id: "123e4567-e89b-42d3-a456-426614174000",
      tested_at: "2026-10-01T10:07:00Z",
      triggered_by: "owner_test",
      completeness: "timed_out",
      is_authoritative: false,
      requested_compliance_target: "3.1",
      storyboards_completed: 68,
      storyboards_total: 74,
      first_blocker: "sales_guaranteed: callback unsupported",
    }, "https://seller.example/mcp", "org_owner_1");

    expect(html).toContain("Latest attempt: Timed out");
    expect(html).toContain("68/74 storyboards completed");
    expect(html).toContain("First blocker: sales_guaranteed: callback unsupported");
    expect(html).toContain("This attempt did not update the public result.");
    expect(html).toContain("/compliance/diagnostics?run_id=123e4567-e89b-42d3-a456-426614174000");
    expect(html).toContain("&amp;org=org_owner_1");
    expect(html).toContain("View run diagnostics (JSON)");
  });

  it("escapes owner-visible blockers and does not mark an authoritative run incomplete", () => {
    const html = render({
      id: "123e4567-e89b-42d3-a456-426614174001",
      tested_at: "2026-10-01T10:07:00Z",
      completeness: "complete",
      is_authoritative: true,
      first_blocker: '<img src=x onerror="alert(1)">',
    }, "https://seller.example/mcp");

    expect(html).toContain("Latest attempt: Complete");
    expect(html).not.toContain("agent-latest-attempt--incomplete");
    expect(html).not.toContain("This attempt did not update the public result.");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(render(null, "https://seller.example/mcp")).toBe("");
  });
});
