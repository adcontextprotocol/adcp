import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordComplianceRunInput } from '../../src/db/compliance-db.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }));
vi.mock('../../src/db/client.js', () => mocks);
import { ComplianceDatabase } from '../../src/db/compliance-db.js';

const agentUrl = 'https://agent.example.test/mcp';
const operations: Array<[string, (db: ComplianceDatabase) => Promise<unknown>]> = [
  ['compliance run', db => db.recordComplianceRun({ agent_url: agentUrl } as RecordComplianceRunInput)],
  ['badge issuance', db => db.upsertBadge({ agent_url: agentUrl, role: 'media-buy', adcp_version: '3.1', verified_specialisms: [] })],
  ['badge revocation without generation', db => db.revokeBadge(agentUrl, 'media-buy', '3.1', 'Fixture revocation')],
  ['badge degradation without generation', db => db.degradeBadge(agentUrl, 'media-buy', '3.1')],
  ['opt-out revocation', db => db.revokeAllBadgesIfOptedOut(agentUrl, 'Fixture opt-out')],
  ['requalification preparation', db => db.prepareBadgeRequalification(agentUrl, '1')],
  ['requalification completion', db => db.completeBadgeRequalification(agentUrl, '1')],
];

describe('compliance writes with queued credential authorization', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(operations)('rolls back %s before mutation when authorization is revoked', async (_name, operation) => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: vi.fn() };
    mocks.getClient.mockResolvedValue(client);
    const revoked = Object.assign(new Error('Refresh authority changed'), { code: 'authorization_revoked' });
    const beforeWrite = vi.fn().mockRejectedValue(revoked);

    await expect(operation(new ComplianceDatabase(beforeWrite))).rejects.toBe(revoked);

    expect(beforeWrite).toHaveBeenCalledExactlyOnceWith(client, agentUrl);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['revoke', 'degrade'] as const)('keeps guarded %s writes transactional without a badge generation', async (action) => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: vi.fn() };
    mocks.getClient.mockResolvedValue(client);
    const beforeWrite = vi.fn(async (transaction) => { await transaction.query('SELECT authorization_guard'); });
    const db = new ComplianceDatabase(beforeWrite);

    const result = action === 'revoke'
      ? await db.revokeBadge(agentUrl, 'media-buy', '3.1', 'Fixture revocation')
      : await db.degradeBadge(agentUrl, 'media-buy', '3.1');

    expect(result).toBe(true);
    const statements = client.query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toBe('SELECT authorization_guard');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
