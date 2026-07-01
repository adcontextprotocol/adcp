#!/usr/bin/env node
/**
 * Fail if any Addie tool reaches `callApi('POST'|'PUT'|'DELETE'|'PATCH', …)`.
 *
 * Why this exists: state-changing loopback calls from Addie hit our own
 * CSRF middleware before the request leaves the box and silently 403,
 * which the tool handler then misreads as a domain-level error
 * ("private group", "not a member", "agent unreachable", etc.).
 * Issue #3736 documents the regression class; PRs #3716, #3741, #3743
 * migrated all known state-change tools to consume service functions
 * directly instead of routing through HTTP.
 *
 * The function signature in `server/src/addie/mcp/member-tools.ts` is
 * type-narrowed to `'GET'` only, but a future contributor could bypass
 * the type with a cast. This lint is the second line of defense — it
 * fails CI as soon as any state-change loopback shape reappears in the
 * source tree.
 *
 * To run: node scripts/lint-callapi-state-change.cjs
 *   --check exits 1 if violations; otherwise prints "ok".
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Walk all of server/src/addie/ (not just /mcp/) so a future helper in
// services/ or any other addie subdir gets caught too. `callApi` is
// currently unique to member-tools.ts — the wider sweep is essentially
// free, and it's the bug-pattern boundary that matters.
const ADDIE_DIR = path.join(ROOT, 'server', 'src', 'addie');

// Multi-line aware: anchor on `callApi(` and allow whitespace+newline
// before the method literal. The previously-removed loopback callers
// in member-tools.ts were multi-line, so a single-line regex would
// have missed them — and could miss future regressions written that
// way.
const FORBIDDEN_RE = /callApi\s*\(\s*['"`](POST|PUT|DELETE|PATCH)['"`]/m;

// Strip both line and block comments before scanning so a comment
// referencing the bug class (`// callApi('POST', …) used to loopback`)
// doesn't trip the lint. We don't need a real JS parser — naive comment
// stripping is enough because the regex above is already specific.
function stripComments(source) {
  // Block comments first so /* ... */ spanning lines don't survive.
  // Replace with a same-length blank to preserve line numbers.
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Line comments: blank from `//` to end of line.
  stripped = stripped.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  return stripped;
}

function* walkSourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

function scanFile(filePath) {
  const source = stripComments(fs.readFileSync(filePath, 'utf8'));
  const violations = [];
  // Scan as a single string with a global multi-line regex so calls
  // split across lines (e.g. `callApi(\n  'POST',\n  ...)`) are caught.
  // Compute the line number by counting newlines up to the match.
  const re = /callApi\s*\(\s*['"`](POST|PUT|DELETE|PATCH)['"`]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const line = source.slice(0, match.index).split('\n').length;
    violations.push({
      file: filePath,
      line,
      method: match[1],
      snippet: match[0].replace(/\s+/g, ' '),
    });
  }
  return violations;
}

function lint() {
  if (!fs.existsSync(ADDIE_DIR)) return [];
  const all = [];
  for (const file of walkSourceFiles(ADDIE_DIR)) {
    all.push(...scanFile(file));
  }
  return all;
}

function formatViolation(v) {
  const rel = path.relative(ROOT, v.file);
  return (
    `${rel}:${v.line}  callApi('${v.method}', …) is forbidden. ` +
    `Loopback POST/PUT/DELETE/PATCH from Addie tools hits our own CSRF ` +
    `middleware and silently 403s (issue #3736). Use a service-layer ` +
    `call instead — see services/working-group-membership-service.ts ` +
    `or services/working-group-content-service.ts for the pattern.\n  ${v.snippet}`
  );
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-callapi-state-change: ok (no violations)');
    process.exit(0);
  }
  console.error(`lint-callapi-state-change: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error('  ' + formatViolation(v));
  }
  process.exit(1);
}

module.exports = { lint, scanFile };
