const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/smoke-docs-index-runtime.mjs');

const ENGLISH_VERSION = {
  version: '3.2',
  default: true,
  groups: [{ group: 'Getting Started', pages: ['dist/docs/3.2.2/intro'] }],
};
const ZH_ENTRY = { language: 'zh', groups: [{ group: '入门', pages: ['docs/zh/intro'] }] };

// The fixture has no dist/addie/mcp/docs-indexer.js, so a passing navigation
// step is observable as the smoke reaching the indexer import (exit 1 with a
// docs-indexer.js error) instead of failing on docs-navigation or on the
// navigation assertions.
function runSmokeFromStdin(navigation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-smoke-'));
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-smoke-cwd-'));
  try {
    fs.mkdirSync(path.join(root, 'dist/docs/3.2.2'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist/schemas/3.2.2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/docs/3.2.2/intro.mdx'), '---\ntitle: Intro\n---\n');
    fs.writeFileSync(path.join(root, 'dist/schemas/3.2.2/core.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'docs.json'), JSON.stringify({ navigation }));

    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: emptyCwd,
      env: { ...process.env, DOCS_SMOKE_APP_ROOT: root },
      input: fs.readFileSync(SCRIPT),
      encoding: 'utf8',
    });
    return { result, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  }
}

function assertReachedIndexer({ result, output }) {
  assert.equal(result.status, 1, output);
  assert.doesNotMatch(output, /docs-navigation/);
  assert.doesNotMatch(output, /must configure navigation versions/);
  assert.match(output, /docs-indexer\.js/);
}

test('stdin smoke resolves ordinary navigation.versions without scripts/docs-navigation.cjs', () => {
  assertReachedIndexer(runSmokeFromStdin({ versions: [ENGLISH_VERSION] }));
});

test('stdin smoke resolves English versions from localized navigation without scripts/docs-navigation.cjs', () => {
  assertReachedIndexer(runSmokeFromStdin({
    languages: [{ language: 'en', default: true, versions: [ENGLISH_VERSION] }, ZH_ENTRY],
  }));
});

test('stdin smoke falls back to the default language entry when en is absent', () => {
  assertReachedIndexer(runSmokeFromStdin({
    languages: [ZH_ENTRY, { language: 'en-GB', default: true, versions: [ENGLISH_VERSION] }],
  }));
});
