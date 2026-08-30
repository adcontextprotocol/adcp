import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../../public/admin-settings.html", import.meta.url),
  "utf8",
);

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing section: ${start}`);
  return source.slice(startIndex, endIndex);
}

function loadControls(currentSettings: Record<string, unknown>) {
  const dom = new JSDOM(`
    <div id="currentOrganizationAuthorizationStatus"></div>
    <select id="organizationAuthorizationEnabled">
      <option value="false">off</option>
      <option value="true">on</option>
    </select>
    <input type="checkbox" id="organizationAuthorizationRolesRead">
    <input type="checkbox" id="organizationAuthorizationDomainsRead">
    <button id="saveOrganizationAuthorizationBtn" disabled>Save</button>
  `);
  const fetchMock = vi.fn();
  const showStatusMessage = vi.fn();
  const loadAuditHistory = vi.fn();
  const functions = new Function(
    "document",
    "fetch",
    "showStatusMessage",
    "loadAuditHistory",
    "setTimeout",
    "currentSettings",
    `${section(
      "function updateOrganizationAuthorizationDisplay()",
      "// Status message helpers",
    )}
    return {
      updateOrganizationAuthorizationDisplay,
      saveOrganizationAuthorizationEnforcement,
    };`,
  )(
    dom.window.document,
    fetchMock,
    showStatusMessage,
    loadAuditHistory,
    (callback: () => void) => callback(),
    currentSettings,
  ) as {
    updateOrganizationAuthorizationDisplay: () => void;
    saveOrganizationAuthorizationEnforcement: () => Promise<void>;
  };

  return {
    dom,
    fetchMock,
    showStatusMessage,
    loadAuditHistory,
    ...functions,
  };
}

describe("admin organization authorization runtime control", () => {
  it("renders configured boundaries and disables only unavailable additions", () => {
    const controls = loadControls({
      organization_authorization_enforcement: {
        enabled: true,
        boundaries: ["organization_roles_read"],
      },
      organization_authorization_environment_ceiling: {
        boundaries: ["organization_roles_read"],
      },
    });

    controls.updateOrganizationAuthorizationDisplay();

    const document = controls.dom.window.document;
    expect((document.getElementById("organizationAuthorizationEnabled") as HTMLSelectElement).value)
      .toBe("true");
    expect((document.getElementById("organizationAuthorizationRolesRead") as HTMLInputElement).checked)
      .toBe(true);
    expect((document.getElementById("organizationAuthorizationRolesRead") as HTMLInputElement).disabled)
      .toBe(false);
    expect((document.getElementById("organizationAuthorizationDomainsRead") as HTMLInputElement).checked)
      .toBe(false);
    expect((document.getElementById("organizationAuthorizationDomainsRead") as HTMLInputElement).disabled)
      .toBe(true);
    expect(document.getElementById("currentOrganizationAuthorizationStatus")?.textContent)
      .toContain("roles read");

    controls.dom.window.close();
  });

  it("allows an unstaged configured boundary to be removed during rollback", async () => {
    const currentSettings = {
      organization_authorization_enforcement: {
        enabled: true,
        boundaries: ["organization_roles_read", "organization_domains_read"],
      },
      organization_authorization_environment_ceiling: {
        boundaries: ["organization_roles_read"],
      },
    };
    const controls = loadControls(currentSettings);
    controls.updateOrganizationAuthorizationDisplay();
    const document = controls.dom.window.document;
    const domains = document.getElementById("organizationAuthorizationDomainsRead") as HTMLInputElement;
    expect(domains.checked).toBe(true);
    expect(domains.disabled).toBe(false);
    expect(document.getElementById("currentOrganizationAuthorizationStatus")?.textContent)
      .toContain("authorization active: roles read; blocked by environment ceiling: domains read");
    domains.checked = false;

    controls.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      organization_authorization_enforcement: {
        enabled: true,
        boundaries: ["organization_roles_read"],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await controls.saveOrganizationAuthorizationEnforcement();

    expect(controls.fetchMock).toHaveBeenCalledOnce();
    const [, init] = controls.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      boundaries: ["organization_roles_read"],
    });
    expect(controls.loadAuditHistory).toHaveBeenCalledOnce();

    controls.dom.window.close();
  });

  it("saves a domains-only staged selection independently", async () => {
    const controls = loadControls({
      organization_authorization_enforcement: {
        enabled: false,
        boundaries: [],
      },
      organization_authorization_environment_ceiling: {
        boundaries: ["organization_roles_read", "organization_domains_read"],
      },
    });
    controls.updateOrganizationAuthorizationDisplay();
    const document = controls.dom.window.document;
    (document.getElementById("organizationAuthorizationEnabled") as HTMLSelectElement).value = "true";
    (document.getElementById("organizationAuthorizationDomainsRead") as HTMLInputElement).checked = true;

    controls.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      organization_authorization_enforcement: {
        enabled: true,
        boundaries: ["organization_domains_read"],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await controls.saveOrganizationAuthorizationEnforcement();

    const [, init] = controls.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      boundaries: ["organization_domains_read"],
    });

    controls.dom.window.close();
  });

  it("does not write an enabled setting without a selected boundary", async () => {
    const controls = loadControls({
      organization_authorization_enforcement: { enabled: false, boundaries: [] },
      organization_authorization_environment_ceiling: {
        boundaries: ["organization_roles_read", "organization_domains_read"],
      },
    });
    controls.updateOrganizationAuthorizationDisplay();
    (controls.dom.window.document.getElementById("organizationAuthorizationEnabled") as HTMLSelectElement)
      .value = "true";

    await controls.saveOrganizationAuthorizationEnforcement();

    expect(controls.fetchMock).not.toHaveBeenCalled();
    expect(controls.showStatusMessage).toHaveBeenCalledWith(
      "Select at least one staged authorization boundary",
      "error",
    );

    controls.dom.window.close();
  });
});
