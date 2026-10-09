import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #6827 static guard: no new executable path may delete an organization row.
 *
 * Organization deletion and organization merge are both contained, but a
 * containment that only covers routes and services is a containment an operator
 * can walk around — a script or a copy-pasteable remediation hint reproduces the
 * same split provider/local state with no journal and no audit trail. This guard
 * fails the build when a raw organization delete appears anywhere outside the
 * explicitly justified allowlist below, so re-introducing a bypass has to be a
 * deliberate, reviewed edit to this list rather than a quiet new file.
 *
 * Scope: JavaScript, TypeScript and SQL under server/src, server/scripts and
 * scripts/. SQL is covered deliberately: a `.sql` runbook under scripts/ is the
 * likeliest shape for the next bypass, because it is what an operator reaches
 * for after being refused. Only the schema migration directory is excluded —
 * those files define the schema rather than delete rows on an operator's behalf.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCAN_ROOTS = ['server/src', 'server/scripts', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git']);
/**
 * Excluded by exact path rather than by directory name, so a directory that
 * merely happens to be called "migrations" elsewhere is still scanned.
 */
const SKIP_PATHS = new Set(['server/src/db/migrations']);
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sql',
]);

/** Matches a raw delete against the organizations table, across line breaks. */
const ORG_DELETE = /DELETE\s+FROM\s+organizations\b/gi;
/**
 * Non-global twin for single-string checks. `String.match` resets `lastIndex`,
 * but a global regex shared across assertions is a footgun not worth leaving.
 */
const ORG_DELETE_ONCE = /DELETE\s+FROM\s+organizations\b/i;

/**
 * Every remaining occurrence, with the reason it is not an operator-reachable
 * organization deletion. Anything not listed here fails.
 */
const ALLOWLIST: Record<string, { occurrences: number; reason: string }> = {
  'server/src/db/organization-db.ts': {
    occurrences: 1,
    reason:
      'OrganizationDatabase.deleteOrganization has no callers anywhere in the tree ' +
      '(dead before the containment work began) and is reachable only by adding one.',
  },
  'server/src/services/prospect.ts': {
    occurrences: 1,
    reason:
      'Prospect creation rolling back the row it inserted moments earlier in the same ' +
      'call when the domain link conflicts. It never removes a pre-existing organization.',
  },
  'server/scripts/setup-sandbox.ts': {
    occurrences: 2,
    reason:
      'Local sandbox seeding, bounded to org_aao_sandbox_* ids and refusing to run ' +
      'unless STRIPE_SECRET_KEY is sk_test_*. Never runs against production data.',
  },
};

function relative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

function collectFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(relative(absolute))) continue;
      collectFiles(absolute, found);
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(absolute);
    }
  }
  return found;
}

function scan(): Map<string, number> {
  const hits = new Map<string, number>();
  for (const root of SCAN_ROOTS) {
    for (const absolute of collectFiles(path.join(REPO_ROOT, root))) {
      const matches = fs.readFileSync(absolute, 'utf8').match(ORG_DELETE);
      if (matches?.length) hits.set(relative(absolute), matches.length);
    }
  }
  return hits;
}

describe('#6827 raw organization delete guard', () => {
  const hits = scan();

  it('scans a non-trivial number of files, so a broken walker cannot pass silently', () => {
    const scanned = SCAN_ROOTS.flatMap(root => collectFiles(path.join(REPO_ROOT, root)));
    expect(scanned.length).toBeGreaterThan(500);
    // And SQL is genuinely in the walk, not just in the extension set.
    expect(scanned.filter(file => file.endsWith('.sql')).length).toBeGreaterThan(0);
    // The schema migration directory stays out by exact path.
    expect(scanned.map(relative).filter(file => file.startsWith('server/src/db/migrations/'))).toEqual([]);
  });

  it('finds no raw organization delete outside the justified allowlist', () => {
    const unexpected = [...hits.keys()].filter(file => !(file in ALLOWLIST)).sort();
    expect(
      unexpected,
      'A raw organization delete appeared in a file with no recorded justification. ' +
        'Organization deletion and merge are contained under #6827; do not add a ' +
        'bypass. If this is genuinely not an operator-reachable deletion, add it to ' +
        'ALLOWLIST with the reason.',
    ).toEqual([]);
  });

  it('holds each allowlisted file to its recorded occurrence count', () => {
    for (const [file, { occurrences, reason }] of Object.entries(ALLOWLIST)) {
      expect(hits.get(file), `${file} (${reason})`).toBe(occurrences);
    }
  });

  it('keeps the duplicate-stub incident script non-destructive', () => {
    const target = 'scripts/incidents/2026-05-cleanup-duplicate-prospect-stubs.ts';
    const source = fs.readFileSync(path.join(REPO_ROOT, target), 'utf8');

    // No delete, no database client, no transaction control: the destructive
    // path is removed rather than merely gated.
    expect(source).not.toMatch(ORG_DELETE_ONCE);
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(source).not.toMatch(/\bnew Client\b/);
    expect(source).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/);

    // --execute is refused, and the refusal precedes every other statement so
    // no configuration or network call can happen first.
    expect(source).toMatch(/--execute/);
    const refusalAt = source.indexOf("process.argv.includes('--execute')");
    const firstEnvReadAt = source.indexOf('process.env.');
    expect(refusalAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(firstEnvReadAt);
  });

  it('keeps the duplicate-domain invariant from handing an operator a delete statement', () => {
    const target = 'server/src/audit/integrity/invariants/unique-org-per-email-domain.ts';
    const source = fs.readFileSync(path.join(REPO_ROOT, target), 'utf8');

    expect(source).not.toMatch(ORG_DELETE_ONCE);
    // The remediation now routes to read-only inspection and escalation.
    expect(source).toMatch(/preview-merge/);
    expect(source).toMatch(/#6827/);
  });
});
