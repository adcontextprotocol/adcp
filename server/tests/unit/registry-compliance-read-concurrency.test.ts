import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(
  new URL('../../src/routes/registry-api.ts', import.meta.url),
  'utf8',
);

describe('registry compliance read concurrency', () => {
  it('bounds independent compliance-card projections within one database deadline', () => {
    expect(routeSource).toContain('const COMPLIANCE_CARD_READ_CONCURRENCY = 2;');
    expect(routeSource).toContain('const COMPLIANCE_CARD_READ_DEADLINE_MS = 8_000;');
    const batchStart = routeSource.indexOf('const supplementalTasks = [');
    const batchEnd = routeSource.indexOf('] as const);', batchStart);

    expect(batchStart).toBeGreaterThan(-1);
    expect(batchEnd).toBeGreaterThan(batchStart);
    const batch = routeSource.slice(batchStart, batchEnd);
    expect(batch).toContain('getBadgesForAgent(agentUrl)');
    expect(batch).toContain('getPublicSelectedGradingStatuses(agentUrl)');
    expect(batch).toContain('getLatestDeclaredSpecialisms(agentUrl)');
    expect(batch).toContain('getLatestNotices(agentUrl)');
    expect(batch).toContain('getLatestObservations(agentUrl)');
    expect(batch).toContain('getStoryboardStatuses(agentUrl');
    expect(batch).toContain('resolveOwnerMembership(userId, agentUrl');
    expect(routeSource).toContain('withDatabaseDeadline(\n        complianceCardReadDeadline,');
    expect(routeSource).toContain(
      'allSettledWithConcurrency(\n          supplementalTasks,\n          COMPLIANCE_CARD_READ_CONCURRENCY',
    );
  });

  it('indexes the latest-run storyboard lookup used by both slow routes', () => {
    const migration = readFileSync(
      new URL('../../src/db/migrations/609_agent_storyboard_status_run_lookup.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS agent_storyboard_status_agent_run_idx\s+ON agent_storyboard_status \(agent_url, run_id\)/,
    );
  });
});
