import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatMemberContextForPrompt, MemberContext } from '../../src/addie/member-context.js';

/**
 * Member Context Unit Tests
 *
 * Tests for the member context formatting functions used by Addie.
 * These tests don't require database access since they test pure functions.
 */

describe('formatMemberContextForPrompt', () => {
  it('should return null for unmapped users', () => {
    const context: MemberContext = {
      is_mapped: false,
      is_member: false,
      slack_linked: false,
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toBeNull();
  });

  it('should include user name from workos_user', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
        last_name: 'Doe',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('John');
    expect(result).toContain('## User Context');
  });

  it('should fall back to slack display name if no workos first name', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      slack_linked: true,
      slack_user: {
        slack_user_id: 'U123',
        display_name: 'JohnD',
        email: 'john@example.com',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('JohnD');
  });

  it('should include organization info for members', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      organization: {
        workos_organization_id: 'org_123',
        name: 'Acme Corp',
        subscription_status: 'active',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Acme Corp');
    expect(result).toContain('active AgenticAdvertising.org member');
  });

  it('should indicate non-member status', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      organization: {
        workos_organization_id: 'org_123',
        name: 'Acme Corp',
        subscription_status: null,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('not currently an AgenticAdvertising.org member');
  });

  it('should include member profile details', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      organization: {
        workos_organization_id: 'org_123',
        name: 'Acme Corp',
        subscription_status: 'active',
      },
      member_profile: {
        display_name: 'Acme Corporation',
        tagline: 'Leading the ad tech revolution',
        offerings: ['DSP', 'SSP', 'DMP'],
        headquarters: 'New York, NY',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Leading the ad tech revolution');
    expect(result).toContain('DSP');
    expect(result).toContain('SSP');
    expect(result).toContain('DMP');
    expect(result).toContain('New York, NY');
  });

  it('should include subscription details', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      subscription: {
        status: 'active',
        product_name: 'Annual Membership',
        current_period_end: new Date('2025-12-31'),
        cancel_at_period_end: false,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Subscription Details');
    expect(result).toContain('active');
    expect(result).toContain('Annual Membership');
    expect(result).toContain('December');
  });

  it('should note when subscription is set to cancel', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      subscription: {
        status: 'active',
        product_name: 'Monthly',
        current_period_end: new Date('2025-02-01'),
        cancel_at_period_end: true,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('cancel at period end');
  });

  it('should include engagement signals', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      engagement: {
        login_count_30d: 15,
        last_login: new Date('2025-01-15'),
        working_group_count: 3,
        email_click_count_30d: 5,
        interest_level: 'high',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Organization Engagement');
    expect(result).toContain('15');
    expect(result).toContain('high');
  });

  it('should include Slack activity', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      slack_activity: {
        total_messages_30d: 42,
        total_reactions_30d: 18,
        total_thread_replies_30d: 7,
        active_days_30d: 12,
        last_activity_at: new Date('2025-01-20'),
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Slack Activity');
    expect(result).toContain('42');
    expect(result).toContain('18');
    expect(result).toContain('12');
  });

  it('should include org membership details', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      org_membership: {
        role: 'admin',
        member_count: 5,
        joined_at: new Date('2024-06-15'),
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Organization Membership');
    expect(result).toContain('admin');
    expect(result).toContain('5 users');
  });

  it('should include working groups', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      working_groups: [
        { name: 'Measurement', is_leader: true },
        { name: 'Creative', is_leader: false },
      ],
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Working Groups');
    expect(result).toContain('Measurement');
    expect(result).toContain('(leader)');
    expect(result).toContain('Creative');
  });

  it('should include email preferences', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      email_status: {
        global_unsubscribed: false,
        subscribed_categories: ['newsletter', 'product-updates'],
        unsubscribed_categories: ['marketing'],
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Email Preferences');
    expect(result).toContain('newsletter');
    expect(result).toContain('product-updates');
  });

  it('should note global unsubscribe status', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      email_status: {
        global_unsubscribed: true,
        subscribed_categories: [],
        unsubscribed_categories: [],
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Globally unsubscribed');
  });

  it('should note when Slack is not linked', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Slack account is not yet linked');
  });

  it('should not note Slack linking when already linked', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      slack_user: {
        slack_user_id: 'U123',
        display_name: 'John',
        email: 'john@example.com',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).not.toContain('Slack account is not yet linked');
  });

  it('should include Addie interaction history', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      addie_history: {
        total_interactions: 10,
        last_interaction_at: new Date('2025-01-18'),
        recent_topics: [
          'How do I set up VAST creatives?',
          'What is the difference between DSP and SSP?',
          'How do I join a working group?',
        ],
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Previous Conversations with Addie');
    expect(result).toContain('10');
    expect(result).toContain('VAST creatives');
  });

  it('should truncate long topic strings', () => {
    const longTopic = 'A'.repeat(120);
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
      addie_history: {
        total_interactions: 1,
        last_interaction_at: new Date(),
        recent_topics: [longTopic],
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('...');
    expect(result).not.toContain('A'.repeat(120));
  });

  it('should end with personalization reminder', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      slack_linked: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'john@example.com',
        first_name: 'John',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Use this context to personalize your response');
  });
});

describe('MemberContext interface completeness', () => {
  it('should handle a fully populated context object', () => {
    const fullContext: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      slack_user: {
        slack_user_id: 'U123456',
        display_name: 'John D.',
        email: 'john@example.com',
      },
      workos_user: {
        workos_user_id: 'user_workos123',
        email: 'john@example.com',
        first_name: 'John',
        last_name: 'Doe',
      },
      organization: {
        workos_organization_id: 'org_123',
        name: 'Acme Corporation',
        subscription_status: 'active',
      },
      member_profile: {
        display_name: 'Acme Corp',
        tagline: 'Innovating ad tech since 2020',
        offerings: ['DSP', 'SSP', 'Data Platform'],
        headquarters: 'San Francisco, CA',
      },
      subscription: {
        status: 'active',
        product_name: 'Enterprise Annual',
        current_period_end: new Date('2025-12-31'),
        cancel_at_period_end: false,
      },
      engagement: {
        login_count_30d: 25,
        last_login: new Date('2025-01-20'),
        working_group_count: 4,
        email_click_count_30d: 12,
        interest_level: 'very high',
      },
      slack_activity: {
        total_messages_30d: 150,
        total_reactions_30d: 45,
        total_thread_replies_30d: 30,
        active_days_30d: 20,
        last_activity_at: new Date('2025-01-21'),
      },
      org_membership: {
        role: 'admin',
        member_count: 8,
        joined_at: new Date('2024-01-15'),
      },
      working_groups: [
        { name: 'Protocol Development', is_leader: true },
        { name: 'Creative Specs', is_leader: false },
        { name: 'Measurement', is_leader: false },
      ],
      email_status: {
        global_unsubscribed: false,
        subscribed_categories: ['newsletter', 'working-group-updates', 'product-updates'],
        unsubscribed_categories: [],
      },
      addie_history: {
        total_interactions: 50,
        last_interaction_at: new Date('2025-01-19'),
        recent_topics: [
          'How do I implement the MCP protocol?',
          'What creative formats are supported?',
          'Help with VAST troubleshooting',
        ],
      },
      community_profile: {
        is_public: true,
        slug: 'john-doe',
        completeness: 70,
        github_username: 'johndoe',
      },
    };

    const result = formatMemberContextForPrompt(fullContext);

    // Verify all sections are present
    expect(result).toContain('## User Context');
    expect(result).toContain('### Subscription Details');
    expect(result).toContain('### Organization Engagement');
    expect(result).toContain('### Slack Activity');
    expect(result).toContain('### Organization Membership');
    expect(result).toContain('### Working Groups');
    expect(result).toContain('### Email Preferences');
    expect(result).toContain('### Previous Conversations with Addie');

    // Verify key data points
    expect(result).toContain('John');
    expect(result).toContain('Acme Corporation');
    expect(result).toContain('Protocol Development');
    expect(result).toContain('(leader)');
    expect(result).toContain('Enterprise Annual');
    expect(result).not.toContain('Slack account is not yet linked'); // Should NOT appear since slack_linked is true

    // Verify community profile section
    expect(result).toContain('Community profile: Public');
    expect(result).toContain('john-doe');
    expect(result).toContain('GitHub: johndoe');
  });
});

describe('community_profile formatting', () => {
  it('should show public profile with GitHub username', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Test',
      },
      community_profile: {
        is_public: true,
        slug: 'test-user',
        completeness: 80,
        github_username: 'testuser',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Community profile: Public (80% complete)');
    expect(result).toContain('/community/people/test-user');
    expect(result).toContain('GitHub: testuser');
    expect(result).not.toContain('Not linked');
  });

  it('should show non-public profile with encouragement', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Test',
      },
      community_profile: {
        is_public: false,
        slug: null,
        completeness: 20,
        github_username: null,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Community profile: Not yet public');
    expect(result).toContain('Encourage them to visit');
    expect(result).toContain('GitHub: Not linked');
    expect(result).toContain('suggest linking their GitHub username');
  });

  it('should show GitHub nudge when username is missing on public profile', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Test',
      },
      community_profile: {
        is_public: true,
        slug: 'test-user',
        completeness: 60,
        github_username: null,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Community profile: Public');
    expect(result).toContain('GitHub: Not linked');
    expect(result).toContain('/community/profile/edit');
  });
});
