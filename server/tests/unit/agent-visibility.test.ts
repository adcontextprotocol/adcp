import { describe, it, expect } from 'vitest';
import {
  hasApiAccess,
  API_ACCESS_TIERS,
  type MembershipTier,
} from '../../src/db/organization-db.js';
import {
  isValidAgentVisibility,
  VALID_AGENT_VISIBILITIES,
} from '../../src/types.js';

describe('hasApiAccess', () => {
  it('returns true for Professional tier', () => {
    expect(hasApiAccess('individual_professional')).toBe(true);
  });

  it('returns true for all company tiers', () => {
    const companyTiers: MembershipTier[] = [
      'company_standard',
      'company_icl',
      'company_leader',
    ];
    for (const tier of companyTiers) {
      expect(hasApiAccess(tier)).toBe(true);
    }
  });

  it('returns false for Explorer (individual_academic)', () => {
    expect(hasApiAccess('individual_academic')).toBe(false);
  });

  it('returns false for null / undefined tier (non-paying)', () => {
    expect(hasApiAccess(null)).toBe(false);
    expect(hasApiAccess(undefined)).toBe(false);
  });

  it('API_ACCESS_TIERS excludes Explorer', () => {
    expect(API_ACCESS_TIERS).not.toContain('individual_academic');
    expect(API_ACCESS_TIERS).toContain('individual_professional');
  });
});

describe('agent visibility type guard', () => {
  it('accepts the three valid values', () => {
    expect(isValidAgentVisibility('private')).toBe(true);
    expect(isValidAgentVisibility('members_only')).toBe(true);
    expect(isValidAgentVisibility('public')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isValidAgentVisibility('unlisted')).toBe(false);
    expect(isValidAgentVisibility('members')).toBe(false);
    expect(isValidAgentVisibility('')).toBe(false);
    expect(isValidAgentVisibility(null)).toBe(false);
    expect(isValidAgentVisibility(undefined)).toBe(false);
    expect(isValidAgentVisibility(true)).toBe(false);
  });

  it('VALID_AGENT_VISIBILITIES lists exactly three tiers', () => {
    expect(VALID_AGENT_VISIBILITIES).toEqual(['private', 'members_only', 'public']);
  });
});
