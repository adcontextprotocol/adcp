#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const {
    planRcPromotion,
    prepareRcPromotion,
    rcChangelogContent,
    readPreparedRcPromotion,
    validateChangesetConsumption,
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
    pendingChangesets: [],
  });

  assert.deepEqual(
    planRcPromotion({
      packageVersion: '3.2.0-beta.10',
      preState: { mode: 'pre', tag: 'beta' },
      pendingChangesets: ['z-last.md', 'a-first.md'],
    }).pendingChangesets,
    ['a-first.md', 'z-last.md'],
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
  assert.throws(
    () => planRcPromotion({
      packageVersion: '3.3.0-beta.1',
      preState: { mode: 'pre', tag: 'beta' },
      pendingChangesets: [],
    }),
    /restricted to the 3\.2\.0 release line/,
  );
  assert.match(
    rcChangelogContent(
      '# Changelog\n\n## 3.2.0-beta.10\n\n- Final beta.\n',
      { currentVersion: '3.2.0-beta.10', targetVersion: '3.2.0-rc.0' },
    ),
    /^# Changelog\n\n## 3\.2\.0-rc\.0\n\nPromoted from `3\.2\.0-beta\.10`/,
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
    fs.writeFileSync(
      path.join(root, '.changeset', 'candidate-fix.md'),
      '---\n"adcontextprotocol": patch\n---\n\nCandidate fix.\n',
    );

    prepareRcPromotion(root);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.changeset', 'pre.json'), 'utf8')),
      { mode: 'pre', tag: 'beta' },
    );
    const marker = JSON.parse(
      fs.readFileSync(path.join(root, '.changeset', 'rc-promotion.json'), 'utf8'),
    );
    assert.equal(marker.from, '3.2.0-beta.10');
    assert.equal(marker.to, '3.2.0-rc.0');
    assert.equal(marker.pendingChangesets[0].file, 'candidate-fix.md');
    assert.match(marker.pendingChangesets[0].sha256, /^[a-f0-9]{64}$/);
    const prepared = readPreparedRcPromotion(root);
    assert.deepEqual({
      ...prepared,
      reviewedChangesets: prepared.reviewedChangesets.map(({ file }) => file),
    }, {
      currentVersion: '3.2.0-beta.10',
      targetVersion: '3.2.0-rc.0',
      nextPreState: { mode: 'pre', tag: 'rc' },
      pendingChangesets: ['candidate-fix.md'],
      reviewedChangesets: ['candidate-fix.md'],
    });

    const changesetPath = path.join(root, '.changeset', 'candidate-fix.md');
    const reviewedChangeset = fs.readFileSync(changesetPath, 'utf8');
    fs.writeFileSync(changesetPath, `${reviewedChangeset}\nTampered.\n`);
    assert.throws(
      () => readPreparedRcPromotion(root),
      /do not match the reviewed RC promotion marker/,
    );
    fs.writeFileSync(changesetPath, reviewedChangeset);

    const writePackageVersion = (version) => {
      const generatedPackage = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
      );
      generatedPackage.version = version;
      fs.writeFileSync(
        path.join(root, 'package.json'),
        `${JSON.stringify(generatedPackage, null, 2)}\n`,
      );
    };
    writePackageVersion('3.2.0-beta.99');
    assert.throws(
      () => validateChangesetConsumption(root, prepared, '3.2.0-beta.11'),
      /generated "3\.2\.0-beta\.99" instead of "3\.2\.0-beta\.11"/,
    );
    writePackageVersion('3.2.0-beta.11');
    assert.throws(
      () => validateChangesetConsumption(root, prepared, '3.2.0-beta.11'),
      /did not consume the reviewed RC changeset pool/,
    );
    fs.unlinkSync(changesetPath);
    fs.mkdirSync(path.join(root, '.changeset', 'pre'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.changeset', 'pre', 'candidate-fix.md'),
      `${reviewedChangeset}\nTampered after consumption.\n`,
    );
    assert.throws(
      () => validateChangesetConsumption(root, prepared, '3.2.0-beta.11'),
      /did not preserve reviewed content for candidate-fix\.md/,
    );
    fs.rmSync(path.join(root, '.changeset', 'pre'), { recursive: true });
    fs.writeFileSync(changesetPath, reviewedChangeset);
    writePackageVersion('3.2.0-beta.10');

    let consumed = false;
    versionPreparedRc(root, {
      runChangesetVersion: () => {
        consumed = true;
        fs.unlinkSync(changesetPath);
        fs.mkdirSync(path.join(root, '.changeset', 'pre'), { recursive: true });
        fs.writeFileSync(
          path.join(root, '.changeset', 'pre', 'candidate-fix.md'),
          reviewedChangeset,
        );
        writePackageVersion('3.2.0-beta.11');
        const changelogPath = path.join(root, 'CHANGELOG.md');
        const changelog = fs.readFileSync(changelogPath, 'utf8');
        fs.writeFileSync(
          changelogPath,
          changelog.replace(
            '# Changelog\n\n',
            '# Changelog\n\n## 3.2.0-beta.11\n\n### Patch Changes\n\n- Candidate fix.\n\n',
          ),
        );
      },
    });
    assert.equal(consumed, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      '3.2.0-rc.0',
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.changeset', 'pre.json'), 'utf8')),
      { mode: 'pre', tag: 'rc' },
    );
    assert.match(
      fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
      /^# Changelog\n\n## 3\.2\.0-rc\.0\n\n### Patch Changes\n\n- Candidate fix\./,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
      /## 3\.2\.0-beta\.11\n/,
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
