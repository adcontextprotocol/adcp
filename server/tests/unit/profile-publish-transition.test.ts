import { describe, it, expect } from 'vitest';
import { isProfilePublishTransition } from '../../src/services/profile-publish-event.js';

describe('isProfilePublishTransition', () => {
  it('fires on false → true', () => {
    expect(isProfilePublishTransition(false, true)).toBe(true);
  });

  it('fires on null → true (first-time publish with no prior state)', () => {
    expect(isProfilePublishTransition(null, true)).toBe(true);
  });

  it('fires on undefined → true', () => {
    expect(isProfilePublishTransition(undefined, true)).toBe(true);
  });

  it('does not fire on true → true (already public)', () => {
    expect(isProfilePublishTransition(true, true)).toBe(false);
  });

  it('does not fire on true → false (unpublish)', () => {
    expect(isProfilePublishTransition(true, false)).toBe(false);
  });

  it('does not fire on false → false (no change)', () => {
    expect(isProfilePublishTransition(false, false)).toBe(false);
  });

  it('does not fire when next is null or undefined (field not in update)', () => {
    expect(isProfilePublishTransition(false, null)).toBe(false);
    expect(isProfilePublishTransition(false, undefined)).toBe(false);
    expect(isProfilePublishTransition(true, undefined)).toBe(false);
  });
});
