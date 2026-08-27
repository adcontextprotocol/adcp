import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ANALYTICS_TOOL,
  registerAdminAnalyticsHandler,
  resolveAdminAnalyticsInvocation,
} from '../../../src/addie/mcp/admin-analytics.js';

describe('query_admin_analytics', () => {
  it.each([
    [
      { view: 'platform_stats' },
      'get_platform_stats',
      {},
    ],
    [
      { view: 'member_search', days: 14 },
      'get_member_search_analytics',
      { days: 14 },
    ],
    [
      { view: 'organizations_by_users', limit: 10, member_status: 'member', min_users: 2 },
      'list_organizations_by_users',
      { limit: 10, member_status: 'member', min_users: 2 },
    ],
    [
      {
        view: 'users_by_engagement',
        limit: 25,
        stage: 'contributing',
        member_only: true,
        membership_tier: 'company',
        include_breakdown: true,
      },
      'list_users_by_engagement',
      {
        limit: 25,
        stage: 'contributing',
        member_only: true,
        membership_tier: 'company',
        include_breakdown: true,
      },
    ],
  ] as const)('delegates %j without changing the legacy output', async (input, handlerName, expectedInput) => {
    const exactOutput = `exact:${handlerName}`;
    const legacyHandler = vi.fn().mockResolvedValue(exactOutput);
    const handlers = new Map([[handlerName, legacyHandler]]);
    registerAdminAnalyticsHandler(handlers);

    await expect(handlers.get('query_admin_analytics')!({ ...input })).resolves.toBe(exactOutput);
    expect(legacyHandler).toHaveBeenCalledOnce();
    expect(legacyHandler).toHaveBeenCalledWith(expectedInput);
    expect(handlers.has(handlerName)).toBe(false);
  });

  it.each([
    [{}],
    [{ view: 'unknown' }],
    [{ view: 'toString' }],
    [{ view: 'platform_stats', limit: 1 }],
    [{ view: 'member_search', days: 0 }],
    [{ view: 'member_search', days: 1.5 }],
    [{ view: 'organizations_by_users', member_status: 'inactive' }],
    [{ view: 'organizations_by_users', min_users: 0 }],
    [{ view: 'organizations_by_users', min_users: -1 }],
    [{ view: 'users_by_engagement', stage: 'unknown' }],
    [{ view: 'users_by_engagement', member_only: 'true' }],
    [{ view: 'users_by_engagement', membership_tier: 'enterprise' }],
    [{ view: 'users_by_engagement', include_breakdown: 1 }],
  ])('rejects invalid or cross-view input before delegation: %j', async (input) => {
    const legacyHandler = vi.fn().mockResolvedValue('must not run');
    const handlers = new Map([
      ['get_platform_stats', legacyHandler],
      ['get_member_search_analytics', legacyHandler],
      ['list_organizations_by_users', legacyHandler],
      ['list_users_by_engagement', legacyHandler],
    ]);
    registerAdminAnalyticsHandler(handlers);

    await expect(handlers.get('query_admin_analytics')!(input)).rejects.toThrow();
    expect(legacyHandler).not.toHaveBeenCalled();
  });

  it('uses a flat provider-neutral schema and remains fail-closed for replay', () => {
    const serialized = JSON.stringify(ADMIN_ANALYTICS_TOOL.input_schema);
    expect(ADMIN_ANALYTICS_TOOL.name).toBe('query_admin_analytics');
    expect(ADMIN_ANALYTICS_TOOL.replaySafety).toBeUndefined();
    expect(ADMIN_ANALYTICS_TOOL.input_schema.additionalProperties).toBe(false);
    expect(serialized).not.toContain('oneOf');
    expect(serialized).not.toContain('$ref');
    expect(serialized).not.toContain('"const"');
  });

  it('returns only the selected private-handler invocation', () => {
    expect(resolveAdminAnalyticsInvocation({
      view: 'organizations_by_users',
      limit: 100,
      member_status: 'all',
    })).toEqual({
      handlerName: 'list_organizations_by_users',
      handlerInput: { limit: 100, member_status: 'all' },
    });
  });

  it('removes every legacy analytics definition and executable handler', async () => {
    const { ADMIN_TOOLS, createAdminToolHandlers } = await import(
      '../../../src/addie/mcp/admin-tools.js'
    );
    const legacyNames = [
      'get_platform_stats',
      'get_member_search_analytics',
      'list_organizations_by_users',
      'list_users_by_engagement',
    ];
    const publicNames = ADMIN_TOOLS.map((tool) => tool.name);
    const handlers = createAdminToolHandlers();

    expect(publicNames).toContain('query_admin_analytics');
    expect(handlers.has('query_admin_analytics')).toBe(true);
    for (const legacyName of legacyNames) {
      expect(publicNames).not.toContain(legacyName);
      expect(handlers.has(legacyName)).toBe(false);
    }
  });
});
