// Kept outside Vitest's *.test.* glob because this suite uses node:test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GENERATED_MARKER,
  assertCatalogConsumesOutputs,
  assertCompleteErrorTaxonomy,
  loadGradedStoryboards,
  renderErrorCodes,
  writeOrCheck,
} from '../scripts/generate-compliance-snippets.mjs';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-snippets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function schemaFixture() {
  return {
    enum: ['Z_CODE', 'A_CODE'],
    enumDescriptions: {
      Z_CODE: 'Last description.',
      A_CODE: 'Escapes <tags>, {values}, pipes |, and ampersands &.',
    },
    enumMetadata: {
      Z_CODE: { recovery: 'terminal', suggestion: 'escalate' },
      A_CODE: { recovery: 'correctable', suggestion: 'fix input' },
    },
  };
}

test('error-code rendering is sorted, escaped, and deterministic', () => {
  const first = renderErrorCodes(schemaFixture());
  const second = renderErrorCodes(schemaFixture());
  assert.equal(first, second);
  assert.match(first, /^---\ntitle: Compliance Error Codes\n/);
  assert.match(first, /"og:title": "AdCP — Compliance Error Codes"/);
  assert.ok(first.indexOf('`A_CODE`') < first.indexOf('`Z_CODE`'));
  assert.match(first, /&lt;tags&gt;/);
  assert.match(first, /&#123;values&#125;/);
  assert.match(first, /pipes \|/);
  assert.match(first, /ampersands &amp;/);
});

test('error taxonomy rejects duplicate codes and malformed metadata', () => {
  const duplicate = schemaFixture();
  duplicate.enum.push('A_CODE');
  assert.throws(() => assertCompleteErrorTaxonomy(duplicate), /duplicate enum value/);

  const malformed = schemaFixture();
  malformed.enumMetadata.A_CODE.recovery = 'retry_forever';
  malformed.enumDescriptions.Z_CODE = null;
  let error;
  try {
    assertCompleteErrorTaxonomy(malformed);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /enumDescriptions entry must be a nonempty string/);
  assert.match(error.message, /enumMetadata\.recovery/);
});

test('storyboard inventory rejects traversal, duplicates, and malformed prose', t => {
  const complianceDir = makeTempDir(t);
  const universalDir = path.join(complianceDir, 'universal');
  fs.mkdirSync(universalDir);
  fs.writeFileSync(
    path.join(universalDir, 'valid-storyboard.yaml'),
    'title: Valid\nsummary: Works\nphases: []\n',
  );

  assert.throws(
    () => loadGradedStoryboards({ universal: ['../outside'] }, complianceDir),
    /invalid universal storyboard slug/,
  );
  fs.symlinkSync(
    path.join(universalDir, 'valid-storyboard.yaml'),
    path.join(universalDir, 'linked-storyboard.yaml'),
  );
  assert.throws(
    () => loadGradedStoryboards({ universal: ['linked-storyboard'] }, complianceDir),
    /must be a regular file/,
  );
  assert.throws(
    () => loadGradedStoryboards({ universal: ['valid-storyboard', 'valid-storyboard'] }, complianceDir),
    /duplicate universal storyboard slug/,
  );

  fs.writeFileSync(
    path.join(universalDir, 'bad-prose.yaml'),
    'title:\n  nested: value\nsummary: Works\nphases: []\n',
  );
  assert.throws(
    () => loadGradedStoryboards({ universal: ['bad-prose'] }, complianceDir),
    /must declare both title and summary/,
  );

  fs.writeFileSync(
    path.join(universalDir, 'unclassified.yaml'),
    'title: Unclassified\nsummary: Missing phases\n',
  );
  assert.throws(
    () => loadGradedStoryboards({ universal: ['unclassified'] }, complianceDir),
    /neither a graded storyboard nor a known support artifact/,
  );
});

test('check mode rejects changed, missing, and orphaned generated files', t => {
  const outputDir = makeTempDir(t);
  const content = `{/* ${GENERATED_MARKER} */}\ncurrent\n`;
  const outputs = { 'current.mdx': content };

  writeOrCheck(outputs, { check: false, outputDir });
  assert.doesNotThrow(() => writeOrCheck(outputs, { check: true, outputDir }));

  fs.writeFileSync(path.join(outputDir, 'current.mdx'), `${content}stale\n`);
  assert.throws(() => writeOrCheck(outputs, { check: true, outputDir }), /current\.mdx/);

  writeOrCheck(outputs, { check: false, outputDir });
  fs.writeFileSync(
    path.join(outputDir, 'orphan.mdx'),
    `{/* ${GENERATED_MARKER} */}\norphan\n`,
  );
  assert.throws(() => writeOrCheck(outputs, { check: true, outputDir }), /orphan\.mdx/);
  writeOrCheck(outputs, { check: false, outputDir });
  assert.equal(fs.existsSync(path.join(outputDir, 'orphan.mdx')), false);

  fs.unlinkSync(path.join(outputDir, 'current.mdx'));
  assert.throws(() => writeOrCheck(outputs, { check: true, outputDir }), /current\.mdx/);
});

test('catalog consumption requires both imports and component usages', () => {
  assert.throws(
    () => assertCatalogConsumesOutputs('No generated components here.'),
    /missing import for ComplianceErrorCodes/,
  );
});
