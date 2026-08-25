import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listOrganizationMemberships,
  captureEvent,
  loggerInfo,
} = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
  captureEvent: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getAuthorizationObserverWorkos: () => ({ userManagement: { listOrganizationMemberships } }),
}));
vi.mock('../../src/utils/posthog.js', () => ({ captureEvent }));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ info: loggerInfo, warn: vi.fn() }),
}));

import {
  authorizationRouteFamily,
  classifyAuthorizationObservation,
  observeLinkedCredentialOrganizationAuthorization,
  organizationSelectorFromRequest,
} from '../../src/middleware/organization-authorization-observer.js';

describe('organization authorization rollout observer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ORG_AUTHORIZATION_OBSERVER_ENABLED;
  });

  it('reports the explicit selector source without mutating the request', () => {
    const req = {
      headers: { 'x-organization-id': ' org_header ' },
      query: { org: 'org_query' },
      body: { organization_id: 'org_body' },
      params: { orgId: 'org_path' },
    } as any;

    expect(organizationSelectorFromRequest(req)).toEqual({
      organizationId: 'org_header',
      source: 'header',
      explicit: true,
    });
    expect(req.headers['x-organization-id']).toBe(' org_header ');
  });

  it('classifies allow and role differences', () => {
    expect(classifyAuthorizationObservation(
      { allowed: true, role: 'owner' },
      { allowed: false, role: null },
    )).toBe('legacy_allow_exact_deny');
    expect(classifyAuthorizationObservation(
      { allowed: true, role: 'owner' },
      { allowed: true, role: 'member' },
    )).toBe('both_allow_role_mismatch');
  });

  it('reduces routes to a fixed non-identifying family', () => {
    expect(authorizationRouteFamily('PATCH /api/organizations/org_secret')).toBe('organizations');
    expect(authorizationRouteFamily('GET /api/org_secret/private')).toBe('other');
    expect(authorizationRouteFamily('GET /api/toString/private')).toBe('other');
    expect(authorizationRouteFamily('GET /api/__proto__/private')).toBe('other');
  });

  it('compares the canonical and authenticated credentials without exposing IDs', async () => {
    listOrganizationMemberships
      .mockResolvedValueOnce({
        data: [{ organizationId: 'org_selected', status: 'active', role: { slug: 'owner' } }],
      })
      .mockResolvedValueOnce({ data: [] });

    await observeLinkedCredentialOrganizationAuthorization({
      headers: {},
      query: { org: 'org_selected' },
      body: {},
      params: {},
      method: 'POST',
      user: { id: 'user_canonical', authWorkosUserId: 'user_authenticated' },
    } as any, 'POST /api/example', 200);

    expect(listOrganizationMemberships).toHaveBeenNthCalledWith(1, {
      userId: 'user_canonical',
      organizationId: 'org_selected',
    });
    expect(listOrganizationMemberships).toHaveBeenNthCalledWith(2, {
      userId: 'user_authenticated',
      organizationId: 'org_selected',
    });
    expect(captureEvent).toHaveBeenCalledWith(
      'server-metrics',
      'org_authorization_shadow',
      expect.objectContaining({
        decision: 'legacy_allow_exact_deny',
        selector_source: 'query_org',
        explicit_organization: true,
      }),
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'legacy_allow_exact_deny',
        route_family: 'other',
        selector_source: 'query_org',
        legacy_allowed: true,
        exact_allowed: false,
      }),
      'org authorization shadow observation',
    );
    const telemetry = JSON.stringify([captureEvent.mock.calls, loggerInfo.mock.calls]);
    expect(telemetry).not.toContain('user_canonical');
    expect(telemetry).not.toContain('user_authenticated');
    expect(telemetry).not.toContain('org_selected');
    expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain('POST /api/example');
  });

  it('records a missing selector without inferring or mutating organization state', async () => {
    await observeLinkedCredentialOrganizationAuthorization({
      headers: {},
      query: {},
      body: {},
      params: {},
      method: 'GET',
      user: { id: 'user_canonical', authWorkosUserId: 'user_authenticated' },
    } as any, 'GET /api/example', 200);

    expect(listOrganizationMemberships).not.toHaveBeenCalled();
    expect(captureEvent).toHaveBeenCalledWith(
      'server-metrics',
      'org_authorization_shadow',
      expect.objectContaining({
        decision: 'no_explicit_organization',
        selector_source: 'none',
        explicit_organization: false,
      }),
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'no_explicit_organization',
        route_family: 'other',
      }),
      'org authorization shadow observation',
    );
  });

  it('drops observer work when the bounded WorkOS comparison pool is saturated', async () => {
    const pending: Array<(value: { data: never[] }) => void> = [];
    listOrganizationMemberships.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const request = (suffix: number) => observeLinkedCredentialOrganizationAuthorization({
      headers: {},
      query: { org: `org_selected_${suffix}` },
      body: {},
      params: {},
      method: 'GET',
      user: { id: `user_canonical_${suffix}`, authWorkosUserId: `user_authenticated_${suffix}` },
    } as any, 'GET /api/example', 200);

    const inFlight = Array.from({ length: 5 }, (_, index) => request(index));
    await vi.waitFor(() => expect(listOrganizationMemberships).toHaveBeenCalledTimes(10));

    await request(6);

    expect(listOrganizationMemberships).toHaveBeenCalledTimes(10);
    expect(captureEvent).toHaveBeenCalledWith(
      'server-metrics',
      'org_authorization_shadow',
      expect.objectContaining({ decision: 'observer_saturated' }),
    );
    pending.forEach((resolve) => resolve({ data: [] }));
    await Promise.all(inFlight);
  });

  it('does no extra work for unlinked sessions or when disabled', async () => {
    await observeLinkedCredentialOrganizationAuthorization({
      headers: {}, query: {}, body: {}, params: {}, method: 'GET',
      user: { id: 'user_direct' },
    } as any, 'GET /api/example', 200);

    process.env.ORG_AUTHORIZATION_OBSERVER_ENABLED = 'false';
    await observeLinkedCredentialOrganizationAuthorization({
      headers: {}, query: {}, body: {}, params: {}, method: 'GET',
      user: { id: 'user_canonical', authWorkosUserId: 'user_authenticated' },
    } as any, 'GET /api/example', 200);

    expect(listOrganizationMemberships).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
  });
});
