#!/usr/bin/env node
/**
 * Ratchet for local shims that reach into @adcp/sdk internals.
 *
 * These shims are sometimes the right short-term move, but they should be
 * visible, owned, tied to an upstream ask, and removed when the SDK grows a
 * public API. This lint fails on new private SDK reach-ins that are not listed
 * in .agents/sdk-shim-ledger.json and on stale ledger paths whose terms no
 * longer appear.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, '.agents', 'sdk-shim-ledger.json');
const SCAN_ROOTS = ['server', 'scripts', 'tests', '.github', '.husky'];
const EXCLUDED_RELATIVE = new Set([
  'scripts/lint-sdk-shims.cjs',
  'tests/lint-sdk-shims.test.cjs',
]);

const PRIVATE_SDK_PATTERNS = [
  /node_modules\/@adcp\/sdk\/(?:dist\/lib|compliance\/cache|ADCP_VERSION)/,
  /dist\/lib\/(?:testing|validation|utils|types|schemas-data)/,
  /['"`]dist['"`]\s*,\s*['"`]lib['"`]/,
  /\bTOOL_RESPONSE_SCHEMAS\b/,
  /\bValidateInputResponseSchema\b/,
  /\btaskWebhookEmitter\b/,
  /\bschemas\.generated\.js\b/,
];

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function loadLedger() {
  const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error('.agents/sdk-shim-ledger.json must contain an array');
  }
  return entries;
}

function validateLedger(entries) {
  const violations = [];
  const ids = new Set();

  for (const [index, entry] of entries.entries()) {
    const prefix = `ledger[${index}]`;
    for (const field of ['id', 'title', 'kind', 'status', 'owner', 'upstream', 'problem', 'localBehavior', 'removalCondition']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        violations.push({ rule: 'invalid-ledger-entry', message: `${prefix}.${field} must be a non-empty string` });
      }
    }
    if (ids.has(entry.id)) {
      violations.push({ rule: 'duplicate-ledger-id', message: `${prefix}.id duplicates ${entry.id}` });
    }
    ids.add(entry.id);
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      violations.push({ rule: 'invalid-ledger-entry', message: `${prefix}.paths must be a non-empty array` });
    }
    if (!Array.isArray(entry.terms) || entry.terms.length === 0) {
      violations.push({ rule: 'invalid-ledger-entry', message: `${prefix}.terms must be a non-empty array` });
    }
  }

  return violations;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*');
}

function matchingPrivateTerm(line) {
  if (isCommentOnlyLine(line)) return null;
  return PRIVATE_SDK_PATTERNS.some((pattern) => pattern.test(line)) ? line.trim() : null;
}

function collectFindings(root = ROOT) {
  const findings = [];
  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = path.join(root, scanRoot);
    for (const file of walk(absoluteRoot)) {
      const rel = toPosix(path.relative(root, file));
      if (EXCLUDED_RELATIVE.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      source.split(/\r?\n/).forEach((line, index) => {
        const term = matchingPrivateTerm(line);
        if (term) {
          findings.push({ file: rel, line: index + 1, term });
        }
      });
    }
  }
  return findings;
}

function termIsAllowed(term, allowedTerm) {
  return term.includes(allowedTerm);
}

function entryAllowsFinding(entry, finding) {
  return entry.paths.includes(finding.file) &&
    entry.terms.some((allowedTerm) => termIsAllowed(finding.term, allowedTerm));
}

function lint() {
  const entries = loadLedger();
  const violations = validateLedger(entries);
  const findings = collectFindings();

  for (const finding of findings) {
    if (!entries.some((entry) => entryAllowsFinding(entry, finding))) {
      violations.push({
        rule: 'unledgered-sdk-shim',
        file: finding.file,
        line: finding.line,
        message: `${finding.file}:${finding.line} private SDK reach-in is not in .agents/sdk-shim-ledger.json: ${finding.term}`,
      });
    }
  }

  for (const entry of entries) {
    for (const ledgerPath of entry.paths ?? []) {
      const absolutePath = path.join(ROOT, ledgerPath);
      if (!fs.existsSync(absolutePath)) {
        violations.push({
          rule: 'stale-ledger-path',
          file: ledgerPath,
          message: `${entry.id} lists missing path ${ledgerPath}`,
        });
        continue;
      }
      const pathFindings = findings.filter((finding) => finding.file === ledgerPath);
      const hasEntryTerm = pathFindings.some((finding) =>
        entry.terms.some((allowedTerm) => termIsAllowed(finding.term, allowedTerm)));
      if (!hasEntryTerm) {
        violations.push({
          rule: 'stale-ledger-entry',
          file: ledgerPath,
          message: `${entry.id} no longer has a matching private SDK term in ${ledgerPath}; remove or update the ledger entry`,
        });
      }
    }
  }

  return violations;
}

function formatViolation(v) {
  return v.message;
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-sdk-shims: ok');
    process.exit(0);
  }
  console.error(`lint-sdk-shims: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    console.error(`${formatViolation(violation)}\n`);
  }
  process.exit(1);
}

module.exports = {
  lint,
  loadLedger,
  collectFindings,
  matchingPrivateTerm,
  PRIVATE_SDK_PATTERNS,
};
