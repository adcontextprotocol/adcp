import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Keep provider revocation wired without choosing a successor identity.
 * Runtime DB-seam tests separately prove that promotion refuses before writes.
 */

const WEBHOOK_FILE = path.resolve(__dirname, '../../src/routes/workos-webhooks.ts');
const webhookSource = fs.readFileSync(WEBHOOK_FILE, 'utf-8');
const DELETION_SERVICE_FILE = path.resolve(__dirname, '../../src/services/identity-credential-deletion.ts');
const deletionServiceSource = fs.readFileSync(DELETION_SERVICE_FILE, 'utf-8');

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
    expect(block).toContain("await deleteIdentityCredential(user.id, 'workos_webhook')");
  });

  it('keeps session and unified cache invalidation inside the deletion helper', () => {
    expect(block).not.toContain('invalidateSessionsForUsers');
    expect(block).not.toContain('invalidateUnifiedUsersCache');
    expect(deletionServiceSource).toContain('invalidateSessionsForUsers(result.affectedUserIds)');
    expect(deletionServiceSource).toContain('invalidateUnifiedUsersCache()');
    expect(deletionServiceSource).toContain('invalidateSlackAdminStatusCache(slackUserId)');
    expect(deletionServiceSource).toContain('invalidateWebAdminStatusCache(workosUserId)');
    expect(deletionServiceSource).toContain('invalidateMemberContextCache(slackUserId)');
  });

  it('routes sync-users confirmed deletion through the same helper', () => {
    const backfillBlock = webhookSource.slice(
      webhookSource.indexOf('export async function backfillUsers'),
      webhookSource.indexOf('export async function backfillOrganizationDomains'),
    );
    expect(backfillBlock).toContain(
      "deleteIdentityCredential(row.workos_user_id, 'sync_users_backfill')",
    );
    expect(backfillBlock).toContain('upsertWorkosUserUnlessConfirmedDeleted(user)');
    expect(backfillBlock).not.toMatch(/DELETE FROM organization_memberships/);
    expect(backfillBlock).not.toMatch(/DELETE FROM users/);
  });
});
