import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const dashboardSource = readFileSync(
  new URL("../../public/dashboard-agents.html", import.meta.url),
  "utf8"
);

const helperStart = dashboardSource.indexOf(
  "function buildAgentRefreshSummary"
);
const helperEnd = dashboardSource.indexOf(
  "// Recheck registry snapshot for one agent",
  helperStart
);
if (helperStart < 0 || helperEnd < 0) {
  throw new Error("agent refresh helpers not found");
}

function loadRefreshHelpers(overrides: Record<string, unknown> = {}) {
  const context = vm.createContext({
    fetchAgentState: vi.fn(),
    pageState: { orgId: "org_test", complianceMap: new Map() },
    swapAgentCard: vi.fn(),
    ...overrides,
  });
  vm.runInContext(dashboardSource.slice(helperStart, helperEnd), context);
  return context;
}

function loadRefreshClickHandler(options: {
  responseData: Record<string, unknown>;
  responseStatus?: number;
  reloadAgentCardAfterRefresh?: ReturnType<typeof vi.fn>;
  setTimeout?: ReturnType<typeof vi.fn>;
}) {
  const handlerStart = dashboardSource.indexOf(
    "document.addEventListener('click', async function(e)",
    helperEnd
  );
  const handlerEnd = dashboardSource.indexOf(
    "// Requeue agent for next compliance heartbeat",
    handlerStart
  );
  if (handlerStart < 0 || handlerEnd < 0) {
    throw new Error("agent refresh click handler not found");
  }

  let clickHandler: ((event: unknown) => Promise<void>) | undefined;
  const oldParent = { querySelector: vi.fn(() => null), appendChild: vi.fn() };
  const newParent = { querySelector: vi.fn(() => null), appendChild: vi.fn() };
  const oldActionsRow = { parentElement: oldParent };
  const newActionsRow = { parentElement: newParent };
  const button = {
    dataset: { agentUrl: "https://seller.example/mcp", cardId: "agent-card" },
    textContent: "Recheck & retest",
    title: "Recheck",
    disabled: false,
    closest: vi.fn(() => oldActionsRow),
  };
  const reloadAgentCardAfterRefresh =
    options.reloadAgentCardAfterRefresh ?? vi.fn().mockResolvedValue(undefined);
  const setTimeout = options.setTimeout ?? vi.fn();
  const fetch = vi.fn().mockResolvedValue({
    status: options.responseStatus ?? 200,
    headers: { get: vi.fn(() => null) },
    json: vi.fn().mockResolvedValue(options.responseData),
  });
  const document = {
    addEventListener: vi.fn(
      (_event: string, handler: (event: unknown) => Promise<void>) => {
        clickHandler = handler;
      }
    ),
    createElement: vi.fn(() => ({
      className: "",
      style: { cssText: "", background: "", color: "" },
      textContent: "",
      remove: vi.fn(),
    })),
    getElementById: vi.fn(() => ({
      querySelector: vi.fn(() => newActionsRow),
    })),
  };
  const context = vm.createContext({
    document,
    fetch,
    pageState: { orgId: "org_test" },
    reloadAgentCardAfterRefresh,
    buildAgentRefreshSummary: vi.fn(() => "refresh summary"),
    isSuccessfulAgentRetest: (data: {
      online?: boolean;
      compliance?: { ran?: boolean };
    }) => data.online === true && data.compliance?.ran === true,
    setTimeout,
  });
  vm.runInContext(dashboardSource.slice(handlerStart, handlerEnd), context);
  if (!clickHandler)
    throw new Error("agent refresh click handler was not registered");

  return {
    click: () => clickHandler!({ target: { closest: () => button } }),
    reloadAgentCardAfterRefresh,
    setTimeout,
    newParent,
    button,
  };
}

describe("dashboard agent refresh", () => {
  it("reports the newly negotiated target and concrete cache after a 3.0 to 3.1 migration", () => {
    const context = loadRefreshHelpers();
    const buildAgentRefreshSummary = context.buildAgentRefreshSummary as (
      data: Record<string, unknown>
    ) => string;

    const summary = buildAgentRefreshSummary({
      online: true,
      tools_count: 7,
      inferred_type: "sales",
      compliance: {
        ran: true,
        requested_compliance_target: "3.1",
        adcp_version: "3.1.4",
        storyboards_passing: 12,
        storyboards_total: 14,
      },
    });

    expect(summary).toContain("Retested against AdCP 3.1 (cache 3.1.4)");
    expect(summary).toContain("compliance: 12/14");
    expect(summary).not.toContain("3.0");
  });

  it("labels timed-out evidence as incomplete and preserves the previous grade", () => {
    const context = loadRefreshHelpers();
    const data = { online: true, compliance: { ran: true, completeness: 'timed_out', is_authoritative: false,
      storyboards_passing: 1, storyboards_total: 2 } };
    expect((context.isSuccessfulAgentRetest as (data: unknown) => boolean)(data)).toBe(false);
    const summary = (context.buildAgentRefreshSummary as (data: unknown) => string)(data);
    expect(summary).toContain('previous grade and badges preserved');
    expect(summary).not.toContain('compliance: 1/2');
  });

  it("stores freshly fetched compliance state and swaps the stale card", async () => {
    const freshState = {
      url: "https://seller.example/mcp",
      compliance: { adcp_version: "3.1.4" },
    };
    const fetchAgentState = vi.fn().mockResolvedValue(freshState);
    const complianceMap = new Map();
    const swapAgentCard = vi.fn();
    const context = loadRefreshHelpers({
      fetchAgentState,
      pageState: { orgId: "org_test", complianceMap },
      swapAgentCard,
    });
    const reloadAgentCardAfterRefresh = context.reloadAgentCardAfterRefresh as (
      agentUrl: string
    ) => Promise<void>;

    await reloadAgentCardAfterRefresh("https://seller.example/mcp");

    expect(fetchAgentState).toHaveBeenCalledWith(
      { url: "https://seller.example/mcp" },
      "org_test"
    );
    expect(complianceMap.get("https://seller.example/mcp")).toBe(freshState);
    expect(swapAgentCard).toHaveBeenCalledWith("https://seller.example/mcp");
  });

  it("keeps online probes with a failed compliance rerun out of the success state", () => {
    const context = loadRefreshHelpers();
    const isSuccessfulAgentRetest = context.isSuccessfulAgentRetest as (
      data: Record<string, unknown>
    ) => boolean;

    expect(
      isSuccessfulAgentRetest({
        online: true,
        compliance: { ran: false, error: "Agent requires OAuth authorization" },
      })
    ).toBe(false);
    expect(
      isSuccessfulAgentRetest({
        online: true,
        compliance: { ran: true },
      })
    ).toBe(true);
    expect(
      isSuccessfulAgentRetest({
        online: false,
        compliance: { ran: true },
      })
    ).toBe(false);
  });

  it("wires a successful refresh response through card replacement before rendering its result", async () => {
    const harness = loadRefreshClickHandler({
      responseData: {
        online: true,
        compliance: {
          ran: true,
          requested_compliance_target: "3.1",
          adcp_version: "3.1.4",
        },
      },
    });

    await harness.click();

    expect(harness.reloadAgentCardAfterRefresh).toHaveBeenCalledWith(
      "https://seller.example/mcp"
    );
    expect(harness.newParent.appendChild).toHaveBeenCalledOnce();
    expect(
      harness.reloadAgentCardAfterRefresh.mock.invocationCallOrder[0]
    ).toBeLessThan(harness.newParent.appendChild.mock.invocationCallOrder[0]);
    expect(harness.setTimeout).toHaveBeenCalledOnce();
  });

  it("keeps an online probe with a failed retest as a persistent warning", async () => {
    const harness = loadRefreshClickHandler({
      responseData: {
        online: true,
        compliance: { ran: false, error: "Agent requires OAuth authorization" },
      },
    });

    await harness.click();

    expect(harness.newParent.appendChild).toHaveBeenCalledOnce();
    const flash = harness.newParent.appendChild.mock.calls[0][0];
    expect(flash.style.background).toBe("var(--color-warning-bg)");
    expect(harness.setTimeout).not.toHaveBeenCalled();
  });

  it("disables recheck for the session when the platform-wide provenance fence responds", async () => {
    const harness = loadRefreshClickHandler({
      responseStatus: 503,
      responseData: {
        code: "refresh_authorization_provenance_required",
        error:
          "Recheck & retest is paused platform-wide until durable requester-authorization provenance is supported.",
        retryable: false,
        alternative_description:
          "Requeue comply is a separate scheduled-heartbeat operation and has no guaranteed start time.",
      },
    });

    await harness.click();

    expect(harness.button.disabled).toBe(true);
    expect(harness.button.textContent).toBe("Recheck paused");
    expect(harness.button.title).toContain("separate scheduled-heartbeat operation");
    expect(harness.button.title).not.toContain('60');
  });

  it('renders the non-retryable pause before a click and keeps requeue semantically separate', () => {
    expect(dashboardSource).toContain('cs?.refresh_availability');
    expect(dashboardSource).toContain('data-refresh-paused="true"');
    expect(dashboardSource).toContain('refreshAvailability.tracking_issue');
    expect(dashboardSource).toContain('This is not a human refresh and has no guaranteed start time.');
    expect(dashboardSource).not.toContain('runs within ~1 hour');
    expect(dashboardSource).not.toContain('next heartbeat cycle (within ~1 hour)');
  });

  it("preserves compliance targets in storyboard catalog requests", () => {
    const helperStart = dashboardSource.indexOf(
      "function storyboardCatalogUrl"
    );
    const helperEnd = dashboardSource.indexOf(
      "// Shared: render the storyboard map into a panel",
      helperStart
    );
    const context = vm.createContext({ encodeURIComponent });
    vm.runInContext(dashboardSource.slice(helperStart, helperEnd), context);
    const storyboardCatalogUrl = context.storyboardCatalogUrl as (
      storyboardId: string,
      suffix: string,
      complianceTarget?: string
    ) => string;

    expect(storyboardCatalogUrl("media_buy_seller/example", "", "3.1")).toBe(
      "/api/storyboards/media_buy_seller%2Fexample?compliance_target=3.1"
    );
    expect(
      storyboardCatalogUrl("media_buy_seller/example", "/first-step", "3.1-rc")
    ).toBe(
      "/api/storyboards/media_buy_seller%2Fexample/first-step?compliance_target=3.1-rc"
    );
    expect(storyboardCatalogUrl("universal/example", "", "")).toBe(
      "/api/storyboards/universal%2Fexample"
    );
    expect(dashboardSource.match(/data-compliance-target=/g)).toHaveLength(4);
    expect(dashboardSource).toContain(
      "statusInfo.requested_compliance_target || activeComplianceTarget"
    );
  });

  it("does not instruct owners to select a target that has no dashboard control", () => {
    expect(dashboardSource).toContain("Recheck &amp; retest");
    expect(dashboardSource).toContain("adcp.supported_versions");
    expect(dashboardSource).not.toContain(
      "Select a compliance target the agent supports"
    );
  });
});
