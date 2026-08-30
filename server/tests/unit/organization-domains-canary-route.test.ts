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
  process.env.WORKOS_API_KEY ||= "sk_test_organization_domains_canary";
  process.env.WORKOS_CLIENT_ID ||= "client_test_organization_domains_canary";
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
  WorkOS: class {},
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
    ORGANIZATION_DOMAINS_READ: "organization_domains_read",
  },
  evaluateOrganizationAuthorizationCanary: evaluateCanaryMock,
  recordOrganizationAuthorizationCanaryDecision: recordCanaryDecisionMock,
}));

vi.mock("../../src/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client.js")>()),
  getPool: () => ({ query: poolQueryMock }),
}));

import { createOrganizationsRouter } from "../../src/routes/organizations.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organizations", createOrganizationsRouter());
  return app;
}

describe("GET organization domains authorization canary", () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ role: "member" });
    poolQueryMock.mockReset().mockImplementation((sql: string) => {
      if (sql.includes("FROM organization_domains") && sql.includes("SELECT domain")) {
        return Promise.resolve({
          rows: [{ domain: "example.test", verified: true, is_primary: true }],
        });
      }
      if (sql.includes("FROM organizations WHERE")) {
        return Promise.resolve({
          rows: [{
            auto_provision_verified_domain: true,
            auto_provision_brand_hierarchy_children: false,
            auto_provision_hierarchy_enabled_at: null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("preserves the canonical-user authorization path while disabled", async () => {
    const response = await request(createApp()).get(
      "/api/organizations/org_test/domains"
    );

    expect(response.status).toBe(200);
    expect(legacyMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_canonical",
      "org_test"
    );
    expect(evaluateCanaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "organization_domains_read",
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

  it("uses an authorized exact-credential decision without legacy authority", async () => {
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
      "/api/organizations/org_test/domains"
    );

    expect(response.status).toBe(200);
    expect(response.body.domains).toEqual([
      { domain: "example.test", verified: true, is_primary: true },
    ]);
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_domains_read",
      expect.objectContaining({ enforced: true, status: "authorized" })
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
  });

  it("preserves legacy denial without reading domains while disabled", async () => {
    legacyMembershipMock.mockResolvedValueOnce(null);

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domains"
    );

    expect(response.status).toBe(403);
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("denies a linked credential even when the canonical credential is a member", async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: "forbidden" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domains"
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Access denied");
    expect(recordCanaryDecisionMock).toHaveBeenCalledOnce();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_domains_read",
      { enforced: true, status: "forbidden" },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("returns 503 before domain reads when authority is unavailable", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos"],
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/domains"
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Authorization temporarily unavailable");
    expect(recordCanaryDecisionMock).toHaveBeenCalledOnce();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_domains_read",
      {
        enforced: true,
        status: "unavailable",
        unavailableSources: ["workos"],
      },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});
