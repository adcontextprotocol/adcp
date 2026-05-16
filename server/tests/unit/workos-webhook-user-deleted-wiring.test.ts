import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Static-analysis wiring assertions on the user.deleted webhook handler.
 *
 * Issue adcontextprotocol/adcp#3718: WorkOS-side deletion of a primary
 * credential leaves multi-credential identities with zero primaries. The
 * handler must promote a surviving secondary before the CASCADE fires,
 * invalidate the 60-second session cache, and never return a 5xx on
 * promotion failure (which would trigger WorkOS retry storms).
 *
 * These checks are static so a refactor that re-orders the calls or drops
 * the invalidation fails fast without spinning up the full HTTP stack.
 */

const WEBHOOK_FILE = path.resolve(__dirname, '../../src/routes/workos-webhooks.ts');
const IDENTITY_DB_FILE = path.resolve(__dirname, '../../src/db/identity-db.ts');
const webhookSource = fs.readFileSync(WEBHOOK_FILE, 'utf-8');
const identitySource = fs.readFileSync(IDENTITY_DB_FILE, 'utf-8');

describe('user.deleted handler wiring (#3718)', () => {
  const userDeletedBlockMatch = webhookSource.match(
    /case 'user\.deleted':\s*\{([\s\S]*?)\n\s{10}\}/,
  );
  const block = userDeletedBlockMatch?.[1] ?? '';

  it('matched the user.deleted case body', () => {
    expect(block).not.toEqual('');
  });

  it('calls promoteSecondaryIfPrimaryDeleted before deleteUser', () => {
    const promoteIdx = block.indexOf('promoteSecondaryIfPrimaryDeleted');
    const deleteUserIdx = block.indexOf('deleteUser(');
    expect(promoteIdx).toBeGreaterThanOrEqual(0);
    expect(deleteUserIdx).toBeGreaterThan(promoteIdx);
  });

  it('invalidates session caches for the deleted user', () => {
    expect(block).toMatch(/invalidateSessionsForUsers\s*\(/);
  });
});

describe('promoteSecondaryIfPrimaryDeleted error containment (#3718)', () => {
  // The handler awaits the helper directly without a try/catch — a thrown
  // error would land in the outer catch and produce a 500, triggering WorkOS
  // retry storms. The helper must catch its own errors and return null so
  // the handler falls through to the 200 path.
  const helperSource = identitySource.match(
    /export async function promoteSecondaryIfPrimaryDeleted[\s\S]*?\n\}\n/,
  )?.[0];

  it('matched the helper source', () => {
    expect(helperSource).toBeDefined();
  });

  it('swallows DB errors (catch + return null) so the webhook returns 200', () => {
    expect(helperSource).toMatch(/catch\s*\(/);
    expect(helperSource).toMatch(/return null/);
  });

  it('emits an explicit ops alert on promotion failure', () => {
    // logger.warn auto-posts to #admin-errors (posthog.ts:201-205); plus an
    // explicit notifySystemError so the alert doesn't get lost in the warn
    // stream during noisy hours.
    expect(helperSource).toMatch(/logger\.warn/);
    expect(helperSource).toMatch(/notifySystemError/);
  });
});
