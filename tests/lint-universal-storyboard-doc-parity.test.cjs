#!/usr/bin/env node
/**
 * Tests for the universal-storyboard doc-parity lint.
 *
 * Three concerns:
 *   1. Source-tree guard — the real source + docs pass cleanly. Catches drift
 *      the day a new universal storyboard lands without a doc-table row.
 *   2. Forward parity — synthetic source has a graded storyboard the synthetic
 *      docs don't list → lint fires with a clear "missing rows for X" error.
 *   3. Reverse parity — synthetic docs reference a slug the synthetic source
 *      doesn't define → lint fires with "no graded storyboard exists" error.
 *
 * Synthetic fixtures use a temp-dir layout that mirrors the real one:
 *   <tmp>/source/universal/{slug}.yaml
 *   <tmp>/repo/docs/building/conformance.mdx
 *   <tmp>/repo/docs/building/compliance-catalog.mdx
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, discoverGradedUniversal, extractTableTokens } =
  require('../scripts/lint-universal-storyboard-doc-parity.cjs');

test('source tree passes the doc-parity lint', () => {
  const errors = lint();
  assert.deepEqual(
    errors,
    [],
    'real docs drift from real universal storyboards:\n  ' + errors.join('\n  '),
  );
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-doc-parity-'));
  const sourceDir = path.join(root, 'source');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(sourceDir, 'universal'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'docs/building'), { recursive: true });
  return { root, sourceDir, repoRoot };
}

function writeStoryboard(sourceDir, slug, { graded = true, id = null } = {}) {
  const body = graded
    ? `id: ${id || slug.replace(/-/g, '_')}\nphases:\n  - id: phase_one\n    title: "Phase one"\n`
    : `# Non-graded fixture\ndescription: not a real storyboard\n`;
  fs.writeFileSync(path.join(sourceDir, 'universal', `${slug}.yaml`), body);
}

function writeConformance(repoRoot, rows) {
  const table = rows
    .map(([slug, purpose]) => `| [\`${slug}\`](https://example.com/${slug}) | ${purpose} |`)
    .join('\n');
  fs.writeFileSync(
    path.join(repoRoot, 'docs/building/conformance.mdx'),
    `# Conformance\n\n## Universal conformance\n\n| Storyboard | What |\n|------------|------|\n${table}\n\n## Next section\n\nUnrelated content.\n`,
  );
}

function writeCatalog(repoRoot, rows) {
  const table = rows
    .map(([slug, purpose]) => `| \`${slug}\` | ${purpose} |`)
    .join('\n');
  fs.writeFileSync(
    path.join(repoRoot, 'docs/building/compliance-catalog.mdx'),
    `# Catalog\n\n## Universal storyboards\n\n| Storyboard | Purpose |\n|-----------|---------|\n${table}\n\n## Protocols\n\nUnrelated.\n`,
  );
}

test('clean fixture: graded storyboard listed in both docs → no errors', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'capability-discovery');
  writeConformance(repoRoot, [['capability_discovery', 'shape']]);
  writeCatalog(repoRoot, [['capability-discovery', 'shape']]);

  const errors = lint({ sourceDir, repoRoot });
  assert.deepEqual(errors, []);
});

test('non-graded fixtures (storyboard-schema, runner-output-contract, fictional-entities) are not required in docs', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'capability-discovery');
  // These three live in the real universal/ directory but aren't graded.
  writeStoryboard(sourceDir, 'storyboard-schema', { graded: false });
  writeStoryboard(sourceDir, 'runner-output-contract', { graded: false });
  writeStoryboard(sourceDir, 'fictional-entities', { graded: false });
  writeConformance(repoRoot, [['capability_discovery', 'shape']]);
  writeCatalog(repoRoot, [['capability-discovery', 'shape']]);

  const errors = lint({ sourceDir, repoRoot });
  assert.deepEqual(errors, []);
});

test('forward parity: graded storyboard missing from conformance.mdx → error', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'capability-discovery');
  writeStoryboard(sourceDir, 'webhook-emission');
  // conformance lists only one — webhook_emission is missing.
  writeConformance(repoRoot, [['capability_discovery', 'shape']]);
  writeCatalog(repoRoot, [
    ['capability-discovery', 'shape'],
    ['webhook-emission', 'webhooks'],
  ]);

  const errors = lint({ sourceDir, repoRoot });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /conformance\.mdx/);
  assert.match(errors[0], /missing rows for `webhook_emission`/);
});

test('forward parity: graded storyboard missing from compliance-catalog.mdx → error (kebab-case form)', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'pagination-integrity');
  writeConformance(repoRoot, [['pagination_integrity', 'pagination']]);
  // catalog forgets the row.
  writeCatalog(repoRoot, []);

  const errors = lint({ sourceDir, repoRoot });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /compliance-catalog\.mdx/);
  assert.match(errors[0], /missing rows for `pagination-integrity`/);
});

test('reverse parity: doc references a slug with no graded storyboard on disk → error', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'capability-discovery');
  writeConformance(repoRoot, [
    ['capability_discovery', 'shape'],
    ['ghost_storyboard', 'this row references nothing'],
  ]);
  writeCatalog(repoRoot, [['capability-discovery', 'shape']]);

  const errors = lint({ sourceDir, repoRoot });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /conformance\.mdx/);
  assert.match(errors[0], /references `ghost_storyboard`/);
  assert.match(errors[0], /no graded storyboard exists/);
});

test('reverse parity: catalog row for a deprecated/removed storyboard → error', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'capability-discovery');
  writeConformance(repoRoot, [['capability_discovery', 'shape']]);
  // catalog still has a row for an old storyboard the YAML was deleted.
  writeCatalog(repoRoot, [
    ['capability-discovery', 'shape'],
    ['ancient-storyboard', 'should have been deleted'],
  ]);

  const errors = lint({ sourceDir, repoRoot });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /compliance-catalog\.mdx/);
  assert.match(errors[0], /references `ancient-storyboard`/);
});

test('missing expected heading produces a specific error', () => {
  const { sourceDir, repoRoot } = makeFixture();
  writeStoryboard(sourceDir, 'capability-discovery');
  // Catalog file exists but lacks the expected heading.
  fs.writeFileSync(
    path.join(repoRoot, 'docs/building/compliance-catalog.mdx'),
    '# Catalog\n\nNo universal section here yet.\n',
  );
  writeConformance(repoRoot, [['capability_discovery', 'shape']]);

  const errors = lint({ sourceDir, repoRoot });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing expected heading "## Universal storyboards"/);
});

test('discoverGradedUniversal: filters to entries with phases:[]', () => {
  const { sourceDir } = makeFixture();
  writeStoryboard(sourceDir, 'graded-one');
  writeStoryboard(sourceDir, 'graded-two', { id: 'custom_id_two' });
  writeStoryboard(sourceDir, 'not-graded', { graded: false });

  const items = discoverGradedUniversal(sourceDir);
  assert.equal(items.length, 2);
  const slugs = items.map(i => i.slug).sort();
  assert.deepEqual(slugs, ['graded-one', 'graded-two']);
  const idForTwo = items.find(i => i.slug === 'graded-two').id;
  assert.equal(idForTwo, 'custom_id_two');
});

test('extractTableTokens: pulls slug from the first cell of each row, ignores prose', () => {
  const section = `## Heading

Some prose mentioning \`unrelated\` in passing.

| Storyboard | What |
|------------|------|
| [\`capability_discovery\`](https://example.com) | shape |
| \`signed-requests\` | transport |
| [\`pagination_integrity\`](url) | cursor invariant |

More prose with \`other_token\` that should be ignored.
`;
  const tokens = extractTableTokens(section);
  assert.deepEqual(
    [...tokens].sort(),
    ['capability_discovery', 'pagination_integrity', 'signed-requests'],
  );
});
