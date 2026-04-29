import { describe, it, expect } from 'vitest';
import { pickVerificationHint } from '../../src/services/verification-hint.js';

describe('pickVerificationHint', () => {
  it('returns null when a badge already exists', () => {
    expect(
      pickVerificationHint({ status: 'passing', declaredSpecialismCount: 1, hasAuth: true, badgeCount: 1 }),
    ).toBeNull();
  });

  it('short-circuits to no_auth when auth is missing, even if cached status is passing', () => {
    expect(
      pickVerificationHint({ status: 'passing', declaredSpecialismCount: 1, hasAuth: false, badgeCount: 0 }),
    ).toBe('no_auth');
  });

  it('returns opted_out for opted_out status', () => {
    expect(
      pickVerificationHint({ status: 'opted_out', declaredSpecialismCount: 0, hasAuth: true, badgeCount: 0 }),
    ).toBe('opted_out');
  });

  it('flags the silent failure: passing run but zero declared specialisms', () => {
    expect(
      pickVerificationHint({ status: 'passing', declaredSpecialismCount: 0, hasAuth: true, badgeCount: 0 }),
    ).toBe('passing_no_specialisms');
  });

  it('returns passing_pending_heartbeat when passing with declared specialisms', () => {
    expect(
      pickVerificationHint({ status: 'passing', declaredSpecialismCount: 2, hasAuth: true, badgeCount: 0 }),
    ).toBe('passing_pending_heartbeat');
  });

  it('returns storyboards_failing for failing status', () => {
    expect(
      pickVerificationHint({ status: 'failing', declaredSpecialismCount: 1, hasAuth: true, badgeCount: 0 }),
    ).toBe('storyboards_failing');
  });

  it('returns storyboards_failing for degraded status', () => {
    expect(
      pickVerificationHint({ status: 'degraded', declaredSpecialismCount: 1, hasAuth: true, badgeCount: 0 }),
    ).toBe('storyboards_failing');
  });

  it('returns unknown_default for unknown status with auth', () => {
    expect(
      pickVerificationHint({ status: 'unknown', declaredSpecialismCount: 0, hasAuth: true, badgeCount: 0 }),
    ).toBe('unknown_default');
  });

  it('returns unknown_default for null/undefined status with auth', () => {
    expect(
      pickVerificationHint({ status: null, declaredSpecialismCount: 0, hasAuth: true, badgeCount: 0 }),
    ).toBe('unknown_default');
    expect(
      pickVerificationHint({ status: undefined, declaredSpecialismCount: 0, hasAuth: true, badgeCount: 0 }),
    ).toBe('unknown_default');
  });

  it('no_auth wins over opted_out (auth fix is the only useful next step)', () => {
    expect(
      pickVerificationHint({ status: 'opted_out', declaredSpecialismCount: 0, hasAuth: false, badgeCount: 0 }),
    ).toBe('no_auth');
  });
});
