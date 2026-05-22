/**
 * Guards the WorkOS → DB → Slack fallback cascade. The cascade is what would
 * have saved Tom Hespos and the 12 other learners from being silently issued
 * credentials with empty recipient names (escalation #382): 8 of 11 of those
 * users already had a Slack mapping with `slack_real_name`, but the OAuth
 * callback never looked at it.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveUserNameWithFallbacks, splitFullName, sanitizeName } from '../../src/utils/resolve-user-name.js';

type Row = {
  first_name: string | null;
  last_name: string | null;
  slack_real_name: string | null;
  slack_display_name: string | null;
};

function fakeDb(row: Row | null) {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }),
  };
}

describe('sanitizeName', () => {
  it('strips Unicode direction-override characters', () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) — a spoofing surface on certificates
    expect(sanitizeName('Tom‮Hespos')).toBe('TomHespos');
  });

  it('strips zero-width space', () => {
    expect(sanitizeName('Tom​Hespos')).toBe('TomHespos');
  });

  it('strips C0 controls and DEL', () => {
    expect(sanitizeName('Tom\x00\x07\x1f\x7fHespos')).toBe('TomHespos');
  });

  it('collapses internal whitespace but preserves multi-word names', () => {
    expect(sanitizeName('Mary   Jane  Watson')).toBe('Mary Jane Watson');
  });

  it('caps at 255 characters', () => {
    const result = sanitizeName('A'.repeat(300));
    expect(result.length).toBe(255);
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeName('   \t\n   ')).toBe('');
  });
});

describe('splitFullName', () => {
  it('splits two-part names', () => {
    expect(splitFullName('Tom Hespos')).toEqual({ firstName: 'Tom', lastName: 'Hespos' });
  });

  it('treats tab as whitespace, returning a clean last name', () => {
    expect(splitFullName('Tom\tHespos')).toEqual({ firstName: 'Tom', lastName: 'Hespos' });
  });

  it('collapses double-space without leaving a leading space in last name', () => {
    expect(splitFullName('Tom  Hespos')).toEqual({ firstName: 'Tom', lastName: 'Hespos' });
  });

  it('returns null last name for single-word input', () => {
    expect(splitFullName('Cher')).toEqual({ firstName: 'Cher', lastName: null });
  });

  it('joins three+ word names into the last-name slot', () => {
    expect(splitFullName('Daniel Di Tullio')).toEqual({ firstName: 'Daniel', lastName: 'Di Tullio' });
  });

  it('strips a Unicode direction-override from a Slack-controlled name', () => {
    // Without stripping, "Tom‮Hespos" would render reversed on a PDF
    expect(splitFullName('Tom‮ Hespos')).toEqual({ firstName: 'Tom', lastName: 'Hespos' });
  });

  it('returns empty pair for empty or whitespace-only input', () => {
    expect(splitFullName('')).toEqual({ firstName: '', lastName: null });
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: null });
  });
});

describe('resolveUserNameWithFallbacks', () => {
  it('uses WorkOS values when both are set', async () => {
    const db = fakeDb(null);
    const out = await resolveUserNameWithFallbacks(db, 'user_1', 'Tom', 'Hespos');
    expect(out).toEqual({ firstName: 'Tom', lastName: 'Hespos' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('preserves existing DB names when WorkOS sends null', async () => {
    const db = fakeDb({
      first_name: 'Existing',
      last_name: 'Name',
      slack_real_name: null,
      slack_display_name: null,
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', null, null);
    expect(out).toEqual({ firstName: 'Existing', lastName: 'Name' });
  });

  it('falls back to slack_real_name when WorkOS + DB are both empty', async () => {
    const db = fakeDb({
      first_name: null,
      last_name: null,
      slack_real_name: 'Lillie Ratliff',
      slack_display_name: 'lillie',
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', null, null);
    expect(out).toEqual({ firstName: 'Lillie', lastName: 'Ratliff' });
  });

  it('falls back to slack_display_name when real_name is missing', async () => {
    const db = fakeDb({
      first_name: null,
      last_name: null,
      slack_real_name: null,
      slack_display_name: 'Daniel Di Tullio',
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', null, null);
    expect(out).toEqual({ firstName: 'Daniel', lastName: 'Di Tullio' });
  });

  it('handles single-word Slack names without inventing a last name', async () => {
    const db = fakeDb({
      first_name: null,
      last_name: null,
      slack_real_name: 'Cher',
      slack_display_name: null,
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', null, null);
    expect(out).toEqual({ firstName: 'Cher', lastName: null });
  });

  it('keeps WorkOS first when only the last is empty', async () => {
    const db = fakeDb({
      first_name: 'DBfirst',
      last_name: 'DBlast',
      slack_real_name: 'Slack Name',
      slack_display_name: null,
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', 'Davide', null);
    // Slack fallback only triggers when BOTH are empty after DB merge; here
    // the DB had a last name, so we take WorkOS first + DB last.
    expect(out).toEqual({ firstName: 'Davide', lastName: 'DBlast' });
  });

  it('returns null pair when nothing is available anywhere', async () => {
    const db = fakeDb({
      first_name: null,
      last_name: null,
      slack_real_name: null,
      slack_display_name: null,
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', null, null);
    expect(out).toEqual({ firstName: null, lastName: null });
  });

  it('returns input WorkOS values when the user row does not exist yet', async () => {
    const db = fakeDb(null);
    const out = await resolveUserNameWithFallbacks(db, 'user_new', null, null);
    expect(out).toEqual({ firstName: null, lastName: null });
  });

  it('treats whitespace-only WorkOS names as empty', async () => {
    const db = fakeDb({
      first_name: null,
      last_name: null,
      slack_real_name: 'Sydney Fuhrman',
      slack_display_name: null,
    });
    const out = await resolveUserNameWithFallbacks(db, 'user_1', '   ', '   ');
    expect(out).toEqual({ firstName: 'Sydney', lastName: 'Fuhrman' });
  });
});
