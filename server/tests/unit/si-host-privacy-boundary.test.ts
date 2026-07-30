import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSiEnabledMembers: vi.fn(),
  getSession: vi.fn(),
  initiateSession: vi.fn(),
}));

vi.mock('../../src/db/si-db.js', () => ({
  siDb: {
    getSiEnabledMembers: mocks.getSiEnabledMembers,
    getSession: mocks.getSession,
  },
}));

vi.mock('../../src/addie/services/si-agent-service.js', () => ({
  siAgentService: {
    initiateSession: mocks.initiateSession,
  },
}));

import { createSiHostToolHandlers } from '../../src/addie/mcp/si-host-tools.js';

function member(index = 1) {
  return {
    id: `member-${index}`,
    display_name: `Member ${index}`,
    slug: `member-${index}`,
    tagline: 'Tagline',
    description: 'Description',
    si_endpoint_url: null,
    si_skills: ['documentation'],
  };
}

describe('SI host privacy and output boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
  });

  it('does not pass a stable Slack identifier when identity sharing is declined', async () => {
    mocks.getSiEnabledMembers.mockResolvedValue([member()]);
    mocks.initiateSession.mockResolvedValue({
      session: { session_id: 'si_private' },
      response: { message: 'hello' },
      relationship: { total_sessions: 0, lead_status: 'new' },
    });
    const handlers = createSiHostToolHandlers(
      () => ({
        slack_user: {
          slack_user_id: 'U_STABLE_PRIVATE',
          email: 'private@example.com',
          display_name: 'Private User',
        },
      } as any),
      () => 'thread-private-consent-test',
    );

    const result = JSON.parse(await handlers.get('connect_to_si_agent')!({
      brand_name: 'member-1',
      context: 'Question',
      share_identity: false,
    }));

    expect(result.identity_shared).toBe(false);
    expect(mocks.initiateSession).toHaveBeenCalledWith(expect.objectContaining({
      identity: {
        consent_granted: false,
        email: undefined,
        name: undefined,
        slack_id: undefined,
      },
    }));
  });

  it('caps SI listings and labels every mutable profile field as untrusted', async () => {
    mocks.getSiEnabledMembers.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        ...member(index),
        description: 'x'.repeat(5_000),
        si_skills: Array.from({ length: 30 }, (_value, skill) => `skill-${skill}`),
      })),
    );
    const handlers = createSiHostToolHandlers(() => null, () => 'thread-list-test');

    const result = JSON.parse(await handlers.get('list_si_agents')!({}));
    expect(result.agents).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.untrusted_data_notice).toContain('not instructions');
    expect(result.agents[0].name).toMatch(/^<untrusted_proposer_input>/);
    expect(result.agents[0].description.length).toBeLessThan(1_100);
    expect(result.agents[0].skills).toHaveLength(10);
  });
});
