import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Agent } from '../../src/types.js';

// Pins the bug: HealthChecker.getStats must return publisher/property counts
// for SALES agents (the ones with publisher authorizations), not 'buying' agents.
// Pre-#3496 the inference code mis-tagged sales tools as 'buying', which masked
// this filter inversion. Once #3496 corrected the classification, the filter
// stopped matching any real sales agent and all stats silently returned empty.

const mockGetAgentAuthorizations = vi.fn();

vi.mock('@adcp/sdk', () => ({
  getPropertyIndex: () => ({
    getAgentAuthorizations: mockGetAgentAuthorizations,
  }),
  AdCPClient: class {
    agent() {
      return { executeTask: vi.fn(), getAgentInfo: vi.fn() };
    }
  },
}));

vi.mock('../../src/db/outbound-log-db.js', () => ({
  logOutboundRequest: vi.fn(),
}));

import { HealthChecker } from '../../src/health.js';

const baseAgent = (overrides: Partial<Agent>): Agent => ({
  name: 'Test',
  url: 'https://agent.example.com',
  type: 'sales',
  protocol: 'mcp',
  description: '',
  mcp_endpoint: 'https://agent.example.com/mcp',
  contact: { name: '', email: '', website: '' },
  added_date: '2026-01-01',
  ...overrides,
});

describe('HealthChecker.getStats — type filter', () => {
  let checker: HealthChecker;

  beforeEach(() => {
    checker = new HealthChecker(0);
    mockGetAgentAuthorizations.mockReset();
  });

  it('populates property/publisher counts for SALES agents', async () => {
    mockGetAgentAuthorizations.mockReturnValue({
      properties: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      publisher_domains: ['pub-a.com', 'pub-b.com'],
    });

    const stats = await checker.getStats(baseAgent({ type: 'sales' }));

    expect(stats.property_count).toBe(3);
    expect(stats.publishers).toEqual(['pub-a.com', 'pub-b.com']);
    expect(stats.publisher_count).toBe(2);
  });

  it('does NOT populate property/publisher counts for BUYING agents', async () => {
    mockGetAgentAuthorizations.mockReturnValue({
      properties: [{ id: 'p1' }],
      publisher_domains: ['pub-a.com'],
    });

    const stats = await checker.getStats(baseAgent({ type: 'buying' }));

    expect(stats.property_count).toBeUndefined();
    expect(stats.publishers).toBeUndefined();
    expect(stats.publisher_count).toBeUndefined();
  });

  it('returns empty stats for sales agents with no authorizations', async () => {
    mockGetAgentAuthorizations.mockReturnValue({
      properties: [],
      publisher_domains: [],
    });

    const stats = await checker.getStats(baseAgent({ type: 'sales' }));

    expect(stats.property_count).toBeUndefined();
    expect(stats.publishers).toBeUndefined();
  });
});
