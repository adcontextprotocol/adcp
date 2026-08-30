#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const {
    planRcPromotion,
    prepareRcPromotion,
    readPreparedRcPromotion,
    versionPreparedRc,
  } = await import('../scripts/promote-release-candidate.mjs');
  const repoRoot = path.join(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const versionWrapper = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'version-packages.mjs'),
    'utf8',
  );
  assert.match(packageJson.scripts.version, /^node scripts\/version-packages\.mjs/);
  assert.equal(
    packageJson.scripts['promote:rc'],
    'node scripts/promote-release-candidate.mjs',
  );
  assert.match(versionWrapper, /\.changeset\/rc-promotion\.json/);
  assert.match(versionWrapper, /changeset', 'version'/);

  const plan = planRcPromotion({
    packageVersion: '3.2.0-beta.10',
    preState: { mode: 'pre', tag: 'beta' },
    pendingChangesets: [],
  });
  assert.deepEqual(plan, {
    currentVersion: '3.2.0-beta.10',
    targetVersion: '3.2.0-rc.0',
    nextPreState: { mode: 'pre', tag: 'rc' },
  });

  assert.throws(
    () => planRcPromotion({
      packageVersion: '3.2.0-beta.10',
      preState: { mode: 'pre', tag: 'beta' },
      pendingChangesets: ['fix-after-final-beta.md'],
    }),
    /Cut the final beta before RC promotion/,
  );
  assert.throws(
    () => planRcPromotion({
      packageVersion: '3.2.0-beta.10',
      preState: { mode: 'pre', tag: 'rc' },
      pendingChangesets: [],
    }),
    /remain in beta pre mode/,
  );
  assert.throws(
    () => planRcPromotion({
      packageVersion: '3.2.0-rc.0',
      preState: { mode: 'pre', tag: 'beta' },
      pendingChangesets: [],
    }),
    /Expected the final beta version/,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-rc-promotion-'));
  try {
    fs.mkdirSync(path.join(root, '.changeset'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'adcontextprotocol', version: '3.2.0-beta.10' }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(root, '.changeset', 'pre.json'),
      `${JSON.stringify({ mode: 'pre', tag: 'beta' }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(root, 'CHANGELOG.md'),
      '# Changelog\n\n## 3.2.0-beta.10\n\n### Patch Changes\n\n- Final beta.\n',
    );

    prepareRcPromotion(root);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.changeset', 'pre.json'), 'utf8')),
      { mode: 'pre', tag: 'rc' },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.changeset', 'rc-promotion.json'), 'utf8')),
      { from: '3.2.0-beta.10', to: '3.2.0-rc.0' },
    );
    assert.deepEqual(readPreparedRcPromotion(root), {
      currentVersion: '3.2.0-beta.10',
      targetVersion: '3.2.0-rc.0',
    });

    versionPreparedRc(root);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      '3.2.0-rc.0',
    );
    assert.match(
      fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
      /^# Changelog\n\n## 3\.2\.0-rc\.0\n\nPromoted from `3\.2\.0-beta\.10` after final-beta acceptance\./,
    );
    assert.equal(
      fs.existsSync(path.join(root, '.changeset', 'rc-promotion.json')),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('Release-candidate promotion checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
