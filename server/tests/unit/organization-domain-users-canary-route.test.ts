import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  evaluateCanaryMock,
  recordCanaryDecisionMock,
  getEnforcementWorkosMock,
  legacyMembershipMock,
  poolQueryMock,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= "sk_test_organization_domain_users_canary";
  process.env.WORKOS_CLIENT_ID ||= "client_test_organization_domain_users_canary";
  process.env.WORKOS_COOKIE_PASSWORD ||=
    "test-cookie-password-32chars-min-len-1234";
  return {
    evaluateCanaryMock: vi.fn(),
    recordCanaryDecisionMock: vi.fn(),
    getEnforcementWorkosMock: vi.fn(() => ({ bounded: true })),
    legacyMembershipMock: vi.fn(),
    poolQueryMock: vi.fn(),
  };
});

vi.mock("@workos-inc/node", () => ({
  WorkOS: class {
    userManagement = {
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
      getUser: vi.fn(),
      listInvitations: vi.fn().mockResolvedValue({ data: [] }),
    };
  },
}));

vi.mock("../../src/middleware/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/middleware/auth.js")>()),
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
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

vi.mock("../../src/db/client.js", () => ({
  getPool: () => ({ query: poolQueryMock }),
  query: vi.fn(),
}));

vi.mock("../../src/middleware/organization-authorization-canary.js", () => ({
  ORGANIZATION_AUTHORIZATION_BOUNDARIES: {
    ORGANIZATION_DOMAIN_USERS_READ: "organization_domain_users_read",
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

describe("GET organization domain users authorization canary", () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ role: "admin" });
    poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  });

  it("preserves legacy admin authorization and the users response while disabled", async () => {
    const response = await request(createApp()).get(
      "/api/organizations/org_test/domain-users",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ users: [] });
    expect(legacyMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_canonical",
      "org_test",
    );
    expect(evaluateCanaryMock).toHaveBeenCalledWith(expect.objectContaining({
      boundary: "organization_domain_users_read",
      principal: expect.objectContaining({
        id: "user_canonical",
        authWorkosUserId: "user_authenticated",
      }),
      organizationId: "org_test",
      getWorkos: getEnforcementWorkosMock,
      minimumRole: "admin",
    }));
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
  });

  it("preserves legacy membership denial before domain-user lookups while disabled", async () => {
    legacyMembershipMock.mockResolvedValueOnce(null);

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domain-users",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Access denied",
      message: "You are not a member of this organization",
    });
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("preserves legacy ordinary-member denial while disabled", async () => {
    legacyMembershipMock.mockResolvedValueOnce({ role: "member" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domain-users",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Insufficient permissions",
      message: "Only admins and owners can view domain users",
    });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner"])("uses an authorized exact %s grant without the legacy resolver", async (role) => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role,
        source: "credential_grant",
      },
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domain-users",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ users: [] });
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_domain_users_read",
      expect.objectContaining({ enforced: true, status: "authorized" }),
    );
    expect(poolQueryMock).toHaveBeenCalledOnce();
  });

  it("denies an ordinary exact member before every domain-user lookup", async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: "forbidden" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domain-users",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Access denied",
      message: "You are not a member of this organization",
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_domain_users_read",
      { enforced: true, status: "forbidden" },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("returns 503 before every domain-user lookup when authority is unavailable", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["credential_grant"],
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domain-users",
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Authorization temporarily unavailable",
      message: "Organization access could not be verified. Please retry.",
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_domain_users_read",
      expect.objectContaining({ enforced: true, status: "unavailable" }),
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});
