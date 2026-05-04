import { describe, it, expect } from 'vitest';
import {
  normalizeFoundingMemberGrant,
  foundingMemberFieldsTouched,
} from '../../src/services/founding-member-grant.js';
import type { UpdateMemberProfileInput } from '../../src/types.js';

describe('normalizeFoundingMemberGrant', () => {
  it('is a no-op when no founding fields are present', () => {
    const updates: UpdateMemberProfileInput = { display_name: 'X' };
    const err = normalizeFoundingMemberGrant(updates);
    expect(err).toBeNull();
    expect(updates).toEqual({ display_name: 'X' });
  });

  it('rejects is_founding_member=true without a source', () => {
    const updates: UpdateMemberProfileInput = { is_founding_member: true };
    const err = normalizeFoundingMemberGrant(updates);
    expect(err?.code).toBe('missing_source');
  });

  it('accepts a valid manual_grandfather grant and stamps granted_at server-side', () => {
    const before = Date.now();
    const updates: UpdateMemberProfileInput = {
      is_founding_member: true,
      founding_member_source: 'manual_grandfather',
      founding_member_granted_reason: 'site issues blocked enrollment',
    };
    const err = normalizeFoundingMemberGrant(updates);
    expect(err).toBeNull();
    expect(updates.founding_member_source).toBe('manual_grandfather');
    expect(updates.founding_member_granted_at).toBeInstanceOf(Date);
    const grantedAt = (updates.founding_member_granted_at as Date).getTime();
    expect(grantedAt).toBeGreaterThanOrEqual(before);
  });

  it('overrides any caller-supplied granted_at to prevent backdating', () => {
    const backdated = new Date('2026-03-01T00:00:00Z');
    const before = Date.now();
    const updates: UpdateMemberProfileInput = {
      is_founding_member: true,
      founding_member_source: 'manual_grandfather',
      founding_member_granted_at: backdated,
    };
    const err = normalizeFoundingMemberGrant(updates);
    expect(err).toBeNull();
    const stamped = updates.founding_member_granted_at as Date;
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).not.toBe(backdated.getTime());
  });

  it('rejects an unknown source value', () => {
    const updates = {
      is_founding_member: true,
      founding_member_source: 'bogus' as unknown as 'manual_grandfather',
    } satisfies UpdateMemberProfileInput;
    const err = normalizeFoundingMemberGrant(updates);
    expect(err?.code).toBe('invalid_source');
  });

  it('clears audit metadata when revoking founding status', () => {
    const updates: UpdateMemberProfileInput = {
      is_founding_member: false,
      founding_member_source: 'manual_grandfather',
      founding_member_granted_reason: 'no longer applies',
    };
    const err = normalizeFoundingMemberGrant(updates);
    expect(err).toBeNull();
    expect(updates.founding_member_source).toBeNull();
    expect(updates.founding_member_granted_at).toBeNull();
    expect(updates.founding_member_granted_reason).toBeNull();
  });

  it('rejects orphaned audit metadata without an is_founding_member flag', () => {
    const updates: UpdateMemberProfileInput = {
      founding_member_source: 'manual_grandfather',
    };
    const err = normalizeFoundingMemberGrant(updates);
    expect(err?.code).toBe('orphan_metadata');
  });
});

describe('foundingMemberFieldsTouched', () => {
  it('lists every founding column the helper wrote on grant', () => {
    const updates: UpdateMemberProfileInput = {
      is_founding_member: true,
      founding_member_source: 'manual_grandfather',
      founding_member_granted_reason: 'because',
    };
    normalizeFoundingMemberGrant(updates);
    expect(foundingMemberFieldsTouched(updates).sort()).toEqual([
      'founding_member_granted_at',
      'founding_member_granted_reason',
      'founding_member_source',
      'is_founding_member',
    ]);
  });

  it('lists the cleared columns on revoke', () => {
    const updates: UpdateMemberProfileInput = { is_founding_member: false };
    normalizeFoundingMemberGrant(updates);
    expect(foundingMemberFieldsTouched(updates).sort()).toEqual([
      'founding_member_granted_at',
      'founding_member_granted_reason',
      'founding_member_source',
      'is_founding_member',
    ]);
  });

  it('returns an empty list when nothing founding-related was set', () => {
    const updates: UpdateMemberProfileInput = { display_name: 'X' };
    normalizeFoundingMemberGrant(updates);
    expect(foundingMemberFieldsTouched(updates)).toEqual([]);
  });
});
