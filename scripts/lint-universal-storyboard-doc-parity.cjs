#!/usr/bin/env node
/**
 * Lint: docs index pages list every graded universal storyboard, and only
 * reference storyboards that exist on disk.
 *
 * Why
 * ---
 * The catalog and conformance index pages each carry a table of universal
 * storyboards. Both have drifted in the past — storyboards landed without
 * back-filling the docs (#3099 caught webhook-emission, pagination-integrity,
 * idempotency, signed-requests all missing in various places). This lint
 * keeps them honest.
 *
 * Forward parity: every graded universal storyboard MUST appear in both
 * tables. A new universal storyboard that ships without a row breaks the
 * build.
 *
 * Reverse parity: every backtick-quoted slug appearing in a table row MUST
 * resolve to a real graded storyboard on disk. A copy-paste typo or a row
 * left behind after a rename breaks the build.
 *
 * "Graded" means the YAML has a `phases:` array. Filters out non-graded
 * fixtures (storyboard-schema.yaml, runner-output-contract.yaml,
 * fictional-entities.yaml) which live alongside graded storyboards but
 * aren't run by the suite.
 *
 * Slug forms differ across the two docs by design (existing convention,
 * not changed here):
 *   - docs/building/conformance.mdx           uses snake_case YAML `id` values in markdown links
 *   - docs/building/compliance-catalog.mdx    uses kebab-case filename slugs in plain backticks
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'static/compliance/source');

const DOC_CHECKS = [
  {
    relpath: 'docs/building/conformance.mdx',
    heading: '## Universal conformance',
    tokenForItem: item => item.id,
    tokenLabel: 'YAML `id`',
  },
  {
    relpath: 'docs/building/compliance-catalog.mdx',
    heading: '## Universal storyboards',
    tokenForItem: item => item.slug,
    tokenLabel: 'filename slug',
  },
];

function discoverGradedUniversal(sourceDir) {
  const universalDir = path.join(sourceDir, 'universal');
  if (!fs.existsSync(universalDir)) return [];
  return fs.readdirSync(universalDir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => {
      const slug = f.replace(/\.yaml$/, '');
      let doc = null;
      try {
        doc = yaml.load(fs.readFileSync(path.join(universalDir, f), 'utf8'));
      } catch {
        // Malformed YAML is caught by other lints; skip it here so doc parity
        // doesn't double-error on the same file.
      }
      const graded = doc && typeof doc === 'object' && Array.isArray(doc.phases);
      const id = doc && typeof doc === 'object' && typeof doc.id === 'string'
        ? doc.id
        : slug.replace(/-/g, '_');
      return { slug, id, graded };
    })
    .filter(item => item.graded);
}

function extractSection(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) return null;
  const tail = content.slice(start + heading.length);
  const nextHeadingIdx = tail.search(/\n## /);
  return nextHeadingIdx === -1
    ? content.slice(start)
    : content.slice(start, start + heading.length + nextHeadingIdx);
}

function extractTableTokens(section) {
  const tokens = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    // First cell only; supports `[`token`](url)` (markdown link) and `` `token` `` (plain).
    const m = line.match(/^\|\s*\[?`([a-z][a-z0-9_-]+)`/);
    if (m) tokens.add(m[1]);
  }
  return tokens;
}

/**
 * Run the lint. Returns an array of error strings (empty = clean).
 * Pass `{ sourceDir, repoRoot }` to override default paths (used by tests).
 */
function lint({ sourceDir = DEFAULT_SOURCE_DIR, repoRoot = REPO_ROOT } = {}) {
  const items = discoverGradedUniversal(sourceDir);
  const errors = [];

  for (const check of DOC_CHECKS) {
    const filePath = path.join(repoRoot, check.relpath);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');

    const section = extractSection(content, check.heading);
    if (section === null) {
      errors.push(`${check.relpath}: missing expected heading "${check.heading}"`);
      continue;
    }

    // Forward parity
    const missingFromDoc = items
      .map(item => check.tokenForItem(item))
      .filter(token => !section.includes('`' + token + '`'));
    if (missingFromDoc.length) {
      errors.push(
        `${check.relpath}: universal-storyboards table is missing rows for ${missingFromDoc.map(t => '`' + t + '`').join(', ')}.\n` +
        `  Add a row to the table under "${check.heading}". The runner will fail any agent that doesn't pass these.`
      );
    }

    // Reverse parity
    const knownTokens = new Set(items.map(item => check.tokenForItem(item)));
    const tableTokens = extractTableTokens(section);
    const ghostTokens = [...tableTokens].filter(t => !knownTokens.has(t));
    if (ghostTokens.length) {
      errors.push(
        `${check.relpath}: universal-storyboards table references ${ghostTokens.map(t => '`' + t + '`').join(', ')} but no graded storyboard exists on disk under static/compliance/source/universal/.\n` +
        `  Either add the storyboard YAML or remove the row. (Expected ${check.tokenLabel} form.)`
      );
    }
  }

  return errors;
}

function main() {
  const errors = lint();
  if (errors.length) {
    console.error('Universal-storyboard doc parity drift:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ universal-storyboard doc parity: docs match graded universal storyboards');
}

if (require.main === module) {
  main();
}

module.exports = {
  lint,
  discoverGradedUniversal,
  extractSection,
  extractTableTokens,
  DOC_CHECKS,
};
