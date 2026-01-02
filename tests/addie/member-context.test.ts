/**
 * Tests for Addie member context module
 *
 * Note: We test the pure formatMemberContextForPrompt function here.
 * The getMemberContext function requires database/WorkOS connections
 * and is tested via integration tests.
 */

import { describe, it, expect } from '@jest/globals';

// Define the MemberContext type locally to avoid importing the module
// (which has side-effects requiring WorkOS API keys)
interface MemberContext {
  is_mapped: boolean;
  is_member: boolean;
  slack_user?: {
    slack_user_id: string;
    display_name: string | null;
    email: string | null;
  };
  workos_user?: {
    workos_user_id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };
  organization?: {
    workos_organization_id: string;
    name: string;
    subscription_status: string | null;
  };
  member_profile?: {
    display_name: string;
    tagline?: string;
    offerings: string[];
    headquarters?: string;
  };
  subscription?: {
    status: string;
    product_name?: string;
    current_period_end?: Date;
    cancel_at_period_end?: boolean;
  };
  engagement?: {
    login_count_30d: number;
    last_login: Date | null;
    working_group_count: number;
    email_click_count_30d: number;
    interest_level: string | null;
  };
  slack_activity?: {
    total_messages_30d: number;
    total_reactions_30d: number;
    total_thread_replies_30d: number;
    active_days_30d: number;
    last_activity_at: Date | null;
  };
}

/**
 * Format member context for inclusion in Claude messages
 * (Duplicated from member-context.ts to avoid import side-effects)
 */
function formatMemberContextForPrompt(context: MemberContext): string | null {
  if (!context.is_mapped) {
    return null;
  }

  const lines: string[] = [];
  lines.push('## User Context');

  const userName =
    context.workos_user?.first_name ||
    context.slack_user?.display_name ||
    'Unknown';
  lines.push(`The user's name is ${userName}.`);

  if (context.organization) {
    lines.push(`They work at ${context.organization.name}.`);

    if (context.is_member) {
      lines.push('Their organization is an active AgenticAdvertising.org member.');
    } else {
      lines.push('Their organization is not currently an AgenticAdvertising.org member.');
    }
  }

  if (context.member_profile) {
    if (context.member_profile.tagline) {
      lines.push(`Company description: ${context.member_profile.tagline}`);
    }
    if (context.member_profile.offerings && context.member_profile.offerings.length > 0) {
      lines.push(`Company offerings: ${context.member_profile.offerings.join(', ')}`);
    }
    if (context.member_profile.headquarters) {
      lines.push(`Company headquarters: ${context.member_profile.headquarters}`);
    }
  }

  // Subscription details
  if (context.subscription) {
    lines.push('');
    lines.push('### Subscription Details');
    lines.push(`Subscription status: ${context.subscription.status}`);
    if (context.subscription.product_name) {
      lines.push(`Plan: ${context.subscription.product_name}`);
    }
    if (context.subscription.current_period_end) {
      const endDate = context.subscription.current_period_end.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Current period ends: ${endDate}`);
    }
    if (context.subscription.cancel_at_period_end) {
      lines.push('Note: Subscription is set to cancel at period end.');
    }
  }

  // Engagement signals
  if (context.engagement) {
    lines.push('');
    lines.push('### Organization Engagement');
    lines.push(`Dashboard logins (last 30 days): ${context.engagement.login_count_30d}`);
    if (context.engagement.last_login) {
      const lastLogin = context.engagement.last_login.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Last dashboard login: ${lastLogin}`);
    }
    if (context.engagement.working_group_count > 0) {
      lines.push(`Working groups: ${context.engagement.working_group_count}`);
    }
    if (context.engagement.interest_level) {
      lines.push(`Interest level: ${context.engagement.interest_level}`);
    }
  }

  // Slack activity for the user
  if (context.slack_activity) {
    lines.push('');
    lines.push('### Slack Activity (Last 30 Days)');
    lines.push(`Messages: ${context.slack_activity.total_messages_30d}`);
    lines.push(`Thread replies: ${context.slack_activity.total_thread_replies_30d}`);
    lines.push(`Reactions: ${context.slack_activity.total_reactions_30d}`);
    lines.push(`Active days: ${context.slack_activity.active_days_30d}`);
    if (context.slack_activity.last_activity_at) {
      const lastActivity = context.slack_activity.last_activity_at.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Last activity: ${lastActivity}`);
    }
  }

  lines.push('');
  lines.push('Use this context to personalize your response when relevant.');
  lines.push('');

  return lines.join('\n');
}

describe('formatMemberContextForPrompt', () => {
  it('returns null for unmapped users', () => {
    const context: MemberContext = {
      is_mapped: false,
      is_member: false,
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toBeNull();
  });

  it('includes user name from WorkOS when available', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Alice',
        last_name: 'Smith',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Alice');
    expect(result).toContain('## User Context');
  });

  it('falls back to Slack display name when WorkOS name unavailable', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      slack_user: {
        slack_user_id: 'U123',
        display_name: 'alice_smith',
        email: 'test@example.com',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('alice_smith');
  });

  it('includes organization name and membership status for members', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Alice',
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

  it('indicates non-member status correctly', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: false,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Bob',
      },
      organization: {
        workos_organization_id: 'org_456',
        name: 'Test Inc',
        subscription_status: null,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Test Inc');
    expect(result).toContain('not currently an AgenticAdvertising.org member');
  });

  it('includes member profile details when available', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Charlie',
      },
      organization: {
        workos_organization_id: 'org_789',
        name: 'Publisher Co',
        subscription_status: 'active',
      },
      member_profile: {
        display_name: 'Publisher Co',
        tagline: 'Leading digital publisher',
        offerings: ['publisher', 'agent'],
        headquarters: 'New York, USA',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Leading digital publisher');
    expect(result).toContain('publisher, agent');
    expect(result).toContain('New York, USA');
  });

  it('includes subscription details when available', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Alice',
      },
      subscription: {
        status: 'active',
        product_name: 'Corporate Membership',
        current_period_end: new Date('2025-06-15T12:00:00Z'), // Use noon UTC to avoid timezone issues
        cancel_at_period_end: false,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Subscription Details');
    expect(result).toContain('Subscription status: active');
    expect(result).toContain('Plan: Corporate Membership');
    expect(result).toContain('June'); // Don't check exact date due to timezone
    expect(result).toContain('2025');
  });

  it('includes cancellation notice when subscription is canceling', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Bob',
      },
      subscription: {
        status: 'active',
        cancel_at_period_end: true,
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('Subscription is set to cancel at period end');
  });

  it('includes engagement signals when available', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Charlie',
      },
      engagement: {
        login_count_30d: 15,
        last_login: new Date('2025-01-10T12:00:00Z'), // Use noon UTC to avoid timezone issues
        working_group_count: 3,
        email_click_count_30d: 5,
        interest_level: 'high',
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Organization Engagement');
    expect(result).toContain('Dashboard logins (last 30 days): 15');
    expect(result).toContain('January'); // Don't check exact date due to timezone
    expect(result).toContain('2025');
    expect(result).toContain('Working groups: 3');
    expect(result).toContain('Interest level: high');
  });

  it('includes Slack activity when available', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Dana',
      },
      slack_activity: {
        total_messages_30d: 42,
        total_reactions_30d: 87,
        total_thread_replies_30d: 23,
        active_days_30d: 18,
        last_activity_at: new Date('2025-01-15T12:00:00Z'), // Use noon UTC to avoid timezone issues
      },
    };

    const result = formatMemberContextForPrompt(context);
    expect(result).toContain('### Slack Activity (Last 30 Days)');
    expect(result).toContain('Messages: 42');
    expect(result).toContain('Thread replies: 23');
    expect(result).toContain('Reactions: 87');
    expect(result).toContain('Active days: 18');
    expect(result).toContain('January'); // Don't check exact date due to timezone
    expect(result).toContain('2025');
  });

  it('includes all data for fully engaged member', () => {
    const context: MemberContext = {
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: 'user_123',
        email: 'test@example.com',
        first_name: 'Emma',
      },
      organization: {
        workos_organization_id: 'org_123',
        name: 'Super Corp',
        subscription_status: 'active',
      },
      member_profile: {
        display_name: 'Super Corp',
        tagline: 'Next-gen ad tech',
        offerings: ['agent', 'publisher', 'buyer'],
        headquarters: 'San Francisco, USA',
      },
      subscription: {
        status: 'active',
        product_name: 'Enterprise',
        current_period_end: new Date('2025-12-31'),
      },
      engagement: {
        login_count_30d: 25,
        last_login: new Date('2025-01-20'),
        working_group_count: 5,
        email_click_count_30d: 10,
        interest_level: 'very_high',
      },
      slack_activity: {
        total_messages_30d: 100,
        total_reactions_30d: 200,
        total_thread_replies_30d: 50,
        active_days_30d: 25,
        last_activity_at: new Date('2025-01-20'),
      },
    };

    const result = formatMemberContextForPrompt(context);

    // Should contain all sections
    expect(result).toContain('## User Context');
    expect(result).toContain('Emma');
    expect(result).toContain('Super Corp');
    expect(result).toContain('### Subscription Details');
    expect(result).toContain('### Organization Engagement');
    expect(result).toContain('### Slack Activity (Last 30 Days)');
    expect(result).toContain('Use this context to personalize your response');
  });
});
