import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/dashboard-agents.html", import.meta.url), "utf8");
const start = source.indexOf("function renderLatestComplianceAttempt");
const end = source.indexOf("function renderAgentsSection", start);
if (start < 0 || end < 0) throw new Error("heartbeat timeout renderer not found");

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char] ?? char);
const context = vm.createContext({ escapeHtml, encodeURIComponent });
vm.runInContext(source.slice(start, end), context);
const renderTimeout = context.renderHeartbeatTimeout as (
  timeout: Record<string, unknown> | null | undefined,
  latestAttempt?: Record<string, unknown> | null,
) => string;
const renderAttempt = context.renderLatestComplianceAttempt as (
  attempt: Record<string, unknown> | null,
  agentUrl: string,
  orgId?: string,
  heartbeatTimeout?: Record<string, unknown> | null,
) => string;

const TIMEOUT_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SUMMARY = "Last heartbeat timed out at 2026-10-01T10:07:00.000Z after 654s of its 600s budget"
  + " (68/74 storyboards completed). 4 heartbeats in a row have timed out."
  + " The published compliance result was not updated.";

describe("dashboard heartbeat timeout state", () => {
  it("renders the server's sentence verbatim rather than re-deriving it", () => {
    const html = renderTimeout({ run_id: TIMEOUT_RUN_ID, summary: SUMMARY });

    expect(html).toContain("Last heartbeat timed out");
    expect(html).toContain(escapeHtml(SUMMARY));
    expect(html).toContain("agent-latest-attempt--incomplete");
  });

  it("stays silent when there is no timed-out heartbeat", () => {
    expect(renderTimeout(null)).toBe("");
    expect(renderTimeout(undefined)).toBe("");
    expect(renderTimeout({ run_id: TIMEOUT_RUN_ID, consecutive: 2 })).toBe("");
  });

  it("escapes the summary instead of trusting the server payload", () => {
    const html = renderTimeout({
      run_id: TIMEOUT_RUN_ID,
      summary: '<img src=x onerror="alert(1)">',
    });

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("folds into the latest-attempt block when both describe the same run", () => {
    const attempt = {
      id: TIMEOUT_RUN_ID,
      tested_at: "2026-10-01T10:07:00Z",
      triggered_by: "heartbeat",
      completeness: "timed_out",
      is_authoritative: false,
      storyboards_completed: 68,
      storyboards_total: 74,
    };
    const timeout = { run_id: TIMEOUT_RUN_ID, summary: SUMMARY };

    const attemptHtml = renderAttempt(attempt, "https://seller.example/mcp", "org_owner_1", timeout);
    expect(attemptHtml).toContain("Latest attempt: Timed out");
    expect(attemptHtml).toContain(escapeHtml(SUMMARY));
    // The diagnostics link the attempt block owns must survive the merge.
    expect(attemptHtml).toContain("View run diagnostics (JSON)");

    // ...and the standalone block must not repeat it underneath.
    expect(renderTimeout(timeout, attempt)).toBe("");
  });

  it("still stands alone when the attempt block is showing a different run", () => {
    const attempt = {
      id: "123e4567-e89b-42d3-a456-426614174099",
      tested_at: "2026-10-02T10:07:00Z",
      completeness: "complete",
      is_authoritative: true,
    };
    const timeout = { run_id: TIMEOUT_RUN_ID, summary: SUMMARY };

    expect(renderAttempt(attempt, "https://seller.example/mcp", undefined, timeout))
      .not.toContain(escapeHtml(SUMMARY));
    expect(renderTimeout(timeout, attempt)).toContain(escapeHtml(SUMMARY));
  });
});
