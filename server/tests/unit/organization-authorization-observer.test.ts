import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listOrganizationMemberships,
  captureEvent,
} = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
  captureEvent: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({ userManagement: { listOrganizationMemberships } }),
}));
vi.mock('../../src/utils/posthog.js', () => ({ captureEvent }));

import {
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
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('user_canonical');
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('user_authenticated');
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('org_selected');
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
