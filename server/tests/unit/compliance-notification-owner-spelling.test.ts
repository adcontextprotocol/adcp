/**
 * #8321 — notification recipients are resolved through the registry identity
 * key, so an owner whose member profile stores the other spelling of a folded
 * agent URL still gets the DM.
 *
 * The heartbeat hands the notifiers the folded identity key (`/mcp`); the
 * owner profile in these tests holds the trailing-slash spelling (`/mcp/`),
 * which is the shape #8249 preserved and #7830 folded. Matching the raw URL
 * returns no owner at all, so every assertion here fails if the fold is
 * removed from `resolveAgentOwnerUserIds`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  // Read at module load by the notifier, so it must be set before the import.
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_REGISTRY_EDITS';
});

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock('../../src/notifications/notification-service.js', () => ({
  notifyUser: vi.fn(async () => undefined),
}));
vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(async () => undefined),
  isSlackConfigured: () => true,
}));
vi.mock('../../src/db/notification-db.js', () => ({
  NotificationDatabase: class {
    async exists() { return false; }
  },
}));
vi.mock('../../src/db/catalog-events-db.js', () => ({
  CatalogEventsDatabase: class {
    async writeEvent() { return 'event-id'; }
  },
}));
vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    async publishVerificationChangeEventsIfCurrent() { return undefined; }
  },
}));

import {
  notifyComplianceChange,
  notifyComplianceTimeout,
  notifyVerificationChange,
  notifyExtendedOutages,
} from '../../src/notifications/compliance.js';
import { query } from '../../src/db/client.js';
import { notifyUser } from '../../src/notifications/notification-service.js';
import { sendChannelMessage } from '../../src/slack/client.js';

const mockedQuery = vi.mocked(query);
const mockedNotifyUser = vi.mocked(notifyUser);
const mockedSendChannelMessage = vi.mocked(sendChannelMessage);

/** What the heartbeat reports: the folded registry identity key (#7830). */
const FOLDED_URL = 'https://agent.example.com/mcp';
/** What the owner's member profile holds. */
const STORED_SPELLING = 'https://agent.example.com/mcp/';
const OWNER_USER_ID = 'user_owner_8321';

function mockResult<T>(rows: T[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as never;
}

/**
 * Every agent URL a query asked about, across both shapes the notifier uses:
 * JSONB containment payloads (`[{"url": "..."}]`) and a plain `text[]`.
 */
function requestedAgentUrls(params: unknown): string[] {
  if (!Array.isArray(params)) return [];
  const urls: string[] = [];
  for (const param of params) {
    if (Array.isArray(param)) {
      for (const entry of param) if (typeof entry === 'string') urls.push(entry);
      continue;
    }
    if (typeof param !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(param);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const url = (entry as { url?: unknown })?.url;
        if (typeof url === 'string') urls.push(url);
      }
    } catch {
      // Not a JSONB payload; nothing to extract.
    }
  }
  return urls;
}

/**
 * A member profile holding exactly one agent, spelled with the trailing
 * slash, owned by one org member, listed publicly. Any lookup that asks for
 * a different spelling sees nothing — which is the pre-fix behaviour.
 */
function installTrailingSlashOwnerProfile() {
  mockedQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
    const text = String(sql);
    // `some(=== …)` rather than `includes(…)`: an array `includes` is already
    // an exact match, but CodeQL reads `includes(<url literal>)` as substring
    // URL sanitization and flags it.
    const asked = requestedAgentUrls(params).some((url) => url === STORED_SPELLING);
    if (text.includes('workos_user_id')) {
      return mockResult(asked ? [{ workos_user_id: OWNER_USER_ID }] : []);
    }
    if (text.includes("agent->>'visibility'")) {
      return mockResult(asked ? [{ one: 1 }] : []);
    }
    if (text.includes('agent_compliance_status')) {
      return mockResult([{
        agent_url: FOLDED_URL,
        headline: 'Storyboards failing',
        status: 'failing',
        status_changed_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
      }]);
    }
    return mockResult([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installTrailingSlashOwnerProfile();
});

describe('notification owner lookup folds the stored agent_url spelling (#8321)', () => {
  it('DMs the owner about a compliance regression', async () => {
    await notifyComplianceChange({
      agentUrl: FOLDED_URL,
      previousStatus: 'passing',
      currentStatus: 'failing',
      headline: 'Two storyboards failing.',
      tracksJson: [{ track: 'media-buy', status: 'fail' }] as never,
    });

    expect(mockedNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockedNotifyUser.mock.calls[0][0]).toMatchObject({
      recipientUserId: OWNER_USER_ID,
      type: 'compliance_regression',
      referenceId: FOLDED_URL,
      referenceType: 'agent',
    });
  });

  it('DMs the owner about a verification badge change', async () => {
    await notifyVerificationChange({
      agentUrl: FOLDED_URL,
      issued: [{ role: 'sales', specialisms: ['media-buy'], adcp_version: '3.2.1' }],
      revoked: [],
    });

    expect(mockedNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockedNotifyUser.mock.calls[0][0]).toMatchObject({
      recipientUserId: OWNER_USER_ID,
      type: 'verification_earned',
      referenceId: FOLDED_URL,
    });
  });

  it('posts the verification badge to the shared channel when the stored spelling is public', async () => {
    await notifyVerificationChange({
      agentUrl: FOLDED_URL,
      issued: [{ role: 'sales', specialisms: ['media-buy'] }],
      revoked: [],
    });

    expect(mockedSendChannelMessage).toHaveBeenCalledTimes(1);
    expect(mockedSendChannelMessage.mock.calls[0][0]).toBe('C_REGISTRY_EDITS');
  });

  it('DMs the owner about a timed-out heartbeat', async () => {
    await notifyComplianceTimeout({
      agentUrl: FOLDED_URL,
      summary: 'Last heartbeat timed out after 654s of its 600s budget.',
    });

    expect(mockedNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockedNotifyUser.mock.calls[0][0]).toMatchObject({
      recipientUserId: OWNER_USER_ID,
      type: 'compliance_heartbeat_timed_out',
      referenceId: FOLDED_URL,
    });
  });

  it('DMs the owner about an extended outage', async () => {
    const result = await notifyExtendedOutages();

    expect(result.notified).toBe(1);
    expect(mockedNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockedNotifyUser.mock.calls[0][0]).toMatchObject({
      recipientUserId: OWNER_USER_ID,
      type: 'compliance_extended_outage',
      referenceId: FOLDED_URL,
    });
  });

  it('DMs the owner when the caller holds the trailing slash and the profile holds the key', async () => {
    // The mirror of the cases above: every keying writer stores the folded
    // key, so a caller that still has the registered spelling must find it.
    mockedQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
      const text = String(sql);
      const asked = requestedAgentUrls(params).some((url) => url === FOLDED_URL);
      if (text.includes('workos_user_id')) {
        return mockResult(asked ? [{ workos_user_id: OWNER_USER_ID }] : []);
      }
      return mockResult([]);
    });

    await notifyComplianceTimeout({ agentUrl: STORED_SPELLING, summary: 'timed out' });

    expect(mockedNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockedNotifyUser.mock.calls[0][0]).toMatchObject({
      recipientUserId: OWNER_USER_ID,
      type: 'compliance_heartbeat_timed_out',
      referenceId: STORED_SPELLING,
    });
  });

  it('asks for the folded key, the stored spelling, and nothing else', async () => {
    await notifyComplianceTimeout({ agentUrl: FOLDED_URL, summary: 'timed out' });

    const ownerLookup = mockedQuery.mock.calls
      .find(([sql]) => String(sql).includes('workos_user_id'));
    expect(ownerLookup).toBeDefined();
    expect(new Set(requestedAgentUrls(ownerLookup?.[1]))).toEqual(
      new Set([FOLDED_URL, STORED_SPELLING]),
    );
    const sql = String(ownerLookup?.[0]).replace(/\s+/g, ' ');
    // Org scoping survives the widened URL match.
    expect(sql).toContain('JOIN organization_memberships om');
    expect(sql).toContain('om.workos_organization_id = mp.workos_organization_id');
    // Identity never comes from the authorization spelling (#7829).
    expect(sql).not.toContain('declared_url');
  });

  it('still finds nothing for an agent no profile registered', async () => {
    await notifyComplianceTimeout({
      agentUrl: 'https://other.example.com/mcp',
      summary: 'timed out',
    });

    expect(mockedNotifyUser).not.toHaveBeenCalled();
  });
});
