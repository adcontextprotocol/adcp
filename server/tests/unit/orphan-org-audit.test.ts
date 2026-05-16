import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Daily orphan-org audit. Mocks the DB pool + system-settings + slack
 * client at the module seam — the value of this test is the orchestration
 * (counting, formatting, conditional posting), not the SQL.
 */

const { mockPool, mockChannels, mockSend, mockLoggerInfo } = vi.hoisted(() => ({
  mockPool: { query: vi.fn() },
  mockChannels: {
    getProspectChannel: vi.fn(),
    getAdminChannel: vi.fn(),
  },
  mockSend: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => mockPool,
}));

vi.mock('../../src/db/system-settings-db.js', () => mockChannels);

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: mockSend,
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { child: () => ({ info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { runOrphanOrgAudit } from '../../src/addie/jobs/orphan-org-audit.js';

function seedZeroOrphans() {
  // count all → 0
  mockPool.query.mockResolvedValueOnce({ rows: [{ total: '0', oldest: null }] });
  // examples → []
  mockPool.query.mockResolvedValueOnce({ rows: [] });
  // count new since → 0
  mockPool.query.mockResolvedValueOnce({ rows: [{ n: '0' }] });
}

function seedOrphans(opts: {
  total: number;
  newSince: number;
  exampleCount?: number;
  oldest?: Date;
}) {
  const oldest = opts.oldest ?? new Date('2026-02-13T13:17:38Z');
  mockPool.query.mockResolvedValueOnce({ rows: [{ total: String(opts.total), oldest }] });
  const examples = Array.from({ length: opts.exampleCount ?? Math.min(opts.total, 3) }, (_, i) => ({
    workos_organization_id: `org_orphan_${i}`,
    name: `Orphan ${i}`,
    created_at: new Date(oldest.getTime() + i * 86400000),
    has_stripe_customer: i === 0,
    prospect_source: 'slack_discovery',
    prospect_status: 'prospect',
    prospect_contact_email: null,
  }));
  mockPool.query.mockResolvedValueOnce({ rows: examples });
  mockPool.query.mockResolvedValueOnce({ rows: [{ n: String(opts.newSince) }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChannels.getProspectChannel.mockResolvedValue({ channel_id: 'C_prospect', channel_name: 'prospect' });
  mockChannels.getAdminChannel.mockResolvedValue({ channel_id: 'C_admin', channel_name: 'admin' });
  mockSend.mockResolvedValue({ ok: true, ts: '1.1' });
});

describe('runOrphanOrgAudit', () => {
  it('does not post when there are zero orphans', async () => {
    seedZeroOrphans();

    const result = await runOrphanOrgAudit();

    expect(result.total).toBe(0);
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('logs structured audit record regardless of outcome', async () => {
    seedZeroOrphans();
    await runOrphanOrgAudit();

    const call = mockLoggerInfo.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === 'object' &&
        args[0] !== null &&
        (args[0] as Record<string, unknown>).event === 'orphan_org_audit',
    );
    expect(call).toBeDefined();
    expect((call![0] as Record<string, unknown>).total).toBe(0);
  });

  it('posts to prospect channel when total > 0', async () => {
    seedOrphans({ total: 3, newSince: 0 });

    const result = await runOrphanOrgAudit();

    expect(result.total).toBe(3);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe('C_prospect');
    const text = (mockSend.mock.calls[0][1] as { text: string }).text;
    expect(text).toContain('3 prospect org');
  });

  it('falls back to admin channel when prospect channel is unconfigured', async () => {
    mockChannels.getProspectChannel.mockResolvedValue({ channel_id: null, channel_name: null });
    seedOrphans({ total: 1, newSince: 0 });

    const result = await runOrphanOrgAudit();

    expect(result.summaryPosted).toBe(true);
    expect(mockSend.mock.calls[0][0]).toBe('C_admin');
  });

  it('flags regression when orphans appeared in the last 24h', async () => {
    seedOrphans({ total: 5, newSince: 2 });

    await runOrphanOrgAudit();

    const text = (mockSend.mock.calls[0][1] as { text: string }).text;
    expect(text).toContain('2 appeared in the last 24h');
    expect(text).toContain('regression');
  });

  it('skips Slack post when no channel is configured', async () => {
    mockChannels.getProspectChannel.mockResolvedValue({ channel_id: null, channel_name: null });
    mockChannels.getAdminChannel.mockResolvedValue({ channel_id: null, channel_name: null });
    seedOrphans({ total: 2, newSince: 0 });

    const result = await runOrphanOrgAudit();

    expect(result.total).toBe(2);
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('formats examples with id, name, age, and source bits', async () => {
    seedOrphans({ total: 1, newSince: 0, exampleCount: 1, oldest: new Date(Date.now() - 80 * 86400000) });

    await runOrphanOrgAudit();

    const text = (mockSend.mock.calls[0][1] as { text: string }).text;
    expect(text).toContain('`org_orphan_0`');
    expect(text).toContain('"Orphan 0"');
    expect(text).toContain('80d old');
    expect(text).toContain('stripe');
  });
});
