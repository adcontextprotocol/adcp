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
  assert.match(versionWrapper, /\.changeset\/release-supersession\.json/);
  assert.match(versionWrapper, /check-release-supersession\.cjs/);
  assert.match(versionWrapper, /changeset', 'version'/);
  // The release line comes from package.json, never from a literal.
  assert.doesNotMatch(
    fs.readFileSync(path.join(repoRoot, 'scripts', 'promote-release-candidate.mjs'), 'utf8'),
    /\d+\.\d+\.\d+-(?:beta|rc)\b/,
  );

  const beta = { mode: 'pre', tag: 'beta' };
  for (const [finalBeta, target] of [
    ['3.2.0-beta.10', '3.2.0-rc.0'],
    ['3.3.0-beta.5', '3.3.0-rc.0'],
    ['4.0.0-beta.0', '4.0.0-rc.0'],
  ]) {
    assert.deepEqual(
      planRcPromotion({ packageVersion: finalBeta, preState: beta, pendingChangesets: [] }),
      {
        currentVersion: finalBeta,
        targetVersion: target,
        nextPreState: { mode: 'pre', tag: 'rc' },
        pendingChangesets: [],
      },
    );
  }

  assert.deepEqual(
    planRcPromotion({
      packageVersion: '3.3.0-beta.5',
      preState: beta,
      pendingChangesets: ['z-last.md', 'a-first.md'],
    }).pendingChangesets,
    ['a-first.md', 'z-last.md'],
  );
  assert.throws(
    () => planRcPromotion({
      packageVersion: '3.3.0-beta.5',
      preState: { mode: 'pre', tag: 'rc' },
      pendingChangesets: [],
    }),
    /remain in beta pre mode/,
  );
  assert.throws(
    () => planRcPromotion({ packageVersion: '3.3.0-beta.5', preState: null, pendingChangesets: [] }),
    /remain in beta pre mode/,
  );
  // One-way: an RC, a stable release, or any other prerelease shape is refused.
  for (const packageVersion of ['3.3.0-rc.0', '3.3.0', '3.3.0-alpha.1', '3.3.0-beta', '3.3.0-beta.5.1']) {
    assert.throws(
      () => planRcPromotion({ packageVersion, preState: beta, pendingChangesets: [] }),
      /Expected the final beta version/,
      packageVersion,
    );
  }
  assert.throws(
    () => planRcPromotion({ packageVersion: '3.2.10-beta.0', preState: beta, pendingChangesets: [] }),
    /requires an X\.Y\.0 beta/,
  );
  assert.match(
    rcChangelogContent(
      '# Changelog\n\n## 3.3.0-beta.5\n\n- Final beta.\n',
      { currentVersion: '3.3.0-beta.5', targetVersion: '3.3.0-rc.0' },
    ),
    /^# Changelog\n\n## 3\.3\.0-rc\.0\n\nPromoted from `3\.3\.0-beta\.5`/,
  );

  for (const finalBeta of ['3.3.0-beta.5', '3.2.0-beta.10']) {
    exercisePromotion(finalBeta);
  }

  function exercisePromotion(finalBeta) {
    const line = finalBeta.replace(/-beta\.\d+$/, '');
    const target = `${line}-rc.0`;
    const nextBeta = `${line}-beta.${Number(finalBeta.split('.').pop()) + 1}`;
    const escape = (value) => value.replace(/\./g, '\\.');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-rc-promotion-'));
    try {
      fs.mkdirSync(path.join(root, '.changeset'));
      const writePackageVersion = (version) => {
        fs.writeFileSync(
          path.join(root, 'package.json'),
          `${JSON.stringify({ name: 'adcontextprotocol', version }, null, 2)}\n`,
        );
      };
      writePackageVersion(finalBeta);
      fs.writeFileSync(
        path.join(root, '.changeset', 'pre.json'),
        `${JSON.stringify(beta, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(root, 'CHANGELOG.md'),
        `# Changelog\n\n## ${finalBeta}\n\n### Patch Changes\n\n- Final beta.\n`,
      );
      const changesetPath = path.join(root, '.changeset', 'candidate-fix.md');
      const reviewedChangeset = '---\n"adcontextprotocol": patch\n---\n\nCandidate fix.\n';
      fs.writeFileSync(changesetPath, reviewedChangeset);

      prepareRcPromotion(root);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(root, '.changeset', 'pre.json'), 'utf8')),
        beta,
      );
      const markerPath = path.join(root, '.changeset', 'rc-promotion.json');
      const markerText = fs.readFileSync(markerPath, 'utf8');
      const marker = JSON.parse(markerText);
      assert.equal(marker.from, finalBeta);
      assert.equal(marker.to, target);
      assert.equal(marker.pendingChangesets[0].file, 'candidate-fix.md');
      assert.match(marker.pendingChangesets[0].sha256, /^[a-f0-9]{64}$/);
      assert.throws(() => prepareRcPromotion(root), /rc-promotion\.json already exists/);
      const prepared = readPreparedRcPromotion(root);
      assert.deepEqual({
        ...prepared,
        reviewedChangesets: prepared.reviewedChangesets.map(({ file }) => file),
      }, {
        currentVersion: finalBeta,
        targetVersion: target,
        nextPreState: { mode: 'pre', tag: 'rc' },
        pendingChangesets: ['candidate-fix.md'],
        reviewedChangesets: ['candidate-fix.md'],
      });

      // The reviewed pool is exact: a changed, added, or removed changeset is refused.
      fs.writeFileSync(changesetPath, `${reviewedChangeset}\nTampered.\n`);
      assert.throws(
        () => readPreparedRcPromotion(root),
        /do not match the reviewed RC promotion marker/,
      );
      fs.writeFileSync(changesetPath, reviewedChangeset);
      const addedPath = path.join(root, '.changeset', 'late-arrival.md');
      fs.writeFileSync(addedPath, '---\n"adcontextprotocol": patch\n---\n\nLate.\n');
      assert.throws(
        () => readPreparedRcPromotion(root),
        /do not match the reviewed RC promotion marker/,
      );
      fs.unlinkSync(addedPath);
      fs.unlinkSync(changesetPath);
      assert.throws(
        () => readPreparedRcPromotion(root),
        /do not match the reviewed RC promotion marker/,
      );
      fs.writeFileSync(changesetPath, reviewedChangeset);

      // The marker must name this line's rc.0 from the current package version.
      for (const tampered of [
        { ...marker, to: '3.1.0-rc.0' },
        { ...marker, to: `${line}-rc.1` },
        { ...marker, from: `${line}-beta.0` },
      ]) {
        fs.writeFileSync(markerPath, `${JSON.stringify(tampered, null, 2)}\n`);
        assert.throws(
          () => readPreparedRcPromotion(root),
          /does not match the current package version and rc\.0 target/,
        );
      }
      fs.writeFileSync(markerPath, markerText);
      fs.writeFileSync(
        path.join(root, '.changeset', 'pre.json'),
        `${JSON.stringify({ mode: 'pre', tag: 'rc' }, null, 2)}\n`,
      );
      assert.throws(() => readPreparedRcPromotion(root), /requires beta pre mode/);
      fs.writeFileSync(
        path.join(root, '.changeset', 'pre.json'),
        `${JSON.stringify(beta, null, 2)}\n`,
      );

      writePackageVersion(`${line}-beta.99`);
      assert.throws(
        () => validateChangesetConsumption(root, prepared, nextBeta),
        new RegExp(`generated "${escape(line)}-beta\\.99" instead of "${escape(nextBeta)}"`),
      );
      writePackageVersion(nextBeta);
      assert.throws(
        () => validateChangesetConsumption(root, prepared, nextBeta),
        /did not consume the reviewed RC changeset pool/,
      );
      fs.unlinkSync(changesetPath);
      fs.mkdirSync(path.join(root, '.changeset', 'pre'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.changeset', 'pre', 'candidate-fix.md'),
        `${reviewedChangeset}\nTampered after consumption.\n`,
      );
      assert.throws(
        () => validateChangesetConsumption(root, prepared, nextBeta),
        /did not preserve reviewed content for candidate-fix\.md/,
      );
      fs.rmSync(path.join(root, '.changeset', 'pre'), { recursive: true });
      fs.writeFileSync(changesetPath, reviewedChangeset);
      writePackageVersion(finalBeta);

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
          writePackageVersion(nextBeta);
          const changelogPath = path.join(root, 'CHANGELOG.md');
          const changelog = fs.readFileSync(changelogPath, 'utf8');
          fs.writeFileSync(
            changelogPath,
            changelog.replace(
              '# Changelog\n\n',
              `# Changelog\n\n## ${nextBeta}\n\n### Patch Changes\n\n- Candidate fix.\n\n`,
            ),
          );
        },
      });
      assert.equal(consumed, true);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
        target,
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(root, '.changeset', 'pre.json'), 'utf8')),
        { mode: 'pre', tag: 'rc' },
      );
      const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
      assert.match(
        changelog,
        new RegExp(`^# Changelog\\n\\n## ${escape(target)}\\n\\n### Patch Changes\\n\\n- Candidate fix\\.`),
      );
      assert.doesNotMatch(changelog, new RegExp(`## ${escape(nextBeta)}\\n`));
      assert.equal(fs.existsSync(markerPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('Release-candidate promotion checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
