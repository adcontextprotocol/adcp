import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberDatabase } from '../../src/db/member-db.js';
import { createAdminToolHandlers } from '../../src/addie/mcp/admin-tools.js';
import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';
import type { MemberContext } from '../../src/addie/member-context.js';

afterEach(() => vi.restoreAllMocks());

describe('member profile tool URL write boundaries', () => {
  it('rejects credential-bearing URLs in the admin profile tool before writing', async () => {
    vi.spyOn(MemberDatabase.prototype, 'getProfileBySlug').mockResolvedValue({
      id: 'profile-1',
      slug: 'acme',
      display_name: 'Acme',
    } as any);
    const update = vi.spyOn(MemberDatabase.prototype, 'updateProfile');

    const result = await createAdminToolHandlers().get('update_member_profile')!({
      slug: 'acme',
      contact_website: 'https://user:password@example.com/',
    });

    expect(result).toContain('without embedded credentials');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects oversized URLs in the member listing tool before writing', async () => {
    const memberContext = {
      workos_user: {
        workos_user_id: 'user-1',
        email: 'user@example.com',
      },
    } as MemberContext;

    const result = await createMemberToolHandlers(memberContext).get('update_company_listing')!({
      linkedin_url: `https://example.com/${'a'.repeat(2048)}`,
    });

    expect(result).toContain('2048 characters or fewer');
  });

  it('rejects credential-bearing URLs in the personal community-profile tool', async () => {
    const memberContext = {
      workos_user: {
        workos_user_id: 'user-1',
        email: 'user@example.com',
      },
    } as MemberContext;

    const result = await createMemberToolHandlers(memberContext).get('update_my_profile')!({
      linkedin_url: 'https://user:password@example.com/profile',
    });

    expect(result).toContain('without embedded credentials');
  });

  it('preserves empty-string clearing as null in the admin profile tool', async () => {
    vi.spyOn(MemberDatabase.prototype, 'getProfileBySlug').mockResolvedValue({
      id: 'profile-1',
      slug: 'acme',
      display_name: 'Acme',
    } as any);
    const update = vi.spyOn(MemberDatabase.prototype, 'updateProfile').mockResolvedValue({} as any);

    await createAdminToolHandlers().get('update_member_profile')!({
      slug: 'acme',
      linkedin_url: '',
    });

    expect(update).toHaveBeenCalledWith('profile-1', expect.objectContaining({ linkedin_url: null }));
  });
});
