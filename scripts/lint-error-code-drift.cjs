#!/usr/bin/env node
/**
 * Surface drift between the current source error-code enum and the latest
 * maintenance branch (`3.0.x`).
 *
 * Policy: 3.0.x is wire-stable. Adding a new enum value is a wire change
 * (receivers may encounter unrecognized codes), so new codes default to
 * `held-for-next-minor` and ship in 3.1. The `backport-pending` disposition is
 * reserved for the narrow case of a prose-only or doc-comment-only change to
 * an existing code that needs to ship in 3.0.x.
 *
 * Why this exists: without a lint, the gap between source-on-main and 3.0.x
 * dist artifacts is invisible. Downstream consumers reading 3.0.x bundles
 * silently miss codes the spec source already defines, and the policy that
 * justifies the gap (wire-stability) lives only in maintainer heads. This
 * script forces a per-code disposition recorded in
 * scripts/error-code-drift-dispositions.json, so the gap is documented and
 * the policy is enforced.
 *
 * Failure modes:
 *  - Code in source on this branch but absent from 3.0.x AND missing a
 *    dispositions.json entry → ERROR (forces a decision).
 *  - Code in 3.0.x but absent from this branch → ERROR (3.0.x landed something
 *    that wasn't forward-merged back; real bug).
 *  - dispositions.json entry for a code that's no longer ahead → WARN
 *    (cleanup needed; either the code was backported or removed).
 *  - dispositions.json entry with disposition: "unclassified" → WARN
 *    (decision still required; doesn't fail CI).
 *
 * No-op when running on the 3.0.x branch itself (nothing to compare to).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ENUM_PATH = path.join(ROOT, 'static', 'schemas', 'source', 'enums', 'error-code.json');
const DISPOSITIONS_PATH = path.join(ROOT, 'scripts', 'error-code-drift-dispositions.json');
const MAINTENANCE_BRANCH = '3.0.x';
const VALID_DISPOSITIONS = new Set([
  'backport-pending',
  'held-for-next-minor',
  'held-for-next-major',
  'unclassified',
]);

function loadEnum(jsonText, label) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Could not parse ${label} as JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed.enum)) {
    throw new Error(`${label} has no top-level "enum" array`);
  }
  return new Set(parsed.enum);
}

function readMaintenanceBranchEnum() {
  const refsToTry = [`origin/${MAINTENANCE_BRANCH}`, MAINTENANCE_BRANCH];
  let lastErr;
  for (const ref of refsToTry) {
    try {
      const out = execFileSync(
        'git',
        ['show', `${ref}:static/schemas/source/enums/error-code.json`],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return { enumSet: loadEnum(out, `${ref}:static/schemas/source/enums/error-code.json`), ref };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not read error-code.json from ${refsToTry.join(' or ')}.\n` +
    `Hint: ensure the ${MAINTENANCE_BRANCH} branch is fetched (run \`git fetch origin ${MAINTENANCE_BRANCH}\`).\n` +
    `Underlying error: ${lastErr && lastErr.message}`
  );
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function loadDispositions() {
  if (!fs.existsSync(DISPOSITIONS_PATH)) {
    throw new Error(`Dispositions file missing: ${DISPOSITIONS_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(DISPOSITIONS_PATH, 'utf8'));
  if (!raw.dispositions || typeof raw.dispositions !== 'object') {
    throw new Error(`${DISPOSITIONS_PATH}: missing or malformed "dispositions" object`);
  }
  return raw.dispositions;
}

function main() {
  const branch = currentBranch();
  if (branch === MAINTENANCE_BRANCH) {
    console.log(`error-code-drift lint: on ${MAINTENANCE_BRANCH}; nothing to compare. Skipping.`);
    return 0;
  }

  const sourceEnum = loadEnum(fs.readFileSync(SOURCE_ENUM_PATH, 'utf8'), SOURCE_ENUM_PATH);
  const { enumSet: branchEnum, ref: branchRef } = readMaintenanceBranchEnum();
  const dispositions = loadDispositions();

  const ahead = [...sourceEnum].filter(c => !branchEnum.has(c)).sort();
  const behind = [...branchEnum].filter(c => !sourceEnum.has(c)).sort();

  const errors = [];
  const warnings = [];

  for (const code of ahead) {
    const entry = dispositions[code];
    if (!entry) {
      errors.push(
        `  ${code}: present in source but missing from ${branchRef} AND has no dispositions entry. ` +
        `Add to scripts/error-code-drift-dispositions.json with one of: ${[...VALID_DISPOSITIONS].join(', ')}.`
      );
      continue;
    }
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      errors.push(
        `  ${code}: disposition="${entry.disposition}" is not one of ${[...VALID_DISPOSITIONS].join(', ')}.`
      );
      continue;
    }
    if (entry.disposition === 'unclassified') {
      warnings.push(
        `  ${code}: unclassified — decide between backport-pending / held-for-next-minor / held-for-next-major.` +
        (entry.note ? ` (note: ${entry.note})` : '')
      );
    }
  }

  for (const code of behind) {
    errors.push(
      `  ${code}: present on ${branchRef} but absent from this branch's source. ` +
      `${MAINTENANCE_BRANCH} got an enum entry that was never forward-merged. Investigate.`
    );
  }

  // Stale dispositions: entries for codes no longer ahead.
  const aheadSet = new Set(ahead);
  for (const code of Object.keys(dispositions)) {
    if (!aheadSet.has(code)) {
      warnings.push(
        `  ${code}: stale dispositions entry — code is no longer ahead of ${branchRef}. ` +
        `Remove from scripts/error-code-drift-dispositions.json.`
      );
    }
  }

  // Counts by disposition for the summary.
  const counts = { 'backport-pending': 0, 'held-for-next-minor': 0, 'held-for-next-major': 0, 'unclassified': 0 };
  for (const code of ahead) {
    const d = dispositions[code] && dispositions[code].disposition;
    if (counts[d] !== undefined) counts[d]++;
  }

  console.log(`error-code-drift lint: comparing source vs ${branchRef}`);
  console.log(`  source codes: ${sourceEnum.size}`);
  console.log(`  ${branchRef} codes: ${branchEnum.size}`);
  console.log(`  ahead (source has, ${branchRef} missing): ${ahead.length}`);
  for (const [d, n] of Object.entries(counts)) {
    if (n > 0) console.log(`    - ${d}: ${n}`);
  }

  if (warnings.length > 0) {
    console.log('\nwarnings:');
    for (const w of warnings) console.log(w);
  }
  if (errors.length > 0) {
    console.error('\nerrors:');
    for (const e of errors) console.error(e);
    console.error(`\n✖ ${errors.length} error(s), ${warnings.length} warning(s).`);
    return 1;
  }
  console.log(`\n✓ ${warnings.length} warning(s); no blocking errors.`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`error-code-drift lint failed: ${err.message}`);
    process.exit(2);
  }
}
