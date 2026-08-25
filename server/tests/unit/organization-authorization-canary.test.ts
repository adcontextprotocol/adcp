import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveUserOrgAuthorizationMock,
  evaluateUserOrgRoleAuthorizationMock,
} = vi.hoisted(() => ({
  resolveUserOrgAuthorizationMock: vi.fn(),
  evaluateUserOrgRoleAuthorizationMock: vi.fn(),
}));

vi.mock("../../src/utils/resolve-user-org-authorization.js", () => ({
  resolveUserOrgAuthorization: resolveUserOrgAuthorizationMock,
  evaluateUserOrgRoleAuthorization: evaluateUserOrgRoleAuthorizationMock,
}));

import {
  evaluateOrganizationAuthorizationCanary,
  isOrganizationAuthorizationBoundaryEnabled,
  ORGANIZATION_AUTHORIZATION_BOUNDARIES,
} from "../../src/middleware/organization-authorization-canary.js";

const BOUNDARY = ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_ROLES_READ;

describe("organization authorization canary", () => {
  beforeEach(() => {
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED;
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES;
    resolveUserOrgAuthorizationMock.mockReset();
    evaluateUserOrgRoleAuthorizationMock.mockReset();
  });

  afterEach(() => {
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED;
    delete process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES;
  });

  it.each([
    ["both switches absent", undefined, undefined],
    ["global switch off", "false", BOUNDARY],
    ["boundary switch absent", "true", undefined],
    ["different boundary selected", "true", "another_boundary"],
  ])("does no authority work when %s", async (_label, globalSwitch, boundaries) => {
    if (globalSwitch !== undefined) {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = globalSwitch;
    }
    if (boundaries !== undefined) {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = boundaries;
    }
    const getWorkos = vi.fn();

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: BOUNDARY,
      principal: {
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      },
      organizationId: "org_test",
      getWorkos,
    });

    expect(decision).toEqual({ enforced: false });
    expect(getWorkos).not.toHaveBeenCalled();
    expect(resolveUserOrgAuthorizationMock).not.toHaveBeenCalled();
  });

  it("requires the global switch and the exact fixed boundary", () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    expect(isOrganizationAuthorizationBoundaryEnabled(BOUNDARY)).toBe(false);

    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = "another_boundary";
    expect(isOrganizationAuthorizationBoundaryEnabled(BOUNDARY)).toBe(false);

    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = `another_boundary, ${BOUNDARY}`;
    expect(isOrganizationAuthorizationBoundaryEnabled(BOUNDARY)).toBe(true);

    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "false";
    expect(isOrganizationAuthorizationBoundaryEnabled(BOUNDARY)).toBe(false);
  });

  it.each([
    [
      {
        status: "authorized",
        membership: {
          organizationId: "org_test",
          role: "member",
          source: "workos",
        },
      },
      {
        enforced: true,
        status: "authorized",
        membership: {
          organizationId: "org_test",
          role: "member",
          source: "workos",
        },
      },
    ],
    [{ status: "forbidden" }, { enforced: true, status: "forbidden" }],
    [
      { status: "unavailable", unavailableSources: ["workos"] },
      { enforced: true, status: "unavailable", unavailableSources: ["workos"] },
    ],
  ])(
    "preserves the typed enforcement decision %#",
    async (roleDecision, expected) => {
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
      process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
      const resolution = { status: "authorized" };
      const workos = { userManagement: {} };
      resolveUserOrgAuthorizationMock.mockResolvedValue(resolution);
      evaluateUserOrgRoleAuthorizationMock.mockReturnValue(roleDecision);

      const decision = await evaluateOrganizationAuthorizationCanary({
        boundary: BOUNDARY,
        principal: {
          id: "user_canonical",
          authWorkosUserId: "user_authenticated",
        },
        organizationId: "org_test",
        getWorkos: () => workos as never,
      });

      expect(decision).toEqual(expected);
      expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
        workos,
        { id: "user_canonical", authWorkosUserId: "user_authenticated" },
        "org_test"
      );
    }
  );

  it("represents WorkOS client construction failure as an unavailable source", async () => {
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED = "true";
    process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES = BOUNDARY;
    resolveUserOrgAuthorizationMock.mockResolvedValue({
      status: "unavailable",
      unavailableSources: ["workos"],
    });
    evaluateUserOrgRoleAuthorizationMock.mockReturnValue({
      status: "unavailable",
      unavailableSources: ["workos"],
    });

    const decision = await evaluateOrganizationAuthorizationCanary({
      boundary: BOUNDARY,
      principal: { id: "user_test" },
      organizationId: "org_test",
      getWorkos: () => {
        throw new Error("missing configuration");
      },
    });

    expect(resolveUserOrgAuthorizationMock).toHaveBeenCalledWith(
      null,
      { id: "user_test" },
      "org_test"
    );
    expect(decision).toEqual({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos"],
    });
  });
});
