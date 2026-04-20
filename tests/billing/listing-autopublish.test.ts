import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { mockQuery, mockGetPool } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetPool: vi.fn(),
}));

vi.mock('../../server/src/db/client.js', () => ({
  query: mockQuery,
  getPool: mockGetPool,
}));

import { ensureMemberProfilePublished } from '../../server/src/services/member-profile-autopublish.js';

type Stub = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };

/**
 * Route each query() call through a list of handlers matched by the first
 * SQL keyword that identifies the operation. Makes tests read as a conversation:
 *   "when the helper looks up the profile, return X; when it inserts, return Y".
 */
function setupQuery(stubs: Stub) {
  mockQuery.mockImplementation(async (rawSql: string, params: unknown[]) => {
    // Normalize whitespace so tests can match on SQL prefixes/keywords
    // without worrying about MemberDatabase's multi-line templates.
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    return stubs(sql, params);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureMemberProfilePublished — real behavior against a mocked pg boundary', () => {
  test('creates a new public profile when none exists', async () => {
    const calls: Array<{ op: string; params: unknown[] }> = [];
    setupQuery((sql, params) => {
      if (sql.includes('FROM member_profiles WHERE workos_organization_id')) {
        calls.push({ op: 'select-by-org', params });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM member_profiles WHERE slug')) {
        calls.push({ op: 'slug-check', params });
        return { rows: [] }; // slug available
      }
      if (sql.startsWith('INSERT INTO member_profiles')) {
        calls.push({ op: 'insert', params });
        return {
          rows: [{
            id: 'profile-new',
            workos_organization_id: params[0],
            display_name: params[1],
            slug: params[2],
            is_public: params[19],
          }],
        };
      }
      if (sql.includes('INSERT INTO org_activities')) {
        calls.push({ op: 'activity', params });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_abc',
      orgName: 'Acme Corp',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.action).toBe('created');
    expect(result.slug).toBe('acme-corp');

    const insert = calls.find(c => c.op === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.params[2]).toBe('acme-corp');
    expect(insert!.params[19]).toBe(true); // is_public

    const activity = calls.find(c => c.op === 'activity');
    expect(activity!.params[0]).toBe('org_abc');
    // system actor — NOT the source string (that would misuse logged_by_user_id)
    expect(activity!.params[1]).toBe('system');
  });

  test('publishes an existing unpublished profile', async () => {
    setupQuery((sql, params) => {
      if (sql.includes('FROM member_profiles WHERE workos_organization_id')) {
        return {
          rows: [{
            id: 'profile-456',
            workos_organization_id: 'org_xyz',
            display_name: 'Existing Org',
            slug: 'existing-org',
            is_public: false,
            agents: '[]',
            publishers: '[]',
            brands: '[]',
            data_providers: '[]',
            offerings: [],
            markets: [],
            tags: [],
            metadata: '{}',
          }],
        };
      }
      if (sql.startsWith('UPDATE member_profiles')) {
        expect(params.some(p => p === true)).toBe(true);
        return {
          rows: [{
            id: 'profile-456', workos_organization_id: 'org_xyz', is_public: true,
            slug: 'existing-org', display_name: 'Existing Org',
            agents: '[]', publishers: '[]', brands: '[]', data_providers: '[]',
            offerings: [], markets: [], tags: [], metadata: '{}',
          }],
        };
      }
      if (sql.includes('INSERT INTO org_activities')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_xyz',
      orgName: 'Existing Org',
      source: 'stripe:invoice.paid',
    });

    expect(result.action).toBe('published');
    expect(result.profileId).toBe('profile-456');
  });

  test('is a noop when profile is already public', async () => {
    setupQuery((sql) => {
      if (sql.includes('FROM member_profiles WHERE workos_organization_id')) {
        return {
          rows: [{
            id: 'profile-789', is_public: true,
            workos_organization_id: 'org_qrs', display_name: 'Already Published', slug: 'already',
            agents: '[]', publishers: '[]', brands: '[]', data_providers: '[]',
            offerings: [], markets: [], tags: [], metadata: '{}',
          }],
        };
      }
      throw new Error(`Unexpected query (should not hit DB after noop): ${sql.slice(0, 60)}`);
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_qrs',
      orgName: 'Already',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.action).toBe('noop');
  });

  test('walks suffix 2 → 99 when base slug is taken', async () => {
    const slugsChecked: string[] = [];
    setupQuery((sql, params) => {
      if (sql.includes('FROM member_profiles WHERE workos_organization_id')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM member_profiles WHERE slug')) {
        const slug = params[0] as string;
        slugsChecked.push(slug);
        // Base + -2 taken; -3 available.
        const taken = slug === 'acme' || slug === 'acme-2';
        return { rows: taken ? [{ 1: 1 }] : [] };
      }
      if (sql.startsWith('INSERT INTO member_profiles')) {
        return { rows: [{ id: 'p-3', slug: params[2], is_public: true, agents: '[]', publishers: '[]', brands: '[]', data_providers: '[]', offerings: [], markets: [], tags: [], metadata: '{}' }] };
      }
      if (sql.includes('INSERT INTO org_activities')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected: ${sql.slice(0, 60)}`);
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_dup',
      orgName: 'Acme',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.slug).toBe('acme-3');
    expect(slugsChecked).toEqual(['acme', 'acme-2', 'acme-3']);
  });

  test('falls back to "member" when slugify produces empty string', async () => {
    setupQuery((sql, params) => {
      if (sql.includes('FROM member_profiles WHERE workos_organization_id')) return { rows: [] };
      if (sql.startsWith('SELECT 1 FROM member_profiles WHERE slug')) return { rows: [] };
      if (sql.startsWith('INSERT INTO member_profiles')) {
        expect(params[2]).toBe('member');
        return { rows: [{ id: 'p-m', slug: 'member', agents: '[]', publishers: '[]', brands: '[]', data_providers: '[]', offerings: [], markets: [], tags: [], metadata: '{}' }] };
      }
      if (sql.includes('INSERT INTO org_activities')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected: ${sql.slice(0, 60)}`);
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_empty',
      orgName: '!!!',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.slug).toBe('member');
  });

  test('skips when org name is empty/whitespace', async () => {
    const result = await ensureMemberProfilePublished({
      orgId: 'org_noname',
      orgName: '   ',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no-org-name');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('recovers on concurrent create: unique violation → re-fetch → publish', async () => {
    let selectCall = 0;
    setupQuery((sql) => {
      if (sql.includes('FROM member_profiles WHERE workos_organization_id')) {
        selectCall++;
        if (selectCall === 1) return { rows: [] }; // first lookup: nothing
        // Concurrent webhook won the race and inserted an unpublished profile.
        return {
          rows: [{
            id: 'profile-concurrent', is_public: false,
            workos_organization_id: 'org_race', display_name: 'Race Org', slug: 'race-org',
            agents: '[]', publishers: '[]', brands: '[]', data_providers: '[]',
            offerings: [], markets: [], tags: [], metadata: '{}',
          }],
        };
      }
      if (sql.startsWith('SELECT 1 FROM member_profiles WHERE slug')) return { rows: [] };
      if (sql.startsWith('INSERT INTO member_profiles')) {
        const err: Error & { code?: string } = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      if (sql.startsWith('UPDATE member_profiles')) {
        return {
          rows: [{
            id: 'profile-concurrent', is_public: true,
            workos_organization_id: 'org_race', display_name: 'Race Org', slug: 'race-org',
            agents: '[]', publishers: '[]', brands: '[]', data_providers: '[]',
            offerings: [], markets: [], tags: [], metadata: '{}',
          }],
        };
      }
      if (sql.includes('INSERT INTO org_activities')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected: ${sql.slice(0, 60)}`);
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_race',
      orgName: 'Race Org',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.action).toBe('published');
    expect(result.profileId).toBe('profile-concurrent');
  });
});
