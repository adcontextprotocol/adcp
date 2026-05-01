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
const ADDIE_MCP_DIR = path.join(ROOT, 'server', 'src', 'addie', 'mcp');

// Match `callApi('POST'`, `callApi("PUT"`, `callApi(\n  'DELETE'`, etc.
// We only care about the first argument (the HTTP method).
const FORBIDDEN_RE = /callApi\s*\(\s*['"`](POST|PUT|DELETE|PATCH)['"`]/;

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
  const source = fs.readFileSync(filePath, 'utf8');
  const violations = [];
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    if (FORBIDDEN_RE.test(line)) {
      violations.push({
        file: filePath,
        line: idx + 1,
        method: line.match(FORBIDDEN_RE)[1],
        snippet: line.trim(),
      });
    }
  });
  return violations;
}

function lint() {
  if (!fs.existsSync(ADDIE_MCP_DIR)) return [];
  const all = [];
  for (const file of walkSourceFiles(ADDIE_MCP_DIR)) {
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
