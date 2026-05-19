/**
 * Guards the WorkOS → DB → Slack fallback cascade. The cascade is what would
 * have saved Tom Hespos and the 12 other learners from being silently issued
 * credentials with empty recipient names (escalation #382): 8 of 11 of those
 * users already had a Slack mapping with `slack_real_name`, but the OAuth
 * callback never looked at it.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveUserNameWithFallbacks } from '../../src/utils/resolve-user-name.js';

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
