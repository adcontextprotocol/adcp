import { describe, it, expect } from 'vitest';
import { pickNudge } from '../../src/addie/services/digest-nudge.js';
import type { DigestEmailRecipient } from '../../src/db/digest-db.js';

function recipient(overrides: Partial<DigestEmailRecipient> = {}): DigestEmailRecipient {
  return {
    workos_user_id: 'user_x',
    email: 'x@y.co',
    first_name: 'Test',
    has_slack: true,
    persona: null,
    journey_stage: null,
    seat_type: 'community',
    wg_count: 1,
    cert_modules_completed: 0,
    cert_total_modules: 8,
    is_member: true,
    has_profile: true,
    ...overrides,
  };
}

describe('pickNudge (CTA registry-backed)', () => {
  describe('digest-only CTAs', () => {
    it('returns become-member nudge for non-member without Slack', () => {
      const n = pickNudge(recipient({ is_member: false, has_slack: false }));
      expect(n?.ctaLabel).toBe('Become a member');
      expect(n?.text).toContain('1,300+');
    });

    it('returns join-Slack nudge for member without Slack', () => {
      const n = pickNudge(recipient({ is_member: true, has_slack: false }));
      expect(n?.ctaLabel).toBe('Join Slack');
    });

    it('returns contributor-cert nudge for paying contributor with no cert progress', () => {
      const n = pickNudge(recipient({ seat_type: 'contributor', cert_modules_completed: 0 }));
      expect(n?.ctaLabel).toBe('Start certification');
    });
  });

  describe('cross-cut CTAs migrated from rule registry', () => {
    it('returns cert nudge with module count when learner is mid-track', () => {
      const n = pickNudge(recipient({ cert_modules_completed: 2, cert_total_modules: 8 }));
      expect(n?.ctaLabel).toBe('Continue learning');
      expect(n?.text).toContain('2 modules in');
      expect(n?.text).toContain('6 to go');
    });

    it('handles cert text grammar for exactly one completed module', () => {
      const n = pickNudge(recipient({ cert_modules_completed: 1, cert_total_modules: 8 }));
      expect(n?.text).toContain('1 module in');
      expect(n?.text).not.toContain('1 modules');
    });

    it('returns WG nudge for member in Slack with no working groups', () => {
      const n = pickNudge(recipient({ wg_count: 0 }));
      expect(n?.ctaLabel).toBe('Browse working groups');
    });

    it('does not surface WG nudge for users without Slack', () => {
      const n = pickNudge(recipient({ wg_count: 0, has_slack: false, is_member: true }));
      expect(n?.ctaLabel).not.toBe('Browse working groups');
    });

    it('returns profile nudge when member has no public profile', () => {
      const n = pickNudge(recipient({ has_profile: false }));
      expect(n?.ctaLabel).toBe('Update your profile');
    });

    it('does not surface profile nudge for non-members', () => {
      const n = pickNudge(recipient({ has_profile: false, is_member: false }));
      expect(n?.ctaLabel).not.toBe('Update your profile');
    });
  });

  describe('priority ordering', () => {
    it('non-member with no slack and no cert beats other states (priority 1)', () => {
      const n = pickNudge(recipient({
        is_member: false,
        has_slack: false,
        wg_count: 0,
        has_profile: false,
        cert_modules_completed: 0,
      }));
      expect(n?.ctaLabel).toBe('Become a member');
    });

    it('cert-in-progress (priority 3) beats WG (4) and profile (6)', () => {
      const n = pickNudge(recipient({
        cert_modules_completed: 3,
        cert_total_modules: 8,
        wg_count: 0,
        has_profile: false,
      }));
      expect(n?.ctaLabel).toBe('Continue learning');
    });

    it('WG (priority 4) beats profile (6) when both apply', () => {
      const n = pickNudge(recipient({ wg_count: 0, has_profile: false }));
      expect(n?.ctaLabel).toBe('Browse working groups');
    });

    it('profile (priority 6) is reachable when nothing higher fires', () => {
      const n = pickNudge(recipient({
        has_profile: false,
        cert_modules_completed: 0,
        cert_total_modules: 0,
        wg_count: 1,
      }));
      expect(n?.ctaLabel).toBe('Update your profile');
    });

    it('returns null for a fully-engaged recipient with no actionable gaps', () => {
      const n = pickNudge(recipient({
        is_member: true,
        has_slack: true,
        has_profile: true,
        wg_count: 2,
        seat_type: 'community',
        cert_modules_completed: 0,
        cert_total_modules: 0,
      }));
      expect(n).toBeNull();
    });
  });
});
