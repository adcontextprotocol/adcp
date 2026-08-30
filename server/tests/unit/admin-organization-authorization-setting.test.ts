import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  getSettingMock,
  setSettingMock,
  invalidateCacheMock,
  environmentAllowsBoundaryMock,
} = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  setSettingMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  environmentAllowsBoundaryMock: vi.fn(),
}));

vi.mock("../../src/middleware/auth.js", () => {
  const requireAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: "user_canonical",
      authWorkosUserId: "user_authenticated_admin",
      email: "admin@example.test",
    } as never;
    next();
  };
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  return { requireGlobalAdmin: [requireAuth, pass, pass] };
});

vi.mock("../../src/middleware/organization-authorization-canary.js", () => ({
  ORGANIZATION_AUTHORIZATION_BOUNDARIES: {
    ORGANIZATION_ROLES_READ: "organization_roles_read",
    ORGANIZATION_DOMAINS_READ: "organization_domains_read",
  },
  isOrganizationAuthorizationBoundaryAllowedByEnvironment: environmentAllowsBoundaryMock,
  invalidateOrganizationAuthorizationRuntimeSettingCache: invalidateCacheMock,
}));

vi.mock("../../src/db/system-settings-db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/system-settings-db.js")>()),
  getAllSettings: vi.fn().mockResolvedValue([]),
  getBillingChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getEscalationChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getAdminChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getProspectChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getProspectTriageEnabled: vi.fn().mockResolvedValue(false),
  getErrorChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getEditorialChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getAnnouncementChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  getS2CanonicalFormatsDeltaRelease: vi.fn().mockResolvedValue({}),
  getOrganizationAuthorizationEnforcement: getSettingMock,
  setOrganizationAuthorizationEnforcement: setSettingMock,
}));

import { createAdminSettingsRouter } from "../../src/routes/admin/settings.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/settings", createAdminSettingsRouter());
  return app;
}

describe("organization authorization runtime admin setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue({ enabled: false, boundaries: [] });
    setSettingMock.mockResolvedValue(undefined);
    environmentAllowsBoundaryMock.mockReturnValue(true);
  });

  it.each([
    [{ enabled: "true", boundaries: ["organization_roles_read"] }],
    [{ enabled: true, boundaries: [] }],
    [{ enabled: true, boundaries: ["unknown_boundary"] }],
    [{ enabled: false, boundaries: "organization_roles_read" }],
  ])("rejects malformed or unsupported values %#", async (body) => {
    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send(body);

    expect(response.status).toBe(400);
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it("persists the fixed boundary with exact authenticated-credential audit provenance", async () => {
    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send({
        enabled: true,
        boundaries: ["organization_roles_read", "organization_roles_read"],
      });

    expect(response.status).toBe(200);
    expect(setSettingMock).toHaveBeenCalledWith(
      { enabled: true, boundaries: ["organization_roles_read"] },
      "user_authenticated_admin",
    );
    expect(invalidateCacheMock).toHaveBeenCalledOnce();
    expect(response.body.organization_authorization_enforcement).toEqual({
      enabled: true,
      boundaries: ["organization_roles_read"],
    });
  });

  it("reports the environment ceiling independently for each supported boundary", async () => {
    environmentAllowsBoundaryMock.mockImplementation(
      (boundary: string) => boundary === "organization_domains_read",
    );

    const response = await request(createApp()).get("/api/admin/settings");

    expect(response.status).toBe(200);
    expect(response.body.organization_authorization_environment_ceiling).toEqual({
      boundaries: ["organization_domains_read"],
    });
  });

  it("persists independently selected read boundaries", async () => {
    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send({
        enabled: true,
        boundaries: ["organization_domains_read"],
      });

    expect(response.status).toBe(200);
    expect(setSettingMock).toHaveBeenCalledWith(
      {
        enabled: true,
        boundaries: ["organization_domains_read"],
      },
      "user_authenticated_admin",
    );
  });

  it("rejects a mixed selection when any boundary is outside the environment ceiling", async () => {
    environmentAllowsBoundaryMock.mockImplementation(
      (boundary: string) => boundary === "organization_roles_read",
    );

    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send({
        enabled: true,
        boundaries: ["organization_roles_read", "organization_domains_read"],
      });

    expect(response.status).toBe(409);
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it("allows an audited runtime rollback without removing the staged boundary", async () => {
    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send({ enabled: false, boundaries: ["organization_roles_read"] });

    expect(response.status).toBe(200);
    expect(setSettingMock).toHaveBeenCalledWith(
      { enabled: false, boundaries: ["organization_roles_read"] },
      "user_authenticated_admin",
    );
    expect(invalidateCacheMock).toHaveBeenCalledOnce();
  });

  it("will not arm runtime enforcement before the environment ceiling is staged", async () => {
    environmentAllowsBoundaryMock.mockReturnValue(false);

    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send({ enabled: true, boundaries: ["organization_roles_read"] });

    expect(response.status).toBe(409);
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it("does not invalidate a cache when persistence fails", async () => {
    setSettingMock.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(createApp())
      .put("/api/admin/settings/organization-authorization-enforcement")
      .send({ enabled: false, boundaries: ["organization_roles_read"] });

    expect(response.status).toBe(500);
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });
});
