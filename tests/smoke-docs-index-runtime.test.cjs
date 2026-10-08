const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/smoke-docs-index-runtime.mjs');

test('stdin smoke resolves English versions without scripts/docs-navigation.cjs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-smoke-'));
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-smoke-cwd-'));
  try {
    const snapshot = path.join(root, 'dist/docs/3.2.2');
    const schemas = path.join(root, 'dist/schemas/3.2.2');
    fs.mkdirSync(snapshot, { recursive: true });
    fs.mkdirSync(schemas, { recursive: true });
    fs.writeFileSync(path.join(snapshot, 'intro.mdx'), '---\ntitle: Intro\n---\n');
    fs.writeFileSync(path.join(schemas, 'core.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'docs.json'), JSON.stringify({
      navigation: {
        languages: [
          {
            language: 'en',
            default: true,
            versions: [
              {
                version: '3.2',
                default: true,
                groups: [{ group: 'Getting Started', pages: ['dist/docs/3.2.2/intro'] }],
              },
            ],
          },
          {
            language: 'zh',
            groups: [{ group: '入门', pages: ['docs/zh/intro'] }],
          },
        ],
      },
    }));

    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: emptyCwd,
      env: { ...process.env, DOCS_SMOKE_APP_ROOT: root },
      input: fs.readFileSync(SCRIPT),
      encoding: 'utf8',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.doesNotMatch(output, /docs-navigation/);
    assert.match(output, /docs-indexer\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  }
});
