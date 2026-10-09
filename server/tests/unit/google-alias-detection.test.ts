import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectGoogleAliasAccount } from '../../src/services/google-alias-detection.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ getPool: () => ({ query }) }));

const CLAIMED_ALIAS_READ =
  'SELECT 1 FROM user_email_aliases WHERE LOWER(email) = LOWER($1) LIMIT 1';

describe('automatic Google alias detection', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [] });
  });

  it.each([
    ['user_gmail', 'alex@gmail.com', 'user_googlemail', 'alex@googlemail.com'],
    ['user_googlemail', 'alex@googlemail.com', 'user_gmail', 'alex@gmail.com'],
  ])('records only a detection audit when %s signs in', async (id, email, otherId, otherEmail) => {
    query.mockResolvedValueOnce({ rows: [{ workos_user_id: otherId, email: otherEmail }] });
    const listUsers = vi.fn();

    expect(await detectGoogleAliasAccount({ id, email }, { listUsers })).toBe(otherEmail);

    expect(listUsers).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0].trim()).toMatch(/^SELECT u\.workos_user_id, u\.email FROM users u/);
    // The alias table is read only to keep the existing claimed-email exclusion.
    expect(query.mock.calls[0][0]).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM user_email_aliases a/);
    expect(query.mock.calls[0][0]).toContain('ORDER BY u.workos_user_id');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO registry_audit_log');
    expect(query.mock.calls[1][1]).toEqual([
      id, otherId, JSON.stringify({ outcome: 'support_review_required' }),
    ]);
    expect(query.mock.calls[1][1].join(' ')).not.toContain('@');
  });

  it('detects a provider-only account without creating a local credential or alias', async () => {
    const listUsers = vi.fn().mockResolvedValue({ data: [{ id: 'user_other', email: 'alex@googlemail.com' }] });
    const mutate = vi.fn(() => { throw new Error('Authority mutation forbidden'); });
    const provider = { listUsers, createOrganizationMembership: mutate, updateUser: mutate, deleteUser: mutate };

    expect(await detectGoogleAliasAccount({ id: 'user_signed_in', email: 'alex@gmail.com' }, provider))
      .toBe('alex@googlemail.com');
    expect(mutate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toBe(CLAIMED_ALIAS_READ);
    expect(query.mock.calls[1][1]).toEqual(['alex@googlemail.com']);
    expect(query.mock.calls[2][0]).toContain('INSERT INTO registry_audit_log');
  });

  it('skips provider candidates whose email is already a claimed alias and continues', async () => {
    const listUsers = vi.fn()
      .mockResolvedValueOnce({ data: [
        { id: 'user_claimed', email: 'alex@googlemail.com' },
        { id: 'user_unclaimed', email: 'alex2@googlemail.com' },
      ] });
    query.mockImplementation(async (sql: string, params: unknown[]) => ({
      rows: sql === CLAIMED_ALIAS_READ && params[0] === 'alex@googlemail.com' ? [{ '?column?': 1 }] : [],
    }));

    expect(await detectGoogleAliasAccount({ id: 'user_signed_in', email: 'alex@gmail.com' }, { listUsers }))
      .toBe('alex2@googlemail.com');
    const audits = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO registry_audit_log'));
    expect(audits).toHaveLength(1);
    expect(audits[0][1][1]).toBe('user_unclaimed');
  });

  it('records nothing when every provider candidate is a claimed alias', async () => {
    const listUsers = vi.fn().mockResolvedValue({ data: [{ id: 'user_claimed', email: 'alex@googlemail.com' }] });
    query.mockImplementation(async (sql: string) => ({
      rows: sql === CLAIMED_ALIAS_READ ? [{ '?column?': 1 }] : [],
    }));

    expect(await detectGoogleAliasAccount({ id: 'user_signed_in', email: 'alex@gmail.com' }, { listUsers }))
      .toBeNull();
    expect(listUsers.mock.calls.length).toBeGreaterThan(0);
    // Only reads: the local query and claimed-alias checks; no audit or other write.
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('does not write after a provider lookup failure', async () => {
    const listUsers = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    await expect(detectGoogleAliasAccount({ id: 'user_signed_in', email: 'alex@gmail.com' }, { listUsers }))
      .rejects.toThrow('provider unavailable');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not inspect non-Google addresses', async () => {
    const listUsers = vi.fn();
    expect(await detectGoogleAliasAccount({ id: 'user_signed_in', email: 'alex@example.com' }, { listUsers }))
      .toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('wires login to detection without automatic merge or authority mutation', () => {
    const source = readFileSync(new URL('../../src/http.ts', import.meta.url), 'utf8');
    const callback = source.slice(source.indexOf("this.app.get('/auth/callback'"), source.indexOf('// Check if user needs to accept (or re-accept) ToS'));
    expect(callback).toContain('if (workos) {');
    expect(callback).toContain('detectGoogleAliasAccount(user, workos.userManagement)');
    expect(callback).not.toMatch(/mergeUsers|createOrganizationMembership|INSERT INTO user_email_aliases/);
    const dashboard = readFileSync(new URL('../../public/dashboard.html', import.meta.url), 'utf8');
    expect(dashboard).not.toContain('accounts_merged');
    expect(dashboard).toContain('Your accounts remain separate.');
  });
});
