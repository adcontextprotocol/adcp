import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Login Name Preservation Tests — Static Analysis
 *
 * Ensures that the OAuth login callback does not unconditionally overwrite
 * user-set first_name/last_name with values from the identity provider.
 *
 * The webhook handler (workos-webhooks.ts) already uses COALESCE to preserve
 * existing DB names. The auth callback must do the same — otherwise a user
 * who sets their display name via PUT /api/me/name will have it overwritten
 * on next login.
 */

const HTTP_FILE = path.resolve(__dirname, '../../src/http.ts');

describe('auth callback name preservation', () => {
  const httpContent = fs.readFileSync(HTTP_FILE, 'utf-8');

  // Find the auth callback upsert query (the INSERT INTO users ... ON CONFLICT
  // block inside the /auth/callback handler)
  const authCallbackSection = extractAuthCallbackUpsert(httpContent);

  it('should not unconditionally overwrite first_name on login', () => {
    expect(authCallbackSection).not.toContain('first_name = EXCLUDED.first_name');
  });

  it('should not unconditionally overwrite last_name on login', () => {
    expect(authCallbackSection).not.toContain('last_name = EXCLUDED.last_name');
  });

  it('should use COALESCE to preserve existing DB names', () => {
    expect(authCallbackSection).toMatch(/COALESCE.*users\.first_name.*EXCLUDED\.first_name/s);
    expect(authCallbackSection).toMatch(/COALESCE.*users\.last_name.*EXCLUDED\.last_name/s);
  });
});

describe('/api/me name source', () => {
  const httpContent = fs.readFileSync(HTTP_FILE, 'utf-8');

  it('should read names from the database, not just the WorkOS session', () => {
    // The /api/me handler should query the users table for first_name/last_name
    // rather than relying solely on user.firstName from the WorkOS JWT
    const meHandler = extractMeHandler(httpContent);
    expect(meHandler).toContain('SELECT first_name, last_name FROM users');
  });
});

/**
 * Extract the ON CONFLICT DO UPDATE clause from the auth callback's user upsert.
 */
function extractAuthCallbackUpsert(content: string): string {
  // Find the auth callback handler
  const callbackStart = content.indexOf("'/auth/callback'");
  if (callbackStart === -1) throw new Error('Could not find /auth/callback handler');

  // Find the INSERT INTO users within that handler
  const insertStart = content.indexOf('INSERT INTO users', callbackStart);
  if (insertStart === -1) throw new Error('Could not find INSERT INTO users in auth callback');

  // Find the ON CONFLICT clause
  const onConflict = content.indexOf('ON CONFLICT', insertStart);
  if (onConflict === -1) throw new Error('Could not find ON CONFLICT in auth callback upsert');

  // Extract through the end of the template literal (next backtick)
  const end = content.indexOf('`', onConflict);
  if (end === -1) throw new Error('Could not find end of query template');

  return content.slice(onConflict, end);
}

/**
 * Extract the /api/me GET handler section.
 */
function extractMeHandler(content: string): string {
  // Find the GET /api/me handler (not /api/me/name or other sub-paths)
  const meComment = content.indexOf("// GET /api/me - Get current user info");
  if (meComment === -1) throw new Error('Could not find GET /api/me handler');

  // Extract a reasonable chunk of the handler
  const handlerEnd = content.indexOf("// PUT /api/me/name", meComment);
  if (handlerEnd === -1) throw new Error('Could not find end of /api/me handler');

  return content.slice(meComment, handlerEnd);
}
