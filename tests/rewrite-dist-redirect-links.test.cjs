const test = require('node:test');
const assert = require('node:assert/strict');

function existsFrom(paths) {
  const files = new Set(paths);
  return (candidate) => files.has(candidate);
}

(async () => {
  const {
    buildRedirectRules,
    hasSnapshotFile,
    rewriteContent,
  } = await import('../scripts/rewrite-dist-redirect-links.mjs');

  test('hasSnapshotFile accepts files and index files in a dist docs snapshot', () => {
    const exists = existsFrom([
      'dist/docs/3.1.0-rc.5/reference/page.mdx',
      'dist/docs/3.1.0-rc.5/reference/index/index.md',
    ]);

    assert.equal(hasSnapshotFile('/dist/docs/3.1.0-rc.5/reference/page', exists), true);
    assert.equal(hasSnapshotFile('/dist/docs/3.1.0-rc.5/reference/index', exists), true);
    assert.equal(hasSnapshotFile('/docs/reference/page', exists), false);
    assert.equal(hasSnapshotFile('/dist/docs/3.1.0-rc.5/missing', exists), false);
  });

  test('rewrites direct redirects only when the destination exists in the snapshot', () => {
    const rules = buildRedirectRules(
      [
        { source: '/docs/old', destination: '/docs/new' },
        { source: '/docs/missing', destination: '/docs/absent' },
      ],
      '3.1.0-rc.5',
      existsFrom(['dist/docs/3.1.0-rc.5/new/index.mdx'])
    );

    assert.deepEqual(rules, [
      {
        source: '/dist/docs/3.1.0-rc.5/old',
        destination: '/dist/docs/3.1.0-rc.5/new',
      },
    ]);
    assert.equal(
      rewriteContent('See [old](/dist/docs/3.1.0-rc.5/old).', rules),
      'See [old](/dist/docs/3.1.0-rc.5/new).'
    );
  });

  test('collapses redirect chains to the terminal destination that exists in the snapshot', () => {
    const rules = buildRedirectRules(
      [
        { source: '/docs/old', destination: '/docs/moved' },
        { source: '/docs/moved', destination: '/docs/final' },
      ],
      '3.1.0-rc.5',
      existsFrom([
        'dist/docs/3.1.0-rc.5/moved.mdx',
        'dist/docs/3.1.0-rc.5/final.mdx',
      ])
    );

    assert.deepEqual(rules, [
      {
        source: '/dist/docs/3.1.0-rc.5/moved',
        destination: '/dist/docs/3.1.0-rc.5/final',
      },
      {
        source: '/dist/docs/3.1.0-rc.5/old',
        destination: '/dist/docs/3.1.0-rc.5/final',
      },
    ]);
    assert.equal(
      rewriteContent('See /dist/docs/3.1.0-rc.5/old#section', rules),
      'See /dist/docs/3.1.0-rc.5/final#section'
    );
  });

  test('skips redirect cycles with no existing snapshot target', () => {
    const rules = buildRedirectRules(
      [
        { source: '/docs/a', destination: '/docs/b' },
        { source: '/docs/b', destination: '/docs/a' },
      ],
      '3.1.0-rc.5',
      existsFrom([])
    );

    assert.deepEqual(rules, []);
  });

  test('does not rewrite a dist path prefix inside a longer slug', () => {
    const rules = [
      {
        source: '/dist/docs/3.1.0-rc.5/old',
        destination: '/dist/docs/3.1.0-rc.5/new',
      },
    ];

    assert.equal(
      rewriteContent('/dist/docs/3.1.0-rc.5/oldest /dist/docs/3.1.0-rc.5/old', rules),
      '/dist/docs/3.1.0-rc.5/oldest /dist/docs/3.1.0-rc.5/new'
    );
  });
})();
