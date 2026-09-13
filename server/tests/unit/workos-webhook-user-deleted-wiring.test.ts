import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Keep provider revocation wired without choosing a successor identity.
 * Runtime DB-seam tests separately prove that promotion refuses before writes.
 */

const WEBHOOK_FILE = path.resolve(__dirname, '../../src/routes/workos-webhooks.ts');
const webhookSource = fs.readFileSync(WEBHOOK_FILE, 'utf-8');

describe('user.deleted containment wiring (#6827)', () => {
  const userDeletedBlockMatch = webhookSource.match(
    /case 'user\.deleted':\s*\{([\s\S]*?)\n\s{10}\}/,
  );
  const block = userDeletedBlockMatch?.[1] ?? '';

  it('matched the user.deleted case body', () => {
    expect(block).not.toEqual('');
  });

  it('preserves credential revocation without promoting a successor', () => {
    expect(block).not.toContain('promoteSecondaryIfPrimaryDeleted');
    expect(block).toContain('await deleteIdentityCredential(user.id)');
  });

  it('invalidates session caches for the deleted user', () => {
    expect(block).toContain('invalidateSessionsForUsers(affectedUserIds)');
    expect(block.indexOf('await deleteIdentityCredential')).toBeLessThan(block.indexOf('invalidateSessionsForUsers'));
  });
});
