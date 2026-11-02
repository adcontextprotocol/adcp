/**
 * #8322 — `PUT /api/admin/member-profiles/:id` keys `agents[].url` to the
 * registry identity before writing.
 *
 * This handler was the last writer that passed `agents` straight through to
 * `updateProfile`, so an admin edit kept minting unfolded `agents[].url`
 * rows after #8249 made `/mcp` and `/mcp/` one agent. Every identity-keyed
 * reader then missed those rows, and the owner was denied their own agent.
 *
 * The member's registered spelling moves to `declared_url`, because
 * AUTHORIZATION matching against a publisher's adagents.json stays
 * spec-exact (#7829) and must still see the bytes that were registered.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getProfileById: vi.fn(),
  updateProfile: vi.fn(),
  bulkGetCapabilities: vi.fn(),
  insertTypeReclassification: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_admin_agent_url_key';
  process.env.WORKOS_CLIENT_ID = 'client_test_admin_agent_url_key';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-admin-agent-url-key';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    apiKeys = { createValidation: vi.fn() };
  },
}));

vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: {
    checkPlatformBanForApiKey: vi.fn().mockResolvedValue({ banned: false }),
    checkPlatformBan: vi.fn().mockResolvedValue({ banned: false }),
  },
}));

vi.mock('../../src/db/agent-snapshot-db.js', () => ({
  AgentSnapshotDatabase: class {
    bulkGetCapabilities = mocks.bulkGetCapabilities;
  },
}));

vi.mock('../../src/db/type-reclassification-log-db.js', () => ({
  insertTypeReclassification: mocks.insertTypeReclassification,
}));

const { createAdminMemberProfileRouter } = await import('../../src/routes/member-profiles.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/member-profiles', createAdminMemberProfileRouter({
    memberDb: {
      listProfiles: vi.fn(),
      getProfileById: mocks.getProfileById,
      updateProfile: mocks.updateProfile,
    },
    brandDb: {},
    orgDb: {},
    invalidateMemberContextCache: vi.fn(),
  } as any));
  return app;
}

/** The spelling an admin types; the key folds the trailing slash (#7830). */
const SLASH_SPELLING = 'https://admin-writer.example.com/mcp/';
const FOLDED_KEY = 'https://admin-writer.example.com/mcp';

function put(app: express.Express, agents: unknown) {
  return request(app)
    .put('/api/admin/member-profiles/profile_admin_writer')
    .set('Authorization', 'Bearer static-admin-agent-url-key')
    .send({ agents });
}

describe('admin member-profile PUT keys agents[].url (#8322)', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProfileById.mockResolvedValue({
      id: 'profile_admin_writer',
      workos_organization_id: 'org_admin_writer',
      agents: [],
    });
    mocks.updateProfile.mockImplementation((id: string, updates: any) =>
      Promise.resolve({ id, workos_organization_id: 'org_admin_writer', ...updates }));
    // No capability snapshot: resolveAgentTypes keeps a valid declared type.
    mocks.bulkGetCapabilities.mockResolvedValue(new Map());
  });

  it('writes the identity key and preserves the admin spelling in declared_url', async () => {
    const response = await put(app, [{ url: SLASH_SPELLING, type: 'sales' }]);

    expect(response.status).toBe(200);
    expect(mocks.updateProfile).toHaveBeenCalledOnce();
    const written = mocks.updateProfile.mock.calls[0][1].agents;
    expect(written).toEqual([
      expect.objectContaining({ url: FOLDED_KEY, declared_url: SLASH_SPELLING }),
    ]);
  });

  it('omits declared_url when the spelling already is the key', async () => {
    const response = await put(app, [{ url: FOLDED_KEY, type: 'sales' }]);

    expect(response.status).toBe(200);
    const written = mocks.updateProfile.mock.calls[0][1].agents;
    expect(written[0].url).toBe(FOLDED_KEY);
    expect(written[0]).not.toHaveProperty('declared_url');
  });

  it('round-trips a stored declared_url that is another spelling of the same agent', async () => {
    // A GET→edit→PUT of an existing row must not lose the registered
    // spelling, or the next adagents.json match silently changes answer.
    const response = await put(app, [
      { url: FOLDED_KEY, declared_url: SLASH_SPELLING, type: 'sales' },
    ]);

    expect(response.status).toBe(200);
    const written = mocks.updateProfile.mock.calls[0][1].agents;
    expect(written[0]).toEqual(expect.objectContaining({
      url: FOLDED_KEY,
      declared_url: SLASH_SPELLING,
    }));
  });

  it('rejects a declared_url that belongs to a different agent', async () => {
    // `declared_url` is what authorization matching compares against, so an
    // admin write must not be able to borrow another agent's authorization.
    // Rejected rather than silently replaced: a quiet substitution on an
    // authorization-deciding field leaves the admin believing they set it.
    const response = await put(app, [
      { url: SLASH_SPELLING, declared_url: 'https://someone-else.example.com/mcp', type: 'sales' },
    ]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_declared_url');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it('grandfathers an existing entry whose URL the key cannot represent', async () => {
    // This handler is the last-resort repair surface for legacy rows, so a
    // URL already stored unkeyable must not lock an admin out of every other
    // field on the profile.
    // Userinfo is rejected by the key on purpose (it must never derive a
    // registry key from a URL carrying credentials), so this is a row that
    // exists and cannot be keyed.
    const legacy = 'https://user:pass@admin-writer.example.com/legacy';
    mocks.getProfileById.mockResolvedValue({
      id: 'profile_admin_writer',
      workos_organization_id: 'org_admin_writer',
      agents: [{ url: legacy, type: 'sales' }],
    });

    const response = await put(app, [{ url: legacy, type: 'sales' }]);

    expect(response.status).toBe(200);
    const written = mocks.updateProfile.mock.calls[0][1].agents;
    expect(written[0].url).toBe(legacy);
  });

  it('still rejects a NEW entry whose URL the key cannot represent', async () => {
    const response = await put(app, [
      { url: 'https://user:pass@admin-writer.example.com/brand-new', type: 'sales' },
    ]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_agent_url');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects an entry without a string url instead of writing it unkeyed', async () => {
    const response = await put(app, [{ url: SLASH_SPELLING, type: 'sales' }, { type: 'sales' }]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_agent_url');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects a url the registry key cannot represent', async () => {
    const response = await put(app, [{ url: 'ftp://admin-writer.example.com/mcp', type: 'sales' }]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_agent_url');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it('leaves a profile update without agents untouched', async () => {
    const response = await request(app)
      .put('/api/admin/member-profiles/profile_admin_writer')
      .set('Authorization', 'Bearer static-admin-agent-url-key')
      .send({ tagline: 'No agents in this edit' });

    expect(response.status).toBe(200);
    expect(mocks.updateProfile).toHaveBeenCalledWith(
      'profile_admin_writer',
      expect.objectContaining({ tagline: 'No agents in this edit' }),
    );
    expect(mocks.updateProfile.mock.calls[0][1]).not.toHaveProperty('agents');
  });
});

afterAll(() => {
  stopAuthTimers();
});
