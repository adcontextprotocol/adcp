import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeEngagementTier } from '../../src/services/account-lifecycle.js';

describe('computeEngagementTier', () => {
  it('keeps an active subscription in the member tier when cancellation is scheduled', () => {
    expect(computeEngagementTier({
      subscription_status: 'active',
      subscription_canceled_at: new Date('2026-09-01T00:00:00Z'),
    })).toBe('member');
  });

  it('treats a trialing subscription as a member', () => {
    expect(computeEngagementTier({
      subscription_status: 'trialing',
    })).toBe('member');
  });

  it('falls back to user engagement when there is no active subscription', () => {
    expect(computeEngagementTier({
      subscription_status: null,
      has_users: true,
      has_engaged_users: true,
    })).toBe('engaged');

    expect(computeEngagementTier({
      subscription_status: null,
      has_users: true,
      has_engaged_users: false,
    })).toBe('registered');
  });
});

describe('admin account lifecycle badge', () => {
  const source = readFileSync(
    join(process.cwd(), 'server/public/admin-account-detail.html'),
    'utf8',
  );

  it('labels every engagement tier without falling back to prospect', () => {
    expect(source).toContain("engaged: 'Active'");
    expect(source).toContain("registered: 'Registered'");
    expect(source).toContain("statusLabels[a.member_status] || 'Unknown'");
    expect(source).toContain('.member-badge.engaged');
    expect(source).toContain('.member-badge.registered');
  });
});
