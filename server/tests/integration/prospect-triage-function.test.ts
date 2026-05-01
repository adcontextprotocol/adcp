/**
 * Integration test: assessWithClaude assess_prospect tool_use output →
 * TriageResult + prospect_triage_log DB write contract.
 *
 * triageEmailDomain() calls assessWithClaude(), which uses the assess_prospect
 * tool_use pattern. This test pins that the tool_use output (action, owner,
 * priority) is correctly mapped into the returned TriageResult and that
 * logTriageDecision() writes a matching row to prospect_triage_log.
 *
 * There is no admin HTTP route for prospect triage — the entry points are
 * triageAndNotify (webhook) and triageAndCreateProspect (batch job). The test
 * exercises triageEmailDomain() directly to isolate the Anthropic contract.
 *
 * Gap from testing-expert review on PR #3611 (issue #3621): if the assess_prospect
 * tool_use response shape drifted (e.g. action returning undefined), the unit
 * tests would pass but triageAndCreateProspect would silently create a prospect
 * with action=undefined, defeating the create/skip decision logic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  resolveOrgByDomain: vi.fn(),
  isFreeEmailDomain: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  return { default: FakeAnthropic, APIError, APIConnectionError };
});

vi.mock('../../src/db/domain-resolution-db.js', () => ({
  resolveOrgByDomain: mocks.resolveOrgByDomain,
}));

vi.mock('../../src/utils/email-domain.js', () => ({
  isFreeEmailDomain: mocks.isFreeEmailDomain,
}));

vi.mock('../../src/services/lusha.js', () => ({
  isLushaConfigured: () => false,
}));

vi.mock('../../src/services/enrichment.js', () => ({
  enrichDomain: vi.fn().mockResolvedValue({ success: false }),
}));

// Silence Slack notification side effects — fire-and-forget rejections
// from unmocked notification calls can cause Vitest to flag unhandled
// promise rejections and fail otherwise-passing tests.
vi.mock('../../src/notifications/prospect.js', () => ({
  notifyNewProspect: vi.fn().mockResolvedValue(undefined),
  notifyAliasMatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getSetting: vi.fn().mockResolvedValue({ enabled: true }),
  SETTING_KEYS: { PROSPECT_TRIAGE_ENABLED: 'prospect_triage_enabled' },
}));

// Defensive: account-management-db is imported at module scope by prospect-triage.ts
// and would fire against the real DB if handleSkipSideEffects were reached.
vi.mock('../../src/db/account-management-db.js', () => ({
  createActionItem: vi.fn().mockResolvedValue(undefined),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { triageEmailDomain } from '../../src/services/prospect-triage.js';

// Hyphen separator: triage doesn't validate domain format itself but
// downstream code may, and matching the other integration tests' convention
// keeps log lines greppable.
const SUFFIX = `${process.pid}-${Date.now()}`;
const TEST_DOMAIN = `triage-test-${SUFFIX}.co`;

function assessProspectResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', name: 'assess_prospect', id: 'toolu_test', input }],
  };
}

// triageEmailDomain calls logTriageDecision fire-and-forget (line ~449
// of prospect-triage.ts) so the INSERT is racing the SELECT. Poll briefly
// instead of awaiting, since changing the prod call to await would alter
// caller-visible latency.
async function awaitTriageLog<T>(
  pool: Pool,
  domain: string,
  selectSql: string,
  timeoutMs = 2000,
): Promise<{ rows: T[] }> {
  const deadline = Date.now() + timeoutMs;
  let last: { rows: T[] } = { rows: [] };
  while (Date.now() < deadline) {
    last = await pool.query<T>(selectSql, [domain]);
    if (last.rows.length > 0) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

describe('triageEmailDomain — assessWithClaude tool_use output → TriageResult + log contract', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM prospect_triage_log WHERE domain = $1', [TEST_DOMAIN]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM prospect_triage_log WHERE domain = $1', [TEST_DOMAIN]);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    // Default: domain is not a free-email provider and is not yet tracked.
    mocks.isFreeEmailDomain.mockReturnValue(false);
    mocks.resolveOrgByDomain.mockResolvedValue(null);
    mocks.anthropicCreate.mockRejectedValue(
      new Error('anthropic.messages.create was not stubbed for this test'),
    );
  });

  it('maps action:create + owner:addie + priority:high from tool_use into TriageResult and log row', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      assessProspectResponse({
        action: 'create',
        reason: 'ad_tech_vendor',
        owner: 'addie',
        priority: 'high',
        verdict: 'Pinnacle Media is a well-known ad tech company. Fits the membership profile.',
        company_name: 'Pinnacle Media',
        company_type: 'publisher',
      }),
    );

    const result = await triageEmailDomain(TEST_DOMAIN, { source: 'test' });

    expect(result.action).toBe('create');
    expect(result.owner).toBe('addie');
    expect(result.priority).toBe('high');

    // prospect_triage_log row must exist and carry the same values —
    // the log write is the only DB side effect at this layer.
    const row = await awaitTriageLog<{
      action: string;
      owner: string;
      priority: string;
      reason: string;
    }>(
      pool,
      TEST_DOMAIN,
      'SELECT action, owner, priority, reason FROM prospect_triage_log WHERE domain = $1',
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].action).toBe('create');
    expect(row.rows[0].owner).toBe('addie');
    expect(row.rows[0].priority).toBe('high');
    expect(row.rows[0].reason).toBe('ad_tech_vendor');
  });

  it('defaults priority to "standard" when assess_prospect omits the priority field', async () => {
    // priority is not in assess_prospect's required schema fields — the service
    // defaults it to 'standard'. This case proves the default survives through
    // triageEmailDomain and into the log row.
    mocks.anthropicCreate.mockResolvedValueOnce(
      assessProspectResponse({
        action: 'create',
        reason: 'media_company',
        owner: 'addie',
        // priority intentionally absent
        verdict: 'Nova Brands is a media company.',
        company_name: 'Nova Brands',
      }),
    );

    const result = await triageEmailDomain(TEST_DOMAIN, { source: 'test' });

    expect(result.priority).toBe('standard');

    const row = await awaitTriageLog<{ priority: string }>(
      pool,
      TEST_DOMAIN,
      'SELECT priority FROM prospect_triage_log WHERE domain = $1',
    );
    expect(row.rows[0].priority).toBe('standard');
  });

  it('returns action:skip without an Anthropic call when the domain resolves to an existing org', async () => {
    // resolveOrgByDomain returning non-null means the domain is already tracked.
    // The service must short-circuit before calling assessWithClaude.
    mocks.resolveOrgByDomain.mockResolvedValueOnce({
      orgId: 'org_existing_123',
      matchedDomain: TEST_DOMAIN,
      method: 'exact',
    });

    const result = await triageEmailDomain(TEST_DOMAIN, { source: 'test' });

    expect(result.action).toBe('skip');
    expect(result.reason).toBe('already_tracked');
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });
});
