import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, closeDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { setupOrganizationRoutes } from "../../src/routes/admin/organizations.js";
import type { Pool } from "pg";

vi.mock("../../src/middleware/auth.js", async (importOriginal) => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = {
      id: "user_admin_add_users_actor",
      email: "admin@example.test",
      is_admin: true,
    };
    next();
  };
  const requireAdmin = (_req: any, _res: any, next: any) => next();
  const passThrough = (_req: any, _res: any, next: any) => next();

  return {
    ...(await importOriginal<typeof import("../../src/middleware/auth.js")>()),
    requireAuth,
    requireAdmin,
    requireGlobalAdmin: [requireAuth, passThrough, requireAdmin],
  };
});

describe("admin add-users", () => {
  const TARGET_ORG_ID = "org_admin_add_users_target";
  const SOURCE_ORG_ID = "org_admin_add_users_personal";
  const USER_ID = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const MEMBERSHIP_ID = "om_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const EXISTING_MEMBERSHIP_ID = "om_01BRZ3NDEKTSV4RRFFQ69G5FAV";

  let pool: Pool;
  let app: express.Express;
  let createOrganizationMembership: ReturnType<typeof vi.fn>;
  let listOrganizationMemberships: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL ||
        "postgresql://adcp:localdev@localhost:5432/adcp_test",
    });
    await runMigrations();

    createOrganizationMembership = vi.fn();
    listOrganizationMemberships = vi.fn();

    const router = express.Router();
    setupOrganizationRoutes(router, {
      workos: {
        userManagement: {
          createOrganizationMembership,
          listOrganizationMemberships,
        },
      } as any,
    });

    app = express();
    app.use(express.json());
    app.use("/api/admin", router);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    createOrganizationMembership.mockReset().mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: USER_ID,
      organizationId: TARGET_ORG_ID,
      role: { slug: "member" },
      status: "active",
    });
    listOrganizationMemberships.mockReset().mockResolvedValue({ data: [] });

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES
         ($1, 'Target org', false, NOW(), NOW()),
         ($2, 'Personal org', true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         name = EXCLUDED.name,
         is_personal = EXCLUDED.is_personal`,
      [TARGET_ORG_ID, SOURCE_ORG_ID]
    );
    await seedSourceMembership();
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query(
      "DELETE FROM registry_audit_log WHERE workos_organization_id IN ($1, $2)",
      [TARGET_ORG_ID, SOURCE_ORG_ID]
    );
    await pool.query(
      "DELETE FROM invitation_seat_types WHERE workos_organization_id IN ($1, $2)",
      [TARGET_ORG_ID, SOURCE_ORG_ID]
    );
    await pool.query(
      "DELETE FROM organization_memberships WHERE workos_organization_id IN ($1, $2)",
      [TARGET_ORG_ID, SOURCE_ORG_ID]
    );
    await pool.query(
      "DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)",
      [TARGET_ORG_ID, SOURCE_ORG_ID]
    );
  }

  async function seedSourceMembership() {
    await pool.query(
      `INSERT INTO organization_memberships
       (workos_user_id, workos_organization_id, workos_membership_id, email, first_name, last_name, role, seat_type, created_at, updated_at, synced_at)
       VALUES ($1, $2, 'om_source_admin_add_user', 'user@example.test', 'Ada', 'Admin', 'owner', 'community_only', NOW(), NOW(), NOW())`,
      [USER_ID, SOURCE_ORG_ID]
    );
  }

  it("mounts add-users behind the global-admin chain", () => {
    const source = readFileSync(
      new URL("../../src/routes/admin/organizations.ts", import.meta.url),
      "utf8"
    );
    const addUsersRoute = source.match(
      /apiRouter\.post\(\s*"\/organizations\/:orgId\/add-users"[\s\S]*?async \(req, res\)/
    )?.[0];

    expect(addUsersRoute).toContain("...requireGlobalAdmin");
    expect(addUsersRoute).not.toContain("requireAdmin");
  });

  it("mirrors successful WorkOS adds through the shared membership upsert", async () => {
    const response = await request(app)
      .post(`/api/admin/organizations/${TARGET_ORG_ID}/add-users`)
      .send({ user_ids: [USER_ID] })
      .expect(200);

    expect(response.body.added_count).toBe(1);
    expect(createOrganizationMembership).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: TARGET_ORG_ID,
      roleSlug: "member",
    });

    const row = await pool.query<{
      workos_membership_id: string;
      role: string;
      seat_type: string;
      provisioning_source: string | null;
    }>(
      `SELECT workos_membership_id, role, seat_type, provisioning_source
       FROM organization_memberships
       WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [USER_ID, TARGET_ORG_ID]
    );

    expect(row.rows[0]).toMatchObject({
      workos_membership_id: MEMBERSHIP_ID,
      role: "member",
      seat_type: "community_only",
      provisioning_source: "admin_added",
    });
    await expectAuditRow({
      membershipId: MEMBERSHIP_ID,
      repairedExistingMembership: false,
    });
    await expectStagingRows(0);
  });

  it("repairs local drift without inventing admin_added attribution", async () => {
    const alreadyExists = new Error("already exists") as Error & { code: string };
    alreadyExists.code = "organization_membership_already_exists";
    createOrganizationMembership.mockRejectedValueOnce(alreadyExists);
    listOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          id: EXISTING_MEMBERSHIP_ID,
          userId: USER_ID,
          organizationId: TARGET_ORG_ID,
          role: { slug: "admin" },
          status: "active",
        },
      ],
    });

    const response = await request(app)
      .post(`/api/admin/organizations/${TARGET_ORG_ID}/add-users`)
      .send({ user_ids: [USER_ID] })
      .expect(200);

    expect(response.body.added_count).toBe(1);
    expect(listOrganizationMemberships).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: TARGET_ORG_ID,
    });

    const row = await pool.query<{
      workos_membership_id: string;
      role: string;
      provisioning_source: string | null;
    }>(
      `SELECT workos_membership_id, role, provisioning_source
       FROM organization_memberships
       WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [USER_ID, TARGET_ORG_ID]
    );

    expect(row.rows[0]).toMatchObject({
      workos_membership_id: EXISTING_MEMBERSHIP_ID,
      role: "admin",
      provisioning_source: null,
    });
    await expectAuditRow({
      membershipId: EXISTING_MEMBERSHIP_ID,
      repairedExistingMembership: true,
    });
    await expectStagingRows(0);
  });

  it("does not echo raw WorkOS errors to the API response", async () => {
    createOrganizationMembership.mockRejectedValueOnce(
      new Error("User not found: sensitive-workos-detail")
    );

    const response = await request(app)
      .post(`/api/admin/organizations/${TARGET_ORG_ID}/add-users`)
      .send({ user_ids: [USER_ID] })
      .expect(200);

    expect(response.body.added_count).toBe(0);
    expect(response.body.errors).toEqual([
      `User ${USER_ID}: Could not add membership`,
    ]);
    expect(JSON.stringify(response.body)).not.toContain(
      "sensitive-workos-detail"
    );

    const row = await pool.query(
      `SELECT 1
       FROM organization_memberships
       WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [USER_ID, TARGET_ORG_ID]
    );
    expect(row.rowCount).toBe(0);
    await expectStagingRows(0);
  });

  it("rejects malformed WorkOS user ids before calling WorkOS", async () => {
    const response = await request(app)
      .post(`/api/admin/organizations/${TARGET_ORG_ID}/add-users`)
      .send({ user_ids: ["user_does_not_exist"] })
      .expect(200);

    expect(response.body.added_count).toBe(0);
    expect(response.body.errors).toEqual(["Invalid user ID format"]);
    expect(createOrganizationMembership).not.toHaveBeenCalled();
    await expectStagingRows(0);
  });

  async function expectStagingRows(expected: number) {
    const rows = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::int AS count FROM invitation_seat_types WHERE workos_organization_id = $1",
      [TARGET_ORG_ID]
    );
    expect(Number(rows.rows[0].count)).toBe(expected);
  }

  async function expectAuditRow(args: {
    membershipId: string;
    repairedExistingMembership: boolean;
  }) {
    const rows = await pool.query<{
      action: string;
      workos_user_id: string;
      resource_id: string;
      details: {
        target_user_id: string;
        target_email: string;
        via: string;
        repaired_existing_membership: boolean;
      };
    }>(
      `SELECT action, workos_user_id, resource_id, details
       FROM registry_audit_log
       WHERE workos_organization_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [TARGET_ORG_ID]
    );

    expect(rows.rows[0]).toMatchObject({
      action: "member_added",
      workos_user_id: "user_admin_add_users_actor",
      resource_id: args.membershipId,
    });
    expect(rows.rows[0].details).toMatchObject({
      target_user_id: USER_ID,
      target_email: "user@example.test",
      via: "admin_add_users",
      repaired_existing_membership: args.repairedExistingMembership,
    });
  }
});
