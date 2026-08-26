import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  evaluateCanaryMock,
  recordCanaryDecisionMock,
  getEnforcementWorkosMock,
  legacyMembershipMock,
  listOrganizationRolesMock,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= "sk_test_organization_roles_canary";
  process.env.WORKOS_CLIENT_ID ||= "client_test_organization_roles_canary";
  process.env.WORKOS_COOKIE_PASSWORD ||=
    "test-cookie-password-32chars-min-len-1234";
  return {
    evaluateCanaryMock: vi.fn(),
    recordCanaryDecisionMock: vi.fn(),
    getEnforcementWorkosMock: vi.fn(() => ({ bounded: true })),
    legacyMembershipMock: vi.fn(),
    listOrganizationRolesMock: vi.fn(),
  };
});

vi.mock("@workos-inc/node", () => ({
  WorkOS: class {
    authorization = { listOrganizationRoles: listOrganizationRolesMock };
  },
}));

vi.mock("../../src/middleware/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/middleware/auth.js")>()),
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = {
      id: "user_canonical",
      authWorkosUserId: "user_authenticated",
      email: "linked@example.test",
      emailVerified: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    next();
  },
}));

vi.mock("../../src/auth/workos-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auth/workos-client.js")>()),
  getAuthorizationEnforcementWorkos: getEnforcementWorkosMock,
}));

vi.mock("../../src/utils/resolve-user-org-membership.js", () => ({
  resolveUserOrgMembership: legacyMembershipMock,
}));

vi.mock("../../src/middleware/organization-authorization-canary.js", () => ({
  ORGANIZATION_AUTHORIZATION_BOUNDARIES: {
    ORGANIZATION_ROLES_READ: "organization_roles_read",
  },
  evaluateOrganizationAuthorizationCanary: evaluateCanaryMock,
  recordOrganizationAuthorizationCanaryDecision: recordCanaryDecisionMock,
}));

import { createOrganizationsRouter } from "../../src/routes/organizations.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organizations", createOrganizationsRouter());
  return app;
}

describe("GET organization roles authorization canary", () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ role: "member" });
    listOrganizationRolesMock.mockReset().mockResolvedValue({
      data: [
        {
          id: "role_member",
          slug: "member",
          name: "Member",
          description: "Standard member access",
          permissions: [],
        },
      ],
    });
  });

  it("preserves the legacy canonical-user path when the kill switch is off", async () => {
    const response = await request(createApp()).get(
      "/api/organizations/org_test/roles"
    );

    expect(response.status).toBe(200);
    expect(legacyMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_canonical",
      "org_test"
    );
    expect(evaluateCanaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "organization_roles_read",
        principal: expect.objectContaining({
          id: "user_canonical",
          authWorkosUserId: "user_authenticated",
        }),
        organizationId: "org_test",
        getWorkos: getEnforcementWorkosMock,
      })
    );
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
  });

  it("uses the exact canary decision without consulting legacy authority", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "workos",
      },
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/roles"
    );

    expect(response.status).toBe(200);
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_roles_read",
      expect.objectContaining({ enforced: true, status: "authorized" })
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(listOrganizationRolesMock).toHaveBeenCalledWith("org_test");
  });

  it("maps exact-credential denial to 403 before reading role data", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "forbidden",
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/roles"
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Access denied");
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(listOrganizationRolesMock).not.toHaveBeenCalled();
  });

  it("maps authority-source failure to 503 rather than 403", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos"],
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/roles"
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Authorization temporarily unavailable");
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(listOrganizationRolesMock).not.toHaveBeenCalled();
  });
});
