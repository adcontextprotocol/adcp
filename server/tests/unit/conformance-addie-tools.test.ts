/**
 * Unit tests for Addie's conformance Socket Mode chat tools.
 *
 * Mocks `runStoryboardViaConformanceSocket` so we don't need a live
 * adopter session — the integration coverage for that path lives in
 * the conformance/ tests. These tests focus on the handler shapes:
 * org-binding enforcement, the markdown the user sees, and the
 * not-connected hint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemberContext } from '../../src/addie/member-context.js';

process.env.CONFORMANCE_JWT_SECRET = 'test-addie-tools-secret';
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const runStoryboardMock = vi.fn();
vi.mock('../../src/conformance/run-storyboard-via-ws.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/conformance/run-storyboard-via-ws.js',
  );
  return {
    ...actual,
    runStoryboardViaConformanceSocket: (...args: unknown[]) => runStoryboardMock(...args),
  };
});

function memberContextWithOrg(orgId: string): MemberContext {
  return {
    is_mapped: true,
    is_member: true,
    organization: {
      workos_organization_id: orgId,
      name: 'Test Org',
      subscription_status: 'active',
      is_personal: false,
      membership_tier: 'professional',
    },
  } as unknown as MemberContext;
}

function memberContextWithoutOrg(): MemberContext {
  return {
    is_mapped: false,
    is_member: false,
  } as unknown as MemberContext;
}

beforeEach(async () => {
  runStoryboardMock.mockReset();
  const { conformanceSessions } = await import('../../src/conformance/session-store.js');
  await conformanceSessions.closeAll();
});

describe('issue_conformance_token Addie tool', () => {
  it('returns a not-mapped hint when the caller has no org', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const handlers = createConformanceToolHandlers(memberContextWithoutOrg());
    const handler = handlers.get('issue_conformance_token');
    const out = await handler!({});
    expect(out).toMatch(/not mapped to an organization/i);
  });

  it('returns a token + url + expiry when the caller has an org', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const handlers = createConformanceToolHandlers(memberContextWithOrg('org_alpha'));
    const handler = handlers.get('issue_conformance_token');
    const out = await handler!({});
    expect(out).toMatch(/Conformance token issued/i);
    expect(out).toMatch(/ADCP_CONFORMANCE_TOKEN=/);
    expect(out).toMatch(/ADCP_CONFORMANCE_URL=/);
    expect(out).toMatch(/Expires at/);
    expect(out).toMatch(/@adcp\/sdk\/server/);
  });

  it('returns a configuration error when CONFORMANCE_JWT_SECRET is missing', async () => {
    delete process.env.CONFORMANCE_JWT_SECRET;
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const handlers = createConformanceToolHandlers(memberContextWithOrg('org_alpha'));
    const out = await handlers.get('issue_conformance_token')!({});
    expect(out).toMatch(/not configured/i);
    process.env.CONFORMANCE_JWT_SECRET = 'test-addie-tools-secret';
  });
});

describe('run_conformance_against_my_agent Addie tool', () => {
  it('returns a not-mapped hint when the caller has no org', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const handlers = createConformanceToolHandlers(memberContextWithoutOrg());
    const out = await handlers.get('run_conformance_against_my_agent')!({
      storyboard_id: 'media_buy_state_machine',
    });
    expect(out).toMatch(/not mapped to an organization/i);
    expect(runStoryboardMock).not.toHaveBeenCalled();
  });

  it('returns a missing-id message when storyboard_id is empty', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const handlers = createConformanceToolHandlers(memberContextWithOrg('org_a'));
    const out = await handlers.get('run_conformance_against_my_agent')!({});
    expect(out).toMatch(/storyboard_id.*required/i);
  });

  it('returns the not-connected hint when the org has no live session', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const handlers = createConformanceToolHandlers(memberContextWithOrg('org_a'));
    const out = await handlers.get('run_conformance_against_my_agent')!({
      storyboard_id: 'media_buy_state_machine',
    });
    expect(out).toMatch(/No conformance connection is live/i);
    expect(out).toMatch(/issue_conformance_token/);
    expect(runStoryboardMock).not.toHaveBeenCalled();
  });

  it('formats a passing storyboard result as markdown', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const { conformanceSessions } = await import('../../src/conformance/session-store.js');
    // Register a placeholder session so the not-connected guard doesn't fire.
    conformanceSessions.register({
      orgId: 'org_a',
      transport: { close: vi.fn().mockResolvedValue(undefined) } as never,
      mcpClient: {} as never,
      connectedAt: Date.now(),
    });

    runStoryboardMock.mockResolvedValue({
      storyboard_id: 'sb_demo',
      storyboard_title: 'Demo Storyboard',
      overall_passed: true,
      passed_count: 2,
      failed_count: 0,
      skipped_count: 0,
      total_duration_ms: 123,
      phases: [
        {
          phase_id: 'p1',
          phase_title: 'Setup',
          passed: true,
          duration_ms: 50,
          steps: [
            { step_id: 's1', phase_id: 'p1', title: 'discover', task: 'discover', passed: true },
            { step_id: 's2', phase_id: 'p1', title: 'query', task: 'query', passed: true },
          ],
        },
      ],
    });

    const handlers = createConformanceToolHandlers(memberContextWithOrg('org_a'));
    const out = await handlers.get('run_conformance_against_my_agent')!({
      storyboard_id: 'sb_demo',
    });
    expect(out).toMatch(/PASSED/);
    expect(out).toMatch(/2 \/ 0 \/ 0/);
    expect(out).toMatch(/Setup/);
    expect(out).toMatch(/discover/);
  });

  it('renders error text on failing steps', async () => {
    const { createConformanceToolHandlers } = await import(
      '../../src/addie/mcp/conformance-tools.js'
    );
    const { conformanceSessions } = await import('../../src/conformance/session-store.js');
    conformanceSessions.register({
      orgId: 'org_a',
      transport: { close: vi.fn().mockResolvedValue(undefined) } as never,
      mcpClient: {} as never,
      connectedAt: Date.now(),
    });

    runStoryboardMock.mockResolvedValue({
      storyboard_id: 'sb_demo',
      storyboard_title: 'Demo',
      overall_passed: false,
      passed_count: 1,
      failed_count: 1,
      skipped_count: 0,
      total_duration_ms: 200,
      phases: [
        {
          phase_id: 'p1',
          phase_title: 'Run',
          passed: false,
          duration_ms: 200,
          steps: [
            { step_id: 's1', phase_id: 'p1', title: 'first', task: 'first', passed: true },
            {
              step_id: 's2',
              phase_id: 'p1',
              title: 'second',
              task: 'second',
              passed: false,
              error: 'expected status 200, got 500',
            },
          ],
        },
      ],
    });

    const handlers = createConformanceToolHandlers(memberContextWithOrg('org_a'));
    const out = await handlers.get('run_conformance_against_my_agent')!({
      storyboard_id: 'sb_demo',
    });
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/expected status 200, got 500/);
  });
});
