import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  evaluateCanaryMock,
  recordCanaryDecisionMock,
  getEnforcementWorkosMock,
  legacyMembershipMock,
  joinRequestDatabaseConstructorMock,
  getOrganizationPendingRequestsMock,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= "sk_test_organization_pending_join_requests_canary";
  process.env.WORKOS_CLIENT_ID ||= "client_test_organization_pending_join_requests_canary";
  process.env.WORKOS_COOKIE_PASSWORD ||=
    "test-cookie-password-32chars-min-len-1234";
  return {
    evaluateCanaryMock: vi.fn(),
    recordCanaryDecisionMock: vi.fn(),
    getEnforcementWorkosMock: vi.fn(() => ({ bounded: true })),
    legacyMembershipMock: vi.fn(),
    joinRequestDatabaseConstructorMock: vi.fn(),
    getOrganizationPendingRequestsMock: vi.fn(),
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
    ORGANIZATION_PENDING_JOIN_REQUESTS_READ:
      "organization_pending_join_requests_read",
  },
  evaluateOrganizationAuthorizationCanary: evaluateCanaryMock,
  recordOrganizationAuthorizationCanaryDecision: recordCanaryDecisionMock,
}));

vi.mock("../../src/db/join-request-db.js", () => ({
  JoinRequestDatabase: class {
    constructor() {
      joinRequestDatabaseConstructorMock();
    }

    getOrganizationPendingRequests = getOrganizationPendingRequestsMock;
  },
}));

import { createOrganizationsRouter } from "../../src/routes/organizations.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organizations", createOrganizationsRouter());
  return app;
}

describe("GET organization pending join requests authorization canary", () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ role: "admin" });
    joinRequestDatabaseConstructorMock.mockReset();
    getOrganizationPendingRequestsMock.mockReset().mockResolvedValue([]);
  });

  it("preserves canonical-user authorization and response while disabled", async () => {
    const response = await request(createApp()).get(
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ requests: [] });
    expect(legacyMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_canonical",
      "org_test",
    );
    expect(evaluateCanaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "organization_pending_join_requests_read",
        principal: expect.objectContaining({
          id: "user_canonical",
          authWorkosUserId: "user_authenticated",
        }),
        organizationId: "org_test",
        getWorkos: getEnforcementWorkosMock,
        minimumRole: "admin",
      }),
    );
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
  });

  it("preserves legacy denial without constructing the request reader while disabled", async () => {
    legacyMembershipMock.mockResolvedValueOnce(null);

    const response = await request(createApp()).get(
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Access denied",
      message: "You are not a member of this organization",
    });
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(joinRequestDatabaseConstructorMock).not.toHaveBeenCalled();
    expect(getOrganizationPendingRequestsMock).not.toHaveBeenCalled();
  });

  it("preserves the legacy ordinary-member response without reading requests", async () => {
    legacyMembershipMock.mockResolvedValueOnce({ role: "member" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Insufficient permissions",
      message: "Only admins and owners can view join requests",
    });
    expect(joinRequestDatabaseConstructorMock).not.toHaveBeenCalled();
    expect(getOrganizationPendingRequestsMock).not.toHaveBeenCalled();
  });

  it("uses an authorized exact admin grant without legacy authority", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    getOrganizationPendingRequestsMock.mockResolvedValueOnce([
      {
        id: "request_test",
        workos_user_id: "must_not_be_returned",
        user_email: "applicant@example.test",
        first_name: "Avery",
        last_name: "Sample",
        status: "pending",
        created_at: createdAt,
      },
    ]);
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
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      requests: [
        {
          id: "request_test",
          user_email: "applicant@example.test",
          first_name: "Avery",
          last_name: "Sample",
          status: "pending",
          created_at: createdAt.toISOString(),
        },
      ],
    });
    expect(getOrganizationPendingRequestsMock).toHaveBeenCalledOnce();
    expect(getOrganizationPendingRequestsMock).toHaveBeenCalledWith("org_test");
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_requests_read",
      expect.objectContaining({ enforced: true, status: "authorized" }),
    );
  });

  it("denies an exact credential below the required role without reading requests", async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: "forbidden" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Access denied",
      message: "You are not a member of this organization",
    });
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(joinRequestDatabaseConstructorMock).not.toHaveBeenCalled();
    expect(getOrganizationPendingRequestsMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_requests_read",
      { enforced: true, status: "forbidden" },
    );
  });

  it("denies a linked credential before legacy authority or request reads", async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: "forbidden" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Access denied",
      message: "You are not a member of this organization",
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_requests_read",
      { enforced: true, status: "forbidden" },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(joinRequestDatabaseConstructorMock).not.toHaveBeenCalled();
    expect(getOrganizationPendingRequestsMock).not.toHaveBeenCalled();
  });

  it("returns 503 before downstream reads when authority is unavailable", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["workos"],
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/join-requests",
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Authorization temporarily unavailable",
      message: "Organization access could not be verified. Please retry.",
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_pending_join_requests_read",
      {
        enforced: true,
        status: "unavailable",
        unavailableSources: ["workos"],
      },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(joinRequestDatabaseConstructorMock).not.toHaveBeenCalled();
    expect(getOrganizationPendingRequestsMock).not.toHaveBeenCalled();
  });
});
