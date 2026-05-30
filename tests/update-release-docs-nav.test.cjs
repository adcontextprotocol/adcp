const test = require('node:test');
const assert = require('node:assert/strict');

function collectStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function sampleConfig() {
  return {
    navigation: {
      versions: [
        {
          version: '3.0',
          default: true,
          groups: [
            {
              group: 'Documentation',
              pages: [
                'docs/intro',
                'docs/quickstart',
                {
                  group: 'Protocol',
                  expanded: false,
                  pages: [
                    'docs/protocol/index',
                    {
                      group: 'Nested',
                      pages: ['docs/protocol/nested'],
                    },
                  ],
                },
                'docs/faq',
                {
                  group: 'Reference',
                  openapi: {
                    source: 'static/openapi/registry.yaml',
                    directory: 'docs/registry/api-reference',
                  },
                  pages: ['docs/registry/index'],
                },
              ],
            },
          ],
        },
        {
          version: '2.5',
          groups: [
            {
              group: 'Getting Started',
              pages: ['dist/docs/2.5.3/intro'],
            },
          ],
        },
      ],
    },
  };
}

(async () => {
  const { updateDocsConfig } = await import('../scripts/update-release-docs-nav.mjs');

  test('adds a new snapshot version from the default nav and flattens the wrapper group', () => {
    const config = sampleConfig();
    const result = updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');

    assert.equal(result.action, 'added');
    assert.equal(result.sourceVersion, '3.0');
    assert.deepEqual(
      config.navigation.versions.map((entry) => entry.version),
      ['3.0', '3.1-rc', '2.5']
    );

    const added = config.navigation.versions[1];
    assert.equal(added.default, undefined);
    assert.deepEqual(
      added.groups.map((group) => group.group),
      ['Getting Started', 'Protocol', 'FAQ', 'Reference']
    );
    assert.equal(added.groups[0].pages[0], 'dist/docs/3.1.0-rc.5/intro');
    assert.equal(added.groups[2].pages[0], 'dist/docs/3.1.0-rc.5/faq');
    assert.equal(
      added.groups[3].openapi.directory,
      'dist/docs/3.1.0-rc.5/registry/api-reference'
    );
    assert.equal(added.groups[3].openapi.source, 'static/openapi/registry.yaml');

    const allStrings = collectStrings(added.groups);
    assert.equal(allStrings.some((value) => value.startsWith('docs/')), false);
  });

  test('updates an existing snapshot version without changing its position', () => {
    const config = sampleConfig();
    config.navigation.versions.splice(1, 0, {
      version: '3.1-rc',
      groups: [
        {
          group: 'Getting Started',
          pages: ['dist/docs/3.1.0-rc.4/intro'],
        },
        {
          group: 'Reference',
          openapi: {
            source: 'static/openapi/registry.yaml',
            directory: 'dist/docs/3.1.0-rc.4/registry/api-reference',
          },
          pages: ['dist/docs/3.1.0-rc.4/registry/index'],
        },
      ],
    });

    const result = updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');

    assert.equal(result.action, 'updated');
    assert.deepEqual(
      config.navigation.versions.map((entry) => entry.version),
      ['3.0', '3.1-rc', '2.5']
    );

    const updated = config.navigation.versions[1];
    const allStrings = collectStrings(updated.groups);
    assert.equal(allStrings.some((value) => value.includes('3.1.0-rc.4')), false);
    assert.equal(updated.groups[0].pages[0], 'dist/docs/3.1.0-rc.5/intro');
    assert.equal(
      updated.groups[1].openapi.directory,
      'dist/docs/3.1.0-rc.5/registry/api-reference'
    );
  });

  test('does not convert live docs paths when updating the existing default version', () => {
    const config = sampleConfig();
    config.navigation.versions[0].groups[0].pages.push('dist/docs/3.0.0/old');

    const result = updateDocsConfig(config, '3.0.1', '3.0');

    assert.equal(result.action, 'updated');
    const strings = collectStrings(config.navigation.versions[0].groups);
    assert.ok(strings.includes('docs/intro'));
    assert.ok(strings.includes('docs/quickstart'));
    assert.ok(strings.includes('dist/docs/3.0.1/old'));
  });

  test('adds a new version from the first entry when no default is marked', () => {
    const config = sampleConfig();
    delete config.navigation.versions[0].default;

    const result = updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');

    assert.equal(result.action, 'added');
    assert.equal(result.sourceVersion, '3.0');
    assert.equal(config.navigation.versions[1].version, '3.1-rc');
    assert.equal(config.navigation.versions[1].groups[0].pages[0], 'dist/docs/3.1.0-rc.5/intro');
  });

  test('throws a clear error when navigation.versions is empty', () => {
    assert.throws(
      () => updateDocsConfig({ navigation: { versions: [] } }, '3.1.0-rc.5', '3.1-rc'),
      /navigation\.versions cannot be empty/
    );
  });
})();
