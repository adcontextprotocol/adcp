import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

const provider = vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = 'admin@test.local';
  process.env.DEV_USER_ID = 'user_dev_admin_001';
  process.env.FLY_APP_NAME = 'membership-policy-test';
  process.env.ALLOW_DEV_MODE_IN_PROD = 'true';
  return { calls: vi.fn() };
});
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  userManagement = new Proxy({}, { get: () => provider.calls });
} }));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isWebUserAAOAdmin: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/middleware/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/rate-limit.js')>()),
  invitationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  orgCreationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// HTTPServer supplies the production cookie/CSRF/organization route ordering. Keep unrelated
// route graphs inert so this focused harness does not initialize Addie indexes or agent tenants.
vi.mock('../../src/routes/addie-admin.js', async () => {
  const express = (await import('express')).default;
  return { createAddieAdminRouter: () => ({ pageRouter: express.Router(), apiRouter: express.Router() }) };
});
vi.mock('../../src/routes/addie-chat.js', async () => {
  const express = (await import('express')).default;
  return { createAddieChatRouter: () => ({ pageRouter: express.Router(), apiRouter: express.Router() }), isWebChatReady: () => false };
});
vi.mock('../../src/routes/slack.js', async () => {
  const express = (await import('express')).default;
  return { createSlackRouter: () => ({ aaobotRouter: express.Router(), addieRouter: express.Router() }) };
});
vi.mock('../../src/routes/registry-api.js', async () => {
  const express = (await import('express')).default;
  return { createRegistryApiRouters: () => ({ router: express.Router(), v1AgentsRouter: express.Router(), complianceRefreshQueue: null }) };
});
vi.mock('../../src/training-agent/index.js', async () => {
  const express = (await import('express')).default;
  return { createTrainingAgentRouter: () => express.Router() };
});
vi.mock('../../src/creative-agent/index.js', async () => {
  const express = (await import('express')).default;
  return { createCreativeAgentRouter: () => express.Router() };
});
vi.mock('../../src/addie/index.js', () => ({
  sendAccountLinkedMessage: vi.fn(),
  invalidateMemberContextCache: vi.fn(),
  isAddieBoltReady: () => false,
}));
vi.mock('../../src/addie/jobs/scheduler.js', () => ({
  jobScheduler: { startAll: vi.fn(), stop: vi.fn(), stopAll: vi.fn() },
}));
vi.mock('../../src/addie/jobs/job-definitions.js', () => ({
  registerAllJobs: vi.fn(),
  JOB_NAMES: { GEO_MONITOR: 'geo-monitor', GEO_SNAPSHOT: 'geo-snapshot', GEO_CONTENT_PLANNER: 'geo-content-planner' },
}));
vi.mock('../../src/services/organization-membership-notifications.js', () => ({ notifyMembershipSeats: vi.fn(), notifyMembershipSeatRequest: vi.fn() }));
vi.mock('../../src/slack/org-group-dm.js', () => ({ notifyMemberSeatChanged: vi.fn() }));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { encodeDevSessionCookie, stopAuthTimers } from '../../src/middleware/auth.js';

const org = 'org_membership_dev_policy';
const actor = 'user_dev_admin_001';
const csrf = 'd'.repeat(64);
let pool: Pool;
let joinId: string;
let app: Parameters<typeof request>[0];
beforeAll(async () => {
  pool = initializeDatabase({ connectionString: process.env.DATABASE_URL });
  await runMigrations();
  await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id=$1', [org]);
  await pool.query('DELETE FROM organization_join_requests WHERE workos_organization_id=$1', [org]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id=$1', [org]);
  await pool.query("INSERT INTO organizations (workos_organization_id,name,is_personal) VALUES ($1,'Pinnacle Agency',false)", [org]);
  await pool.query("INSERT INTO users (workos_user_id,email) VALUES ($1,'admin@test.local') ON CONFLICT DO NOTHING", [actor]);
  await pool.query("INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role) VALUES ($1,$2,'om_dev_policy','admin@test.local','owner')", [actor,org]);
  joinId = (await pool.query('INSERT INTO organization_join_requests (workos_user_id,user_email,workos_organization_id) VALUES ($1,$2,$3) RETURNING id', [actor,'admin@test.local',org])).rows[0].id;
  const { HTTPServer } = await import('../../src/http.js');
  app = (new HTTPServer({ backgroundServices: 'refresh-only' }) as unknown as { app: Parameters<typeof request>[0] }).app;
}, 60000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id=$1', [org]);
    await pool.query('DELETE FROM organization_join_requests WHERE workos_organization_id=$1', [org]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id=$1', [org]);
  }
  finally { stopAuthTimers(); await closeDatabase(); }
});

describe('management rejects real dev sessions even with the production override enabled', () => {
  const paths = [
    ['post', '/join-requests/00000000-0000-0000-0000-000000000001/approve'],
    ['post', '/join-requests/00000000-0000-0000-0000-000000000001/reject'],
    ['post', '/domain-users/add'], ['post', '/invitations'],
    ['delete', '/invitations/inv_test'], ['post', '/invitations/inv_test/resend'],
    ['post', '/members/by-email'], ['patch', '/members/om_target'], ['delete', '/members/om_target'],
    ['post', '/seat-requests'], ['post', '/seat-requests/00000000-0000-0000-0000-000000000001/approve'],
    ['post', '/seat-requests/00000000-0000-0000-0000-000000000001/deny'],
  ] as const;
  for (const [method, path] of paths) it(`${method} ${path}: 403 before provider or membership/audit writes`, async () => {
    provider.calls.mockClear();
    const response = await request(app)[method](`/api/organizations/${org}${path}`)
      .set('Cookie', `dev-session=${encodeDevSessionCookie('admin')}; csrf-token=${csrf}`)
      .set('X-Organization-Id', org).set('X-CSRF-Token', csrf).send({ email: 'member@example.test', role: 'owner' });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body).toEqual({ error: 'access_denied' });
    expect(provider.calls).not.toHaveBeenCalled();
    expect((await pool.query('SELECT role FROM organization_memberships WHERE workos_organization_id=$1', [org])).rows).toEqual([{ role: 'owner' }]);
    expect((await pool.query('SELECT id FROM registry_audit_log WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
    expect((await pool.query('SELECT workos_invitation_id FROM invitation_seat_types WHERE workos_organization_id=$1', [org])).rowCount).toBe(0);
  });
  it('denies dev cancellation even for its own pending request', async () => {
    provider.calls.mockClear();
    const response = await request(app).delete(`/api/join-requests/${joinId}`)
      .set('Cookie', `dev-session=${encodeDevSessionCookie('admin')}; csrf-token=${csrf}`)
      .set('X-CSRF-Token', csrf);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'access_denied' });
    expect(provider.calls).not.toHaveBeenCalled();
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id=$1', [joinId])).rows).toEqual([{ status: 'pending' }]);
  });

});
