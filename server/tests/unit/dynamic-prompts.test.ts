/**
 * Tests for buildDynamicSuggestedPrompts functionality
 *
 * Tests the role-based suggestion logic:
 * - Unlinked users see account setup prompts
 * - Admin users see admin-specific prompts
 * - Regular linked users see member prompts
 */

import { describe, it, expect } from 'vitest';
import { buildDynamicSuggestedPrompts } from '../../src/addie/prompts.js';
import type { MemberContext } from '../../src/addie/member-context.js';

describe('buildDynamicSuggestedPrompts', () => {
  describe('unlinked users', () => {
    it('should return account setup prompts for users without WorkOS mapping', () => {
      const memberContext = {
        is_mapped: false,
        is_member: false,
        slack_linked: false,
        workos_user: null,
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, false);

      expect(prompts).toHaveLength(3);
      expect(prompts[0].title).toBe('Link my account');
      expect(prompts[1].title).toBe('Learn about AdCP');
      expect(prompts[2].title).toBe('Why join AgenticAdvertising.org?');
    });

    it('should return account setup prompts for null member context', () => {
      const prompts = buildDynamicSuggestedPrompts(null, false);

      expect(prompts).toHaveLength(3);
      expect(prompts[0].title).toBe('Link my account');
    });

    it('should ignore admin flag for unlinked users', () => {
      const memberContext = {
        is_mapped: false,
        workos_user: null,
      } as unknown as MemberContext;

      // Even if admin flag is true, unlinked users get setup prompts
      const prompts = buildDynamicSuggestedPrompts(memberContext, true);

      expect(prompts[0].title).toBe('Link my account');
    });
  });

  describe('admin users', () => {
    it('should return admin-specific prompts for admin users', () => {
      const memberContext = {
        is_mapped: true,
        is_member: true,
        workos_user: { workos_user_id: 'user_admin123' },
        working_groups: [{ slug: 'aao-admin', name: 'AAO Admin' }],
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, true);

      expect(prompts).toHaveLength(4);
      expect(prompts[0].title).toBe('Pending invoices');
      expect(prompts[1].title).toBe('Look up a company');
      expect(prompts[2].title).toBe('Prospect pipeline');
      expect(prompts[3].title).toBe('My working groups');
    });

    it('should include admin-only actions in suggestions', () => {
      const memberContext = {
        is_mapped: true,
        workos_user: { workos_user_id: 'user_admin123' },
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, true);

      const titles = prompts.map((p) => p.title);
      expect(titles).toContain('Pending invoices');
      expect(titles).toContain('Look up a company');
      expect(titles).toContain('Prospect pipeline');
    });
  });

  describe('linked non-admin users', () => {
    it('should return member prompts with working groups for users in groups', () => {
      const memberContext = {
        is_mapped: true,
        is_member: true,
        workos_user: { workos_user_id: 'user_member123' },
        working_groups: [
          { slug: 'protocol-dev', name: 'Protocol Development' },
        ],
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, false);

      expect(prompts).toHaveLength(4);
      expect(prompts[0].title).toBe('My working groups');
      expect(prompts[1].title).toBe('Test my agent');
      expect(prompts[2].title).toBe('Learn about AdCP');
      expect(prompts[3].title).toBe('AdCP vs programmatic');
    });

    it('should suggest finding groups for users without working groups', () => {
      const memberContext = {
        is_mapped: true,
        is_member: true,
        workos_user: { workos_user_id: 'user_newmember' },
        working_groups: [],
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, false);

      expect(prompts[0].title).toBe('Find a working group');
    });

    it('should suggest finding groups for users with undefined working groups', () => {
      const memberContext = {
        is_mapped: true,
        workos_user: { workos_user_id: 'user_newmember' },
        working_groups: undefined,
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, false);

      expect(prompts[0].title).toBe('Find a working group');
    });

    it('should not include admin prompts for non-admin users', () => {
      const memberContext = {
        is_mapped: true,
        workos_user: { workos_user_id: 'user_member123' },
        working_groups: [],
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, false);

      const titles = prompts.map((p) => p.title);
      expect(titles).not.toContain('Pending invoices');
      expect(titles).not.toContain('Look up a company');
      expect(titles).not.toContain('Prospect pipeline');
    });
  });

  describe('prompt limits', () => {
    it('should return maximum 4 prompts (Slack limit)', () => {
      const memberContext = {
        is_mapped: true,
        workos_user: { workos_user_id: 'user_123' },
        working_groups: [{ slug: 'test', name: 'Test' }],
      } as unknown as MemberContext;

      const prompts = buildDynamicSuggestedPrompts(memberContext, false);

      expect(prompts.length).toBeLessThanOrEqual(4);
    });
  });
});
