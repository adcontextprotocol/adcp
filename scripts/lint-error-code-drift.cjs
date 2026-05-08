#!/usr/bin/env node
/**
 * Surface drift between the current source error-code enum and the latest
 * maintenance branch (`3.0.x`).
 *
 * Policy: 3.0.x is wire-stable. Adding a new enum value is a wire change
 * (a 3.0.x receiver decoding a 3.1 sender's `error.code` cannot match against
 * an enum it doesn't carry, and JSON Schema `enum` is closed by default), so
 * new codes default to `held-for-next-minor` and ship in 3.1+. The
 * `backport-pending` disposition is reserved for the narrow case of a
 * prose-only or doc-comment-only change to a code that ALREADY EXISTS on
 * 3.0.x — the wire vocabulary is unchanged, only the description tightens.
 *
 * The strictness of "no enum additions in patch" is a function of the missing
 * normative forward-compat rule on `error.code` decoding. Tracked in #4227 —
 * once forward-compat decoding is normative, future maintenance lines can
 * relax this default to additive-in-patch.
 *
 * Held codes carry a `target_version` ("3.1", "4.0", …) so the registry
 * distinguishes "next planned minor" from "deferred to next major" without
 * widening the disposition vocabulary.
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
 *  - Disposition value not in the allowed set → ERROR.
 *  - `held-for-next-*` entry without a `target_version` → ERROR.
 *  - `backport-pending` entry whose code is NOT already on 3.0.x → ERROR
 *    (would make `backport-pending` a wire-additive masquerading as prose).
 *  - `backport-pending` entry without a non-empty `note` → ERROR (the prose
 *    contract is honor-system without a recorded justification).
 *  - Code in 3.0.x but absent from this branch → ERROR (3.0.x landed
 *    something that wasn't forward-merged back, or someone force-pushed
 *    3.0.x backwards; either way, investigate).
 *  - dispositions.json entry for a code that's no longer ahead → WARN
 *    (cleanup needed; either the code was backported or removed).
 *  - dispositions.json entry with disposition: "unclassified" → WARN
 *    (decision still required; doesn't fail CI).
 *
 * No-op when running on the 3.0.x branch itself (nothing to compare to).
 * On GitHub Actions, the workflow gates the step on github.ref/base_ref
 * because the in-script branch check sees a detached HEAD on PR-merge refs.
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
const REQUIRES_TARGET_VERSION = new Set(['held-for-next-minor', 'held-for-next-major']);
const TARGET_VERSION_PATTERN = /^\d+\.\d+$/;

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
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DISPOSITIONS_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${DISPOSITIONS_PATH} as JSON: ${err.message}`);
  }
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
      continue;
    }
    if (REQUIRES_TARGET_VERSION.has(entry.disposition)) {
      if (typeof entry.target_version !== 'string' || !TARGET_VERSION_PATTERN.test(entry.target_version)) {
        errors.push(
          `  ${code}: disposition="${entry.disposition}" requires a target_version field matching /^\\d+\\.\\d+$/ (e.g. "3.1", "4.0").`
        );
      }
    }
    if (entry.disposition === 'backport-pending') {
      // backport-pending = prose-only fix to a code that already exists on
      // 3.0.x. If the code is in `ahead`, by definition it's NOT on 3.0.x
      // yet — so the disposition is a category error.
      errors.push(
        `  ${code}: disposition="backport-pending" but code is not present on ${branchRef}. ` +
        `backport-pending is reserved for prose-only changes to existing codes; new wire codes must use held-for-next-minor or held-for-next-major.`
      );
    }
  }

  // Verify backport-pending entries record a justification note. Membership
  // on 3.0.x is enforced in the per-ahead loop above for codes that ARE
  // ahead; for entries whose code is neither ahead nor on 3.0.x we treat the
  // entry as stale (handled by the stale-entry warning loop below) so we
  // don't double-emit.
  const aheadSetEarly = new Set(ahead);
  for (const [code, entry] of Object.entries(dispositions)) {
    if (entry && entry.disposition === 'backport-pending' && !aheadSetEarly.has(code)) {
      if (!branchEnum.has(code)) {
        // Falls through to stale-entry warning.
        continue;
      }
      if (typeof entry.note !== 'string' || entry.note.trim().length === 0) {
        errors.push(
          `  ${code}: disposition="backport-pending" requires a non-empty note describing the prose-only change ` +
          `(the prose contract is honor-system without a recorded justification).`
        );
      }
    }
  }

  for (const code of behind) {
    errors.push(
      `  ${code}: present on ${branchRef} but absent from this branch's source. ` +
      `Possible causes: a 3.0.x cherry-pick was not forward-merged back to main; or ${branchRef} was force-pushed backwards. Investigate before re-running.`
    );
  }

  // Stale dispositions: entries for codes that are neither ahead of 3.0.x nor
  // (for backport-pending) on 3.0.x's enum.
  for (const [code, entry] of Object.entries(dispositions)) {
    const isBackportPendingOn30x = entry && entry.disposition === 'backport-pending' && branchEnum.has(code);
    if (!aheadSetEarly.has(code) && !isBackportPendingOn30x) {
      warnings.push(
        `  ${code}: stale dispositions entry — code is no longer ahead of ${branchRef}. ` +
        `Remove from scripts/error-code-drift-dispositions.json.`
      );
    }
  }

  // Counts by disposition for the summary.
  const counts = Object.fromEntries([...VALID_DISPOSITIONS].map(d => [d, 0]));
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
