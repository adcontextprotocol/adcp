import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  evaluateCanaryMock,
  recordCanaryDecisionMock,
  getEnforcementWorkosMock,
  legacyMembershipMock,
  listReferralCodesMock,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= "sk_test_organization_referral_codes_canary";
  process.env.WORKOS_CLIENT_ID ||= "client_test_organization_referral_codes_canary";
  process.env.WORKOS_COOKIE_PASSWORD ||=
    "test-cookie-password-32chars-min-len-1234";
  return {
    evaluateCanaryMock: vi.fn(),
    recordCanaryDecisionMock: vi.fn(),
    getEnforcementWorkosMock: vi.fn(() => ({ bounded: true })),
    legacyMembershipMock: vi.fn(),
    listReferralCodesMock: vi.fn(),
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
    ORGANIZATION_REFERRAL_CODES_READ: "organization_referral_codes_read",
  },
  evaluateOrganizationAuthorizationCanary: evaluateCanaryMock,
  recordOrganizationAuthorizationCanaryDecision: recordCanaryDecisionMock,
}));

vi.mock("../../src/db/referral-codes-db.js", () => ({
  listReferralCodes: listReferralCodesMock,
}));

import { createOrganizationsRouter } from "../../src/routes/organizations.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organizations", createOrganizationsRouter());
  return app;
}

describe("GET organization referral codes authorization canary", () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ role: "member" });
    listReferralCodesMock.mockReset().mockResolvedValue([]);
  });

  it("preserves canonical-user authorization and response while disabled", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    listReferralCodesMock.mockResolvedValueOnce([
      {
        code_id: 7,
        code: "TESTCODE",
        target_company_name: "Example Company",
        discount_percent: 10,
        max_uses: 1,
        used_count: 0,
        code_status: "active",
        expires_at: null,
        code_created_at: createdAt,
        referral_id: null,
      },
    ]);

    const response = await request(createApp()).get(
      "/api/organizations/org_test/referral-codes",
    );

    expect(response.status).toBe(200);
    expect(response.body.referral_codes).toEqual([
      expect.objectContaining({
        code: "TESTCODE",
        status: "active",
        created_at: createdAt.toISOString(),
        referrals: [],
      }),
    ]);
    expect(legacyMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_canonical",
      "org_test",
    );
    expect(evaluateCanaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "organization_referral_codes_read",
        principal: expect.objectContaining({
          id: "user_canonical",
          authWorkosUserId: "user_authenticated",
        }),
        organizationId: "org_test",
        getWorkos: getEnforcementWorkosMock,
        minimumRole: "member",
      }),
    );
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
  });

  it("preserves legacy denial without reading referral data while disabled", async () => {
    legacyMembershipMock.mockResolvedValueOnce(null);

    const response = await request(createApp()).get(
      "/api/organizations/org_test/referral-codes",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "You are not a member of this organization",
    });
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(listReferralCodesMock).not.toHaveBeenCalled();
  });

  it("uses an authorized exact member grant without legacy authority", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "authorized",
      membership: {
        organizationId: "org_test",
        role: "member",
        source: "credential_grant",
      },
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/referral-codes",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ referral_codes: [] });
    expect(listReferralCodesMock).toHaveBeenCalledOnce();
    expect(listReferralCodesMock).toHaveBeenCalledWith("org_test");
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_referral_codes_read",
      expect.objectContaining({ enforced: true, status: "authorized" }),
    );
  });

  it("denies a linked credential before legacy authority or referral reads", async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: "forbidden" });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/referral-codes",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "You are not a member of this organization",
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_referral_codes_read",
      { enforced: true, status: "forbidden" },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(listReferralCodesMock).not.toHaveBeenCalled();
  });

  it("returns 503 before referral reads when authority is unavailable", async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: "unavailable",
      unavailableSources: ["credential_grant"],
    });

    const response = await request(createApp()).get(
      "/api/organizations/org_test/referral-codes",
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Authorization temporarily unavailable",
      message: "Organization access could not be verified. Please retry.",
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      "organization_referral_codes_read",
      {
        enforced: true,
        status: "unavailable",
        unavailableSources: ["credential_grant"],
      },
    );
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(listReferralCodesMock).not.toHaveBeenCalled();
  });
});
