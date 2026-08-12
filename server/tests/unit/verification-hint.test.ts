import { describe, it, expect } from 'vitest';
import {
  pickStoryboardBlockingReason,
  pickVerificationHint,
} from '../../src/services/verification-hint.js';

describe('pickStoryboardBlockingReason', () => {
  it('uses failing before partial and untested regardless of row order', () => {
    expect(
      pickStoryboardBlockingReason([
        { status: 'untested' },
        { status: 'partial' },
        { status: 'failing' },
      ]),
    ).toBe('failing');
  });

  it('returns partial for partial-only and passing/partial results', () => {
    expect(pickStoryboardBlockingReason([{ status: 'partial' }])).toBe('partial');
    expect(
      pickStoryboardBlockingReason([{ status: 'passing' }, { status: 'partial' }]),
    ).toBe('partial');
  });

  it('returns untested for untested-only and passing/untested results', () => {
    expect(pickStoryboardBlockingReason([{ status: 'untested' }])).toBe('untested');
    expect(
      pickStoryboardBlockingReason([{ status: 'passing' }, { status: 'untested' }]),
    ).toBe('untested');
  });

  it('uses partial before untested for mixed non-failing results', () => {
    expect(
      pickStoryboardBlockingReason([{ status: 'untested' }, { status: 'partial' }]),
    ).toBe('partial');
  });

  it('returns undefined for missing, empty, or non-blocking results', () => {
    expect(pickStoryboardBlockingReason(undefined)).toBeUndefined();
    expect(pickStoryboardBlockingReason(null)).toBeUndefined();
    expect(pickStoryboardBlockingReason([])).toBeUndefined();
    expect(pickStoryboardBlockingReason([{ status: 'passing' }, {}])).toBeUndefined();
  });
});

describe('pickVerificationHint', () => {
  it('returns null when a badge already exists', () => {
    expect(
      pickVerificationHint({
        status: 'degraded',
        declaredSpecialismCount: 1,
        hasAuth: true,
        badgeCount: 1,
        storyboardBlockingReason: 'partial',
      }),
    ).toBeNull();
  });

  it('short-circuits to no_auth when auth is missing, even if cached status is passing', () => {
    expect(
      pickVerificationHint({
        status: 'degraded',
        declaredSpecialismCount: 1,
        hasAuth: false,
        badgeCount: 0,
        storyboardBlockingReason: 'partial',
      }),
    ).toBe('no_auth');
  });

  it('returns opted_out for opted_out status', () => {
    expect(
      pickVerificationHint({
        status: 'opted_out',
        declaredSpecialismCount: 0,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: 'partial',
      }),
    ).toBe('opted_out');
  });

  it('flags the silent failure: passing run but zero declared specialisms', () => {
    expect(
      pickVerificationHint({
        status: 'passing',
        declaredSpecialismCount: 0,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: 'partial',
      }),
    ).toBe('passing_no_specialisms');
  });

  it('returns passing_pending_heartbeat when passing with declared specialisms', () => {
    expect(
      pickVerificationHint({
        status: 'passing',
        declaredSpecialismCount: 2,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: 'untested',
      }),
    ).toBe('passing_pending_heartbeat');
  });

  it('returns storyboards_failing for failing status', () => {
    expect(
      pickVerificationHint({
        status: 'failing',
        declaredSpecialismCount: 1,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: 'failing',
      }),
    ).toBe('storyboards_failing');
  });

  it('returns the specific storyboard blocker for degraded status', () => {
    expect(
      pickVerificationHint({
        status: 'degraded',
        declaredSpecialismCount: 1,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: 'partial',
      }),
    ).toBe('storyboards_partial');
    expect(
      pickVerificationHint({
        status: 'degraded',
        declaredSpecialismCount: 1,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: 'untested',
      }),
    ).toBe('storyboards_untested');
  });

  it('retains the failing fallback when storyboard results are missing or empty', () => {
    expect(
      pickVerificationHint({ status: 'degraded', declaredSpecialismCount: 1, hasAuth: true, badgeCount: 0 }),
    ).toBe('storyboards_failing');
    expect(
      pickVerificationHint({
        status: 'degraded',
        declaredSpecialismCount: 1,
        hasAuth: true,
        badgeCount: 0,
        storyboardBlockingReason: pickStoryboardBlockingReason([]),
      }),
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
