import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  evaluateCanaryMock,
  recordCanaryDecisionMock,
  getEnforcementWorkosMock,
  legacyMembershipMock,
  getPendingRequestCountMock,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= "sk_test_organization_pending_count_canary";
  process.env.WORKOS_CLIENT_ID ||= "client_test_organization_pending_count_canary";
  process.env.WORKOS_COOKIE_PASSWORD ||=
    "test-cookie-password-32chars-min-len-1234";
  return {
    evaluateCanaryMock: vi.fn(),
    recordCanaryDecisionMock: vi.fn(),
    getEnforcementWorkosMock: vi.fn(() => ({ bounded: true })),
    legacyMembershipMock: vi.fn(),
    getPendingRequestCountMock: vi.fn(),
  };
});

vi.mock("@workos-inc/node", () => ({ WorkOS: class {} }));

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

vi.mock("../../src/middleware/organization-authorization-canary.js", () => ({
  ORGANIZATION_AUTHORIZATION_BOUNDARIES: {
    ORGANIZATION_ROLES_READ: "organization_roles_read",
    ORGANIZATION_DOMAINS_READ: "organization_domains_read",
    ORGANIZATION_PENDING_JOIN_REQUEST_COUNT_READ:
      "organization_pending_join_request_count_read",
  },
  evaluateOrganizationAuthorizationCanary: evaluateCanaryMock,
  recordOrganizationAuthorizationCanaryDecision: recordCanaryDecisionMock,
}));

vi.mock("../../src/db/join-request-db.js", () => ({
  JoinRequestDatabase: class {
    getPendingRequestCount = getPendingRequestCountMock;
  },
}));

import { createOrganizationsRouter } from "../../src/routes/organizations.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organizations", createOrganizationsRouter());
  return app;
}

describe("GET organization pending join request count authorization canary", () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ role: "admin" });
    getPendingRequestCountMock.mockReset().mockResolvedValue(4);
  });

  it("preserves canonical-user authorization and the count while disabled", async () => {
    const response = await request(createApp()).get(
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 4 });
    expect(legacyMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_canonical",
      "org_test",
    );
    expect(evaluateCanaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "organization_pending_join_request_count_read",
        principal: expect.objectContaining({
          id: "user_canonical",
          authWorkosUserId: "user_authenticated",
        }),
        organizationId: "org_test",
        getWorkos: getEnforcementWorkosMock,
      }),
    );
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
  });

  it("preserves legacy denial without reading the count while disabled", async () => {
    legacyMembershipMock.mockResolvedValueOnce(null);

    const response = await request(createApp()).get(
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(403);
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(getPendingRequestCountMock).not.toHaveBeenCalled();
  });

  it("preserves the legacy ordinary-member response at 200 and zero", async () => {
    legacyMembershipMock.mockResolvedValueOnce({ role: "member" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 0 });
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(getPendingRequestCountMock).not.toHaveBeenCalled();
  });

  it("uses an authorized exact admin grant without legacy authority", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "admin",
        source: "credential_grant",
      },
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 4 });
    expect(getPendingRequestCountMock).toHaveBeenCalledOnce();
    expect(getPendingRequestCountMock).toHaveBeenCalledWith("org_test");
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_request_count_read",
      expect.objectContaining({ enforced: true, status: "authorized" }),
    );
  });

  it("keeps the ordinary exact-member response at 200 and zero", async () => {
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
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 0 });
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(getPendingRequestCountMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledOnce();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_request_count_read",
      expect.objectContaining({ enforced: true, status: "authorized" }),
    );
  });

  it("denies a linked credential before legacy authority or count reads", async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: "forbidden" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Access denied");
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_request_count_read",
      { enforced: true, status: "forbidden" },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(getPendingRequestCountMock).not.toHaveBeenCalled();
  });

  it("returns 503 before downstream reads when authority is unavailable", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos"],
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/pending-count",
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Authorization temporarily unavailable");
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_request_count_read",
      {
        enforced: true,
        status: "unavailable",
        unavailableSources: ["workos"],
      },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(getPendingRequestCountMock).not.toHaveBeenCalled();
  });
});
