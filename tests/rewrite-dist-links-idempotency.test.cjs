const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const rewriteScript = path.join(repoRoot, 'scripts/rewrite-dist-links.sh');

test('rewrite-dist-links.sh is idempotent for pinned schema refs and snapshot links', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-dist-links-'));
  const version = '3.1.0-rc.5';
  const docsDir = path.join(tmp, 'dist/docs', version);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs.json'), JSON.stringify({ redirects: [] }));

  const file = path.join(docsDir, 'example.mdx');
  fs.writeFileSync(
    file,
    [
      '{"$schema": "/schemas/3.1.0-rc.5/core/format.json"}',
      '{"$schema": "/schemas/core/format.json"}',
      '[Schema](/schemas/v3/enums/error-code.json)',
      '[Docs](/docs/media-buy/task-reference/get_products)',
    ].join('\n')
  );

  execFileSync('bash', [rewriteScript, version], { cwd: tmp, stdio: 'pipe' });
  const once = fs.readFileSync(file, 'utf8');
  execFileSync('bash', [rewriteScript, version], { cwd: tmp, stdio: 'pipe' });
  const twice = fs.readFileSync(file, 'utf8');

  assert.equal(twice, once);
  assert.match(twice, /"\$schema": "\/schemas\/3\.1\.0-rc\.5\/core\/format\.json"/);
  assert.doesNotMatch(twice, /\/schemas\/3\.1\.0-rc\.5\/3\.1\.0-rc\.5\//);
  assert.match(twice, /\[Docs\]\(\/dist\/docs\/3\.1\.0-rc\.5\/media-buy\/task-reference\/get_products\)/);
});
