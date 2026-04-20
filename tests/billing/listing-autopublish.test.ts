import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

// vi.mock is hoisted — mock handles live inside vi.hoisted so the factory
// can reference them safely.
const {
  mockGetProfileByOrgId,
  mockUpdateProfile,
  mockCreateProfile,
  mockIsSlugAvailable,
  mockRecordProfilePublishedIfNeeded,
} = vi.hoisted(() => ({
  mockGetProfileByOrgId: vi.fn(),
  mockUpdateProfile: vi.fn(),
  mockCreateProfile: vi.fn(),
  mockIsSlugAvailable: vi.fn(),
  mockRecordProfilePublishedIfNeeded: vi.fn(),
}));

vi.mock('../../server/src/db/member-db.js', () => ({
  MemberDatabase: class {
    getProfileByOrgId = mockGetProfileByOrgId;
    updateProfile = mockUpdateProfile;
    createProfile = mockCreateProfile;
    isSlugAvailable = mockIsSlugAvailable;
  },
}));

vi.mock('../../server/src/services/profile-publish-event.js', () => ({
  recordProfilePublishedIfNeeded: mockRecordProfilePublishedIfNeeded,
  isProfilePublishTransition: () => true,
}));

import { ensureMemberProfilePublished } from '../../server/src/services/member-profile-autopublish.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureMemberProfilePublished', () => {
  test('creates a new public profile when none exists', async () => {
    mockGetProfileByOrgId.mockResolvedValue(null);
    mockIsSlugAvailable.mockResolvedValue(true);
    mockCreateProfile.mockResolvedValue({ id: 'profile-123', slug: 'acme-corp' });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_abc',
      orgName: 'Acme Corp',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.action).toBe('created');
    expect(result.profileId).toBe('profile-123');
    expect(result.slug).toBe('acme-corp');

    expect(mockCreateProfile).toHaveBeenCalledWith({
      workos_organization_id: 'org_abc',
      display_name: 'Acme Corp',
      slug: 'acme-corp',
      is_public: true,
    });
    expect(mockRecordProfilePublishedIfNeeded).toHaveBeenCalledWith(
      'org_abc', false, true, 'stripe:customer.subscription.created',
    );
  });

  test('publishes an existing unpublished profile', async () => {
    mockGetProfileByOrgId.mockResolvedValue({
      id: 'profile-456',
      slug: 'existing-slug',
      is_public: false,
    });
    mockUpdateProfile.mockResolvedValue({ id: 'profile-456', is_public: true });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_xyz',
      orgName: 'Existing Org',
      source: 'stripe:invoice.paid',
    });

    expect(result.action).toBe('published');
    expect(result.profileId).toBe('profile-456');

    expect(mockUpdateProfile).toHaveBeenCalledWith('profile-456', { is_public: true });
    expect(mockCreateProfile).not.toHaveBeenCalled();
    expect(mockRecordProfilePublishedIfNeeded).toHaveBeenCalledWith(
      'org_xyz', false, true, 'stripe:invoice.paid',
    );
  });

  test('is idempotent when profile is already public', async () => {
    mockGetProfileByOrgId.mockResolvedValue({
      id: 'profile-789',
      is_public: true,
    });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_qrs',
      orgName: 'Already Published Org',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.action).toBe('noop');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockCreateProfile).not.toHaveBeenCalled();
    expect(mockRecordProfilePublishedIfNeeded).not.toHaveBeenCalled();
  });

  test('adds numeric suffix when base slug is taken', async () => {
    mockGetProfileByOrgId.mockResolvedValue(null);
    // First call: base slug taken. Next call: -2 suffix available.
    mockIsSlugAvailable
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockCreateProfile.mockResolvedValue({ id: 'p-new', slug: 'acme-2' });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_dup',
      orgName: 'Acme',
      source: 'stripe:customer.subscription.created',
    });

    expect(result.slug).toBe('acme-2');
    expect(mockCreateProfile).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'acme-2',
    }));
  });

  test('falls back to "member" when org name slugifies to empty', async () => {
    mockGetProfileByOrgId.mockResolvedValue(null);
    mockIsSlugAvailable.mockResolvedValue(true);
    mockCreateProfile.mockResolvedValue({ id: 'p-empty', slug: 'member' });

    const result = await ensureMemberProfilePublished({
      orgId: 'org_empty',
      orgName: '!!!',
      source: 'stripe:customer.subscription.created',
    });

    expect(mockCreateProfile).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'member',
    }));
    expect(result.slug).toBe('member');
  });

  test('propagates source tag into the profile-published activity', async () => {
    mockGetProfileByOrgId.mockResolvedValue({ id: 'p-1', is_public: false });
    mockUpdateProfile.mockResolvedValue({ id: 'p-1', is_public: true });

    await ensureMemberProfilePublished({
      orgId: 'org_src',
      orgName: 'Source Test',
      source: 'stripe:invoice.paid',
    });

    expect(mockRecordProfilePublishedIfNeeded).toHaveBeenCalledWith(
      'org_src', false, true, 'stripe:invoice.paid',
    );
  });
});
