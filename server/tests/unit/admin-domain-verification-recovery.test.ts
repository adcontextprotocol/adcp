import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOS } from "@workos-inc/node";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  upsertWorkosDomain: vi.fn(),
  setPrimaryDomain: vi.fn(),
  linkContactsByDomain: vi.fn(),
  invalidateMemberContextCache: vi.fn(),
}));

vi.mock("../../src/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client.js")>()),
  getPool: () => ({ query: mocks.query }),
}));

vi.mock("../../src/db/organization-domains-db.js", () => ({
  linkDomain: vi.fn(),
  setPrimaryDomain: mocks.setPrimaryDomain,
  upsertWorkosDomain: mocks.upsertWorkosDomain,
  unlinkDomainAndReselectPrimary: vi.fn(),
}));

vi.mock("../../src/db/contacts-db.js", () => ({
  linkContactsByDomain: mocks.linkContactsByDomain,
}));

vi.mock("../../src/addie/index.js", () => ({
  invalidateMemberContextCache: mocks.invalidateMemberContextCache,
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: "admin_user",
      authWorkosUserId: "credential_admin",
      email: "admin@example.com",
      firstName: "Admin",
      lastName: "User",
    } as typeof req.user;
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  refuseAnyApiKeyOnGlobalAdmin: (req: Request, res: Response) => {
    if (!req.get("x-test-tenant-api-key")) return false;
    res.status(403).json({ error: "global_admin_required" });
    return true;
  },
  requireGlobalAdmin: [
    (req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        id: "admin_user",
        authWorkosUserId: "credential_admin",
        email: "admin@example.com",
        firstName: "Admin",
        lastName: "User",
      } as typeof req.user;
      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      if (req.get("x-test-tenant-api-key")) {
        return res.status(403).json({ error: "global_admin_required" });
      }
      next();
    },
    (_req: Request, _res: Response, next: NextFunction) => next(),
  ],
}));

import { setupDomainRoutes } from "../../src/routes/admin/domains.js";

const ORG_ID = "org_company";
const DOMAIN = "asterio.ai";

function domainEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "domain_asterio",
    domain: DOMAIN,
    state: "pending",
    verificationPrefix: "_workos",
    verificationToken: "dns-token",
    ...overrides,
  };
}

function buildApp(workos: WorkOS) {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  setupDomainRoutes(router, { workos });
  app.use("/api/admin", router);
  return app;
}

function mockWorkos(domains: ReturnType<typeof domainEntry>[]) {
  return {
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: ORG_ID, domains }),
      updateOrganization: vi.fn().mockResolvedValue({ id: ORG_ID, domains }),
    },
    organizationDomains: {
      verifyOrganizationDomain: vi.fn(),
    },
  } as unknown as WorkOS;
}

function mockExistingPendingDomainQueries() {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT name, is_personal")) {
      return { rows: [{ name: "Asterio", is_personal: false }] };
    }
    if (sql.includes("FROM organization_domains od")) {
      return {
        rows: [
          {
            workos_organization_id: ORG_ID,
            verified: false,
            org_name: "Asterio",
            is_personal: false,
          },
        ],
      };
    }
    return { rows: [], rowCount: 1 };
  });
}

function mockOrganizationWithoutDomainQueries() {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT name, is_personal")) {
      return { rows: [{ name: "Asterio", is_personal: false }] };
    }
    if (sql.includes("FROM organization_domains od")) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 1 };
  });
}

function mockDomainOwnedByPersonalOrganization() {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT name, is_personal")) {
      return { rows: [{ name: "Asterio", is_personal: false }] };
    }
    if (sql.includes("FROM organization_domains od")) {
      return {
        rows: [
          {
            workos_organization_id: "org_personal_victim",
            verified: false,
            org_name: "Personal workspace",
            is_personal: true,
          },
        ],
      };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe("admin WorkOS domain verification recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertWorkosDomain.mockResolvedValue(undefined);
    mocks.setPrimaryDomain.mockResolvedValue(undefined);
    mocks.linkContactsByDomain.mockResolvedValue({ contactsLinked: 0 });
  });

  it("surfaces the WorkOS domain ID when a force re-check remains pending", async () => {
    const workos = mockWorkos([domainEntry()]);
    vi.mocked(
      workos.organizationDomains.verifyOrganizationDomain
    ).mockRejectedValue({ status: 422 });

    const response = await request(buildApp(workos))
      .post(`/api/admin/organizations/${ORG_ID}/domains/${DOMAIN}/verify`)
      .send();

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "still_pending",
      workos_domain_id: "domain_asterio",
      verification_token: "dns-token",
    });
  });

  it("requires an attestation before manually overriding a pending domain", async () => {
    mockExistingPendingDomainQueries();
    const workos = mockWorkos([domainEntry()]);

    const response = await request(buildApp(workos))
      .post(
        `/api/admin/organizations/${ORG_ID}/domains/${DOMAIN}/override-verification`
      )
      .send({ is_primary: true });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "verification_attestation_required",
    });
    expect(workos.organizations.updateOrganization).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("registry_audit_log")
      )
    ).toBe(false);
  });

  it("writes immutable attempt and success audits with the acting credential", async () => {
    mockExistingPendingDomainQueries();
    const workos = mockWorkos([
      domainEntry(),
      domainEntry({
        id: "domain_verified",
        domain: "verified.example",
        state: "verified",
      }),
      domainEntry({
        id: "domain_legacy",
        domain: "legacy.example",
        state: "legacy_verified",
      }),
    ]);

    const response = await request(buildApp(workos))
      .post(
        `/api/admin/organizations/${ORG_ID}/domains/${DOMAIN}/override-verification`
      )
      .send({
        is_primary: true,
        verification_attestation:
          "Confirmed the published TXT value with dig from two resolvers.",
      });

    expect(response.status).toBe(200);
    expect(workos.organizations.updateOrganization).toHaveBeenCalledWith({
      organization: ORG_ID,
      domainData: [
        { domain: DOMAIN, state: "verified" },
        { domain: "verified.example", state: "verified" },
        { domain: "legacy.example", state: "verified" },
      ],
    });
    const auditCalls = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO registry_audit_log")
    );
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls.map(([, values]) => values[2])).toEqual([
      "domain_verification_override_attempted",
      "domain_verification_override_succeeded",
    ]);
    for (const [, values] of auditCalls) {
      expect(values[0]).toBe(ORG_ID);
      expect(values[1]).toBe("credential_admin");
      expect(values[3]).toBe(DOMAIN);
      expect(JSON.parse(values[4])).toMatchObject({
        domain: DOMAIN,
        workos_domain_id: "domain_asterio",
        before_state: "pending",
        requested_after_state: "verified",
        verification_attestation:
          "Confirmed the published TXT value with dig from two resolvers.",
        acting_workos_user_id: "credential_admin",
      });
    }
    expect(mocks.upsertWorkosDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        domain: DOMAIN,
        verified: true,
      })
    );
  });

  it("rejects tenant-scoped API keys before the override handler runs", async () => {
    mockExistingPendingDomainQueries();
    const workos = mockWorkos([domainEntry()]);

    const response = await request(buildApp(workos))
      .post(
        `/api/admin/organizations/${ORG_ID}/domains/${DOMAIN}/override-verification`
      )
      .set("x-test-tenant-api-key", "true")
      .send({ verification_attestation: "DNS checked." });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("global_admin_required");
    expect(workos.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("appends a failure audit when WorkOS rejects the override", async () => {
    mockExistingPendingDomainQueries();
    const workos = mockWorkos([domainEntry()]);
    vi.mocked(workos.organizations.updateOrganization).mockRejectedValue(
      new Error("WorkOS unavailable")
    );

    const response = await request(buildApp(workos))
      .post(
        `/api/admin/organizations/${ORG_ID}/domains/${DOMAIN}/override-verification`
      )
      .send({
        verification_attestation: "Confirmed the TXT record independently.",
      });

    expect(response.status).toBe(502);
    const auditCalls = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO registry_audit_log")
    );
    expect(auditCalls.map(([, values]) => values[2])).toEqual([
      "domain_verification_override_attempted",
      "domain_verification_override_failed",
    ]);
    expect(JSON.parse(auditCalls[1][1][4])).toMatchObject({
      outcome: "failed",
      before_state: "pending",
      after_state: "pending",
      error: "WorkOS unavailable",
    });
    expect(mocks.upsertWorkosDomain).not.toHaveBeenCalled();
  });

  it("reconciles local state when a retry finds WorkOS already verified", async () => {
    mockExistingPendingDomainQueries();
    const workos = mockWorkos([domainEntry({ state: "verified" })]);

    const response = await request(buildApp(workos))
      .post(
        `/api/admin/organizations/${ORG_ID}/domains/${DOMAIN}/override-verification`
      )
      .send({
        is_primary: true,
        verification_attestation:
          "Retry after a local synchronization failure.",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      already_verified: true,
      state: "verified",
    });
    expect(workos.organizations.updateOrganization).not.toHaveBeenCalled();
    expect(mocks.upsertWorkosDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        domain: DOMAIN,
        verified: true,
        isPrimary: true,
      })
    );
    const auditCall = mocks.query.mock.calls.find(
      ([, values]) =>
        values?.[2] === "domain_verification_override_reconciled"
    );
    expect(auditCall).toBeDefined();
  });

  it("rejects a public-suffix domain before creating or overriding a challenge", async () => {
    const workos = mockWorkos([]);

    const response = await request(buildApp(workos))
      .post(
        `/api/admin/organizations/${ORG_ID}/domains/co.uk/override-verification`
      )
      .send({ verification_attestation: "DNS checked." });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_domain");
    expect(workos.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("adds a new domain as pending and does not grant domain-linked access", async () => {
    mockOrganizationWithoutDomainQueries();
    const workos = mockWorkos([]);

    const response = await request(buildApp(workos))
      .post(`/api/admin/organizations/${ORG_ID}/domains`)
      .send({ domain: DOMAIN, is_primary: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      domain: DOMAIN,
      verified: false,
      is_primary: false,
      contacts_linked: 0,
    });
    expect(workos.organizations.updateOrganization).toHaveBeenCalledWith({
      organization: ORG_ID,
      domainData: [{ domain: DOMAIN, state: "pending" }],
    });
    expect(mocks.upsertWorkosDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        domain: DOMAIN,
        verified: false,
        isPrimary: false,
      })
    );
    expect(mocks.linkContactsByDomain).not.toHaveBeenCalled();
  });

  it("refuses a tenant key before reassigning a domain from another personal org", async () => {
    mockDomainOwnedByPersonalOrganization();
    const workos = mockWorkos([]);

    const response = await request(buildApp(workos))
      .post(`/api/admin/organizations/${ORG_ID}/domains`)
      .set("x-test-tenant-api-key", "true")
      .send({ domain: DOMAIN });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("global_admin_required");
    expect(workos.organizations.getOrganization).not.toHaveBeenCalled();
    expect(workos.organizations.updateOrganization).not.toHaveBeenCalled();
  });
});
