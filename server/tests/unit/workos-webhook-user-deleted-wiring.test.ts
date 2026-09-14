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
const IDENTITY_DB_FILE = path.resolve(__dirname, '../../src/db/identity-db.ts');
const identityDbSource = fs.readFileSync(IDENTITY_DB_FILE, 'utf-8');

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
    expect(backfillBlock).toContain('shouldAbortBackfillDeletion(localUsers.rows.length, candidates.length)');
    expect(backfillBlock).toContain('deletion circuit breaker refused an unsafe batch');
    expect(backfillBlock).not.toMatch(/DELETE FROM organization_memberships/);
    expect(backfillBlock).not.toMatch(/DELETE FROM users/);
  });

  it('guards every authority-bearing provider writer with the deletion lock seam', () => {
    for (const eventType of [
      'organization_membership.created',
      'organization_membership.updated',
      'user.created',
      'user.updated',
    ]) {
      const eventStart = webhookSource.indexOf(`case '${eventType}'`);
      const eventEnd = webhookSource.indexOf('\n          case ', eventStart + 1);
      const eventBlock = webhookSource.slice(eventStart, eventEnd);
      expect(eventStart).toBeGreaterThan(-1);
      expect(eventBlock).toContain(eventType === 'user.created'
        ? 'withCredentialCreationEventMutation('
        : 'withActiveCredentialEventMutation(');
    }
  });

  it('keeps guarded user and membership helpers on the supplied transaction client', () => {
    expect(webhookSource).toContain(
      'credentialClient ?? pool, user.id, user.first_name, user.last_name',
    );
    expect(webhookSource).toContain(
      'canAddSeat(membership.organization_id, seatType, client)',
    );
  });

  it('uses one credential-first lock order and fails closed after bounded retries', () => {
    expect(identityDbSource).toContain('await lockCredentialThenIdentityMutation(client, workosUserId)');
    const sharedLock = identityDbSource.indexOf('async function lockCredentialThenIdentityMutation');
    const credentialLock = identityDbSource.indexOf('await lockCredentialMutations(client, [workosUserId])', sharedLock);
    const bindingLock = identityDbSource.indexOf('FOR UPDATE', credentialLock);
    const identityLock = identityDbSource.indexOf('FOR UPDATE OF i', bindingLock);
    expect(credentialLock).toBeGreaterThan(sharedLock);
    expect(bindingLock).toBeGreaterThan(credentialLock);
    expect(identityLock).toBeGreaterThan(bindingLock);
    expect(identityDbSource).toContain('CREDENTIAL_MUTATION_MAX_ATTEMPTS = 3');
    expect(identityDbSource).toContain('if (await hasConfirmedDeletionTombstone(client, workosUserId))');
    expect(identityDbSource).not.toContain('Credential event mutation retry bound exhausted; applying without lock');
  });
});
