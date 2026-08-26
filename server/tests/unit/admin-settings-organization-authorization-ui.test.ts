import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../public/admin-settings.html", import.meta.url),
  "utf8",
);

describe("admin organization authorization runtime control", () => {
  it("loads, renders, and saves the fixed roles-read boundary", () => {
    expect(source).toContain("updateOrganizationAuthorizationDisplay();");
    expect(source).toContain("/api/admin/settings/organization-authorization-enforcement");
    expect(source).toContain("boundaries: ['organization_roles_read']");
    expect(source).toContain("Disable here for rollback within five seconds.");
    expect(source).toContain("Runtime gate armed, but environment ceiling is off");
  });
});
