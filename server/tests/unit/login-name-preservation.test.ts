import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Name Preservation Tests — Static Analysis
 *
 * Ensures that login, webhook, and membership sync code never unconditionally
 * overwrites user-set first_name/last_name. Every ON CONFLICT DO UPDATE that
 * touches name fields must use COALESCE to preserve existing non-empty values.
 *
 * Covers:
 * - Auth callback (http.ts)
 * - Membership sync (membership-db.ts)
 * - Admin bulk add (admin/organizations.ts)
 * - /api/me response source
 */

const SRC_DIR = path.resolve(__dirname, '../../src');
const HTTP_FILE = path.join(SRC_DIR, 'http.ts');
const MEMBERSHIP_DB_FILE = path.join(SRC_DIR, 'db/membership-db.ts');
const ADMIN_ORGS_FILE = path.join(SRC_DIR, 'routes/admin/organizations.ts');

/**
 * Find all ON CONFLICT DO UPDATE clauses in a file and check whether
 * any unconditionally overwrite first_name or last_name.
 */
function findUnconditionalNameOverwrites(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const violations: string[] = [];

  // Find all ON CONFLICT ... DO UPDATE blocks
  const onConflictRegex = /ON CONFLICT[\s\S]*?DO UPDATE SET([\s\S]*?)(?:`|;|\$\$)/g;
  let match;
  while ((match = onConflictRegex.exec(content)) !== null) {
    const updateClause = match[1];

    // Check for unconditional first_name overwrite (no COALESCE)
    if (/first_name\s*=\s*EXCLUDED\.first_name/i.test(updateClause) &&
        !/COALESCE.*first_name/i.test(updateClause)) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      violations.push(`${path.basename(filePath)}:${lineNum} — unconditional first_name overwrite`);
    }

    // Check for unconditional last_name overwrite (no COALESCE)
    if (/last_name\s*=\s*EXCLUDED\.last_name/i.test(updateClause) &&
        !/COALESCE.*last_name/i.test(updateClause)) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      violations.push(`${path.basename(filePath)}:${lineNum} — unconditional last_name overwrite`);
    }
  }

  return violations;
}

describe('auth callback name preservation', () => {
  const httpContent = fs.readFileSync(HTTP_FILE, 'utf-8');
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
    const meHandler = extractMeHandler(httpContent);
    expect(meHandler).toContain('SELECT first_name, last_name FROM users');
  });
});

describe('membership sync name preservation', () => {
  it('should not have unconditional name overwrites in membership-db.ts', () => {
    const violations = findUnconditionalNameOverwrites(MEMBERSHIP_DB_FILE);
    expect(violations).toEqual([]);
  });
});

describe('admin bulk-add name preservation', () => {
  it('should not have unconditional name overwrites in admin/organizations.ts', () => {
    const violations = findUnconditionalNameOverwrites(ADMIN_ORGS_FILE);
    expect(violations).toEqual([]);
  });
});

describe('no unconditional name overwrites anywhere in runtime code', () => {
  // Scan all .ts files under src/ (excluding migrations which are historical)
  const tsFiles = findTsFiles(SRC_DIR).filter(f => !f.includes('/migrations/'));

  it('should not have any ON CONFLICT that unconditionally overwrites name fields', () => {
    const allViolations: string[] = [];
    for (const file of tsFiles) {
      allViolations.push(...findUnconditionalNameOverwrites(file));
    }
    expect(allViolations).toEqual([]);
  });
});

// --- helpers ---

function extractAuthCallbackUpsert(content: string): string {
  const callbackStart = content.indexOf("'/auth/callback'");
  if (callbackStart === -1) throw new Error('Could not find /auth/callback handler');

  const insertStart = content.indexOf('INSERT INTO users', callbackStart);
  if (insertStart === -1) throw new Error('Could not find INSERT INTO users in auth callback');

  const onConflict = content.indexOf('ON CONFLICT', insertStart);
  if (onConflict === -1) throw new Error('Could not find ON CONFLICT in auth callback upsert');

  const end = content.indexOf('`', onConflict);
  if (end === -1) throw new Error('Could not find end of query template');

  return content.slice(onConflict, end);
}

function extractMeHandler(content: string): string {
  const meComment = content.indexOf("// GET /api/me - Get current user info");
  if (meComment === -1) throw new Error('Could not find GET /api/me handler');

  const handlerEnd = content.indexOf("// PUT /api/me/name", meComment);
  if (handlerEnd === -1) throw new Error('Could not find end of /api/me handler');

  return content.slice(meComment, handlerEnd);
}

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}
