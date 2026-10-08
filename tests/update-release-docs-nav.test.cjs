const test = require('node:test');
const assert = require('node:assert/strict');
const { docsNavigationVersions } = require('../scripts/docs-navigation.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
    banner: {
      content: 'AdCP 3.1 beta.0 is available — [start testing →](/docs/reference/3-1-beta)',
    },
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

function versionEntry(version, build, extra = {}) {
  return {
    version,
    ...extra,
    groups: [{ group: 'Getting Started', pages: [`dist/docs/${build}/intro`] }],
  };
}

(async () => {
  const {
    renderCurrentLlmsIndex,
    updateDocsConfig,
    updateDockerignore,
    updateSchemaTools,
  } = await import('../scripts/update-release-docs-nav.mjs');

  test('adds a released snapshot to the Docker build context exactly once', () => {
    const initial = [
      'dist/docs/*',
      '!dist/docs/3.1.19',
      '!dist/docs/3.1.19/**',
      '!dist/schemas',
      '',
    ].join('\n');
    const updated = updateDockerignore(initial, '3.1.20');

    assert.equal(
      updated,
      [
        'dist/docs/*',
        '!dist/docs/3.1.19',
        '!dist/docs/3.1.19/**',
        '!dist/docs/3.1.20',
        '!dist/docs/3.1.20/**',
        '!dist/schemas',
        '',
      ].join('\n')
    );
    assert.equal(updateDockerignore(updated, '3.1.20'), updated);
  });

  test('keeps Addie schema routing on the same frozen releases as docs, in picker order', () => {
    const source = [
      "import x from 'y';",
      '',
      'export const DOCS_SCHEMA_RELEASES: Readonly<Record<string, string>> = Object.freeze({',
      "  '3.1': '3.1.19',",
      "  '3.2-beta': '3.2.0-beta.10',",
      '});',
      '',
      "const OTHER = Object.freeze({ '3.1': 'untouched' });",
      '',
    ].join('\n');
    const config = {
      navigation: {
        versions: [
          versionEntry('3.1', '3.1.20', { default: true, tag: 'Latest' }),
          versionEntry('3.2-beta', '3.2.0-beta.11'),
          versionEntry('2.5 (archived)', '2.5.3'),
        ],
      },
    };

    assert.equal(
      updateSchemaTools(source, config),
      [
        "import x from 'y';",
        '',
        'export const DOCS_SCHEMA_RELEASES: Readonly<Record<string, string>> = Object.freeze({',
        "  '3.1': '3.1.20',",
        "  '3.2-beta': '3.2.0-beta.11',",
        "  '2.5': '2.5.3',",
        '});',
        '',
        "const OTHER = Object.freeze({ '3.1': 'untouched' });",
        '',
      ].join('\n')
    );
  });

  test('adds a promoted prerelease channel without discarding the frozen beta', () => {
    const source = [
      'export const DOCS_SCHEMA_RELEASES = Object.freeze({',
      "  '3.1': '3.1.20',",
      "  '3.2-beta': '3.2.0-beta.12',",
      "  '3.0': '3.0.26',",
      '});',
      '',
    ].join('\n');
    const config = {
      navigation: {
        versions: [
          versionEntry('3.1', '3.1.20', { default: true, tag: 'Latest' }),
          versionEntry('3.2-beta', '3.2.0-beta.12'),
          versionEntry('3.0', '3.0.26'),
        ],
      },
    };

    updateDocsConfig(config, '3.2.0-rc.0', '3.2-rc');

    assert.equal(
      updateSchemaTools(source, config),
      [
        'export const DOCS_SCHEMA_RELEASES = Object.freeze({',
        "  '3.1': '3.1.20',",
        "  '3.2-rc': '3.2.0-rc.0',",
        "  '3.2-beta': '3.2.0-beta.12',",
        "  '3.0': '3.0.26',",
        '});',
        '',
      ].join('\n')
    );
  });

  test('schema routing sync fails loudly instead of guessing', () => {
    assert.throws(
      () => updateSchemaTools('export const NOPE = 1;\n', sampleConfig()),
      /must declare DOCS_SCHEMA_RELEASES/
    );
    // The sample default still uses live docs/ pages, so it has no build.
    assert.throws(
      () => updateSchemaTools(
        "export const DOCS_SCHEMA_RELEASES = Object.freeze({\n  '3.0': '3.0.0',\n});\n",
        sampleConfig()
      ),
      /must reference exactly one dist\/docs build/
    );
  });

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
    assert.equal(
      added.groups[3].openapi.source,
      'https://raw.githubusercontent.com/adcontextprotocol/adcp/v3.1.0-rc.5/static/openapi/registry.yaml'
    );

    const allStrings = collectStrings(added.groups);
    assert.equal(allStrings.some((value) => value.startsWith('docs/')), false);
  });

  test('retargets the prerelease banner when adding a beta docs version', () => {
    const config = sampleConfig();

    updateDocsConfig(config, '3.1.0-beta.0', '3.1-beta');

    assert.equal(
      config.banner.content,
      'AdCP 3.1 beta is available — [start testing →](/dist/docs/3.1.0-beta.0/reference/3-1-beta)'
    );
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
    assert.equal(
      updated.groups[1].openapi.source,
      'https://raw.githubusercontent.com/adcontextprotocol/adcp/v3.1.0-rc.5/static/openapi/registry.yaml'
    );
  });

  test('retargets a prerelease banner to the latest immutable beta snapshot', () => {
    const config = sampleConfig();
    config.banner.content =
      'AdCP 3.1 beta is available — [start testing →](/dist/docs/3.1.0-beta.4/reference/3-1-beta)';
    config.navigation.versions.splice(1, 0, {
      version: '3.1-beta',
      groups: [
        {
          group: 'Getting Started',
          pages: ['dist/docs/3.1.0-beta.4/intro'],
        },
        {
          group: 'Reference',
          pages: ['dist/docs/3.1.0-beta.4/reference/3-1-beta'],
        },
      ],
    });

    updateDocsConfig(config, '3.1.0-beta.5', '3.1-beta');

    assert.equal(
      config.banner.content,
      'AdCP 3.1 beta is available — [start testing →](/dist/docs/3.1.0-beta.5/reference/3-1-beta)'
    );
  });

  test('retargets an official prerelease release URL to the new checkpoint', () => {
    const config = sampleConfig();
    config.banner.content =
      'AdCP 3.1 release candidate is available — [start testing →](https://github.com/adcontextprotocol/adcp/releases/tag/v3.1.0-rc.4)';

    updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');

    assert.equal(
      config.banner.content,
      'AdCP 3.1 release candidate is available — [start testing →](https://github.com/adcontextprotocol/adcp/releases/tag/v3.1.0-rc.5)'
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

  test('retargets clean-route aliases with an existing default snapshot', () => {
    const config = sampleConfig();
    config.navigation.versions[0].groups = [
      {
        group: 'Getting Started',
        pages: [
          'dist/docs/3.0.0/intro',
          'dist/docs/3.0.0/quickstart',
        ],
      },
    ];
    config.redirects = [
      {
        source: '/docs/intro',
        destination: '/dist/docs/3.0.0/intro',
        permanent: false,
      },
      {
        source: '/unrelated',
        destination: '/docs/faq',
      },
    ];

    updateDocsConfig(config, '3.0.1', '3.0');

    assert.deepEqual(config.redirects, [
      {
        source: '/docs/intro',
        destination: '/dist/docs/3.0.1/intro',
        permanent: false,
      },
      {
        source: '/unrelated',
        destination: '/docs/faq',
      },
      {
        source: '/docs/quickstart',
        destination: '/dist/docs/3.0.1/quickstart',
        permanent: false,
      },
    ]);
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

  test('renders the current llms index from the default stable docs version and build', () => {
    const config = sampleConfig();
    config.navigation.versions[0].groups = [{
      group: 'Getting Started',
      pages: [
        'dist/docs/3.0.26/intro',
        'dist/docs/3.0.26/quickstart',
      ],
    }];

    updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');

    assert.equal(
      renderCurrentLlmsIndex(config),
      [
        '# AdCP Current Documentation: 3.0',
        '',
        '> Current stable AdCP documentation. Version: 3.0. Build: 3.0.26.',
        '',
        '## Indexes',
        '',
        '- [AdCP 3.0 full index](https://docs.adcontextprotocol.org/_llms/3-0.md): Complete current documentation index for build 3.0.26.',
        '- [AdCP 3.0 protocol index](https://docs.adcontextprotocol.org/_llms/3-0/protocol.md): Complete current protocol documentation for build 3.0.26.',
        '',
      ].join('\n')
    );
  });

  test('removes obsolete Markdown redirects in favor of the source page', () => {
    const config = sampleConfig();
    config.redirects = [
      {
        source: '/llms-current.md',
        destination: '/_llms/2-5.md',
        permanent: true,
      },
      {
        source: '/_llms/current.md',
        destination: '/_llms/2-5.md',
        permanent: false,
      },
      {
        source: '/llms-current.md',
        destination: '/_llms/3-2-beta.md',
        permanent: false,
      },
      {
        source: '/unrelated',
        destination: '/docs/faq',
      },
    ];

    updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');

    assert.deepEqual(config.redirects, [{
      source: '/unrelated',
      destination: '/docs/faq',
    }]);
  });

  test('does not add a Markdown redirect when redirects are absent', () => {
    const config = sampleConfig();

    updateDocsConfig(config, '3.1.0-rc.5', '3.1-rc');
    updateDocsConfig(config, '3.1.0-rc.6', '3.1-rc');

    assert.deepEqual(config.redirects, undefined);
  });

  test('CLI writes the current llms source alongside release navigation updates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-docs-nav-'));
    const docsJson = path.join(root, 'docs.json');
    const dockerignore = path.join(root, '.dockerignore');
    const schemaTools = path.join(root, 'schema-tools.ts');
    const currentIndex = path.join(root, 'llms-current.md');
    const config = sampleConfig();
    config.navigation.versions[0].groups = [{
      group: 'Getting Started',
      pages: ['dist/docs/3.0.0/intro'],
    }];

    try {
      fs.writeFileSync(docsJson, `${JSON.stringify(config)}\n`);
      fs.writeFileSync(dockerignore, 'dist/docs/*\n!dist/schemas\n');
      fs.writeFileSync(
        schemaTools,
        "export const DOCS_SCHEMA_RELEASES = Object.freeze({\n  '3.0': '3.0.0',\n});\n"
      );

      execFileSync(process.execPath, [
        path.join(__dirname, '../scripts/update-release-docs-nav.mjs'),
        '3.0.1',
        '3.0',
        docsJson,
        dockerignore,
        schemaTools,
        currentIndex,
      ]);

      const rendered = fs.readFileSync(currentIndex, 'utf8');
      assert.match(rendered, /Version: 3\.0\. Build: 3\.0\.1\./);
      assert.match(rendered, /https:\/\/docs\.adcontextprotocol\.org\/_llms\/3-0\.md/);
      assert.equal(
        JSON.parse(fs.readFileSync(docsJson, 'utf8')).navigation.versions[0].groups[0].pages[0],
        'dist/docs/3.0.1/intro'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('carries the 3.2 story from beta to RC and retargets its public aliases', () => {
    const config = sampleConfig();
    config.banner.content =
      'AdCP 3.2 preview is available — [see what is new →](/3.2)';
    config.navigation.versions.splice(1, 0, {
      version: '3.2-beta',
      groups: [
        {
          group: 'Release notes & migration',
          pages: [
            'dist/docs/3.2.0-beta.9/reference/whats-new-in-3-2',
            'dist/docs/3.2.0-beta.9/reference/migration/3-1-to-3-2',
          ],
        },
        {
          group: 'Media Buy',
          pages: [
            'dist/docs/3.2.0-beta.9/media-buy/product-discovery/proposal-negotiation',
          ],
        },
      ],
    });
    config.redirects = [
      {
        source: '/3.2',
        destination: '/dist/docs/3.2.0-beta.9/reference/whats-new-in-3-2',
        permanent: false,
      },
      {
        source: '/3.2/try',
        destination:
          '/dist/docs/3.2.0-beta.9/media-buy/product-discovery/proposal-negotiation',
        permanent: false,
      },
    ];

    const result = updateDocsConfig(config, '3.2.0-rc.0', '3.2-rc');

    assert.equal(result.action, 'added');
    assert.equal(result.sourceVersion, '3.2-beta');
    assert.deepEqual(
      config.navigation.versions.map((entry) => entry.version),
      ['3.0', '3.2-rc', '3.2-beta', '2.5']
    );
    const added = config.navigation.versions.find((entry) => entry.version === '3.2-rc');
    const strings = collectStrings(added.groups);
    assert.ok(strings.includes('dist/docs/3.2.0-rc.0/reference/whats-new-in-3-2'));
    assert.ok(
      strings.includes(
        'dist/docs/3.2.0-rc.0/media-buy/product-discovery/proposal-negotiation'
      )
    );
    assert.deepEqual(
      config.redirects.map((redirect) => redirect.destination),
      [
        '/dist/docs/3.2.0-rc.0/reference/whats-new-in-3-2',
        '/dist/docs/3.2.0-rc.0/media-buy/product-discovery/proposal-negotiation',
      ]
    );
    assert.equal(
      config.banner.content,
      'AdCP 3.2 preview is available — [see what is new →](/3.2)'
    );
  });

  // --- Stable minor GA (3.2.1 promotes 3.2 over 3.1) ---

  function gaFixture() {
    const pages = (build, paths) => paths.map((page) => `dist/docs/${build}/${page}`);
    const previewGroups = (build) => [
      {
        group: 'Getting Started',
        pages: pages(build, ['intro', 'quickstart']),
      },
      {
        group: 'Release notes & migration',
        pages: pages(build, ['reference/whats-new-in-3-2', 'reference/3-2-beta']),
      },
      {
        group: 'Registry API',
        openapi: {
          source: `https://raw.githubusercontent.com/adcontextprotocol/adcp/v${build}/static/openapi/registry.yaml`,
          directory: `dist/docs/${build}/registry/api-reference`,
        },
        pages: pages(build, ['registry/index']),
      },
    ];
    return {
      banner: {
        content: "The AdCP 3.2 release candidate is here — [see what's new →](/3.2)",
      },
      navigation: {
        versions: [
          {
            version: '3.1',
            tag: 'Latest',
            default: true,
            groups: [
              { group: 'Getting Started', pages: pages('3.1.24', ['intro', 'quickstart']) },
              { group: 'Reference', pages: pages('3.1.24', ['reference/retired-in-3-2']) },
            ],
          },
          { version: '3.2-rc', tag: 'Latest', groups: previewGroups('3.2.0-rc.7') },
          { version: '3.2-beta', groups: previewGroups('3.2.0-beta.11') },
          versionEntry('3.0', '3.0.26'),
          versionEntry('2.5 (archived)', '2.5.3'),
        ],
      },
      redirects: [
        { source: '/docs/intro', destination: '/dist/docs/3.1.24/intro', permanent: false },
        { source: '/docs/quickstart', destination: '/dist/docs/3.1.24/quickstart', permanent: false },
        {
          source: '/docs/reference/retired-in-3-2',
          destination: '/dist/docs/3.1.24/reference/retired-in-3-2',
          permanent: false,
        },
        {
          source: '/3.2',
          destination: '/dist/docs/3.2.0-rc.7/reference/whats-new-in-3-2',
          permanent: false,
        },
        {
          source: '/docs/reference/3-2-beta',
          destination: '/dist/docs/3.2.0-rc.7/reference/3-2-beta',
          permanent: false,
        },
        { source: '/unrelated', destination: '/docs/faq' },
      ],
    };
  }

  const GA_SCHEMA_TOOLS = [
    'export const DOCS_SCHEMA_RELEASES: Readonly<Record<string, string>> = Object.freeze({',
    "  '3.1': '3.1.24',",
    "  '3.2-rc': '3.2.0-rc.7',",
    "  '3.2-beta': '3.2.0-beta.11',",
    "  '3.0': '3.0.26',",
    "  '2.5': '2.5.3',",
    '});',
    '',
  ].join('\n');

  function assertSingleDefaultAndLatest(config, expectedVersion) {
    const versions = docsNavigationVersions(config);
    assert.deepEqual(
      versions.filter((entry) => entry.default).map((entry) => entry.version),
      [expectedVersion]
    );
    assert.equal(versions[0].version, expectedVersion, 'Mintlify requires the default first');
    assert.deepEqual(
      versions.filter((entry) => entry.tag === 'Latest').map((entry) => entry.version),
      [expectedVersion]
    );
  }

  function assertCleanRouteAliases(config) {
    const defaultEntry = docsNavigationVersions(config).find((entry) => entry.default);
    const bySource = new Map(config.redirects.map((redirect) => [redirect.source, redirect]));
    for (const page of collectStrings(defaultEntry.groups).filter((value) => value.startsWith('dist/docs/'))) {
      const cleanPath = `/docs/${page.split('/').slice(3).join('/')}`;
      assert.deepEqual(
        bySource.get(cleanPath),
        { source: cleanPath, destination: `/${page}`, permanent: false },
        `missing clean-route alias ${cleanPath}`
      );
    }
  }

  test('a stable 3.2.1 GA promotes 3.2 to the only default and retires its preview selectors', () => {
    const config = gaFixture();
    const result = updateDocsConfig(config, '3.2.1', '3.2');

    assert.equal(result.action, 'promoted');
    assert.equal(result.sourceVersion, '3.2-rc');
    assert.equal(result.previousDefault, '3.1');
    assert.deepEqual(result.retired, ['3.2-rc', '3.2-beta']);
    assert.deepEqual(
      config.navigation.versions.map((entry) => entry.version),
      ['3.2', '3.1', '3.0', '2.5 (archived)']
    );
    assertSingleDefaultAndLatest(config, '3.2');

    const promoted = config.navigation.versions[0];
    assert.deepEqual(Object.keys(promoted), ['version', 'tag', 'groups', 'default']);
    const promotedStrings = collectStrings(promoted.groups);
    assert.ok(promotedStrings.includes('dist/docs/3.2.1/reference/whats-new-in-3-2'));
    assert.equal(
      promotedStrings.filter((value) => value.includes('/')).every((value) =>
        value.startsWith('dist/docs/3.2.1/') || value.includes('/adcp/v3.2.1/')
      ),
      true
    );
    assert.equal(
      promoted.groups[2].openapi.source,
      'https://raw.githubusercontent.com/adcontextprotocol/adcp/v3.2.1/static/openapi/registry.yaml'
    );

    const demoted = config.navigation.versions[1];
    assert.deepEqual(Object.keys(demoted), ['version', 'groups']);
    assert.equal(demoted.groups[0].pages[0], 'dist/docs/3.1.24/intro');

    assertCleanRouteAliases(config);
    const bySource = new Map(config.redirects.map((redirect) => [redirect.source, redirect.destination]));
    assert.equal(bySource.get('/docs/intro'), '/dist/docs/3.2.1/intro');
    // Pages that only the old default has keep resolving to its immutable snapshot.
    assert.equal(
      bySource.get('/docs/reference/retired-in-3-2'),
      '/dist/docs/3.1.24/reference/retired-in-3-2'
    );
    // Release-story aliases, including the retired prerelease landing page, follow GA.
    assert.equal(bySource.get('/3.2'), '/dist/docs/3.2.1/reference/whats-new-in-3-2');
    assert.equal(bySource.get('/docs/reference/3-2-beta'), '/dist/docs/3.2.1/reference/3-2-beta');
    assert.equal(bySource.get('/unrelated'), '/docs/faq');

    assert.match(renderCurrentLlmsIndex(config), /^# AdCP Current Documentation: 3\.2\n/);
    assert.match(renderCurrentLlmsIndex(config), /Version: 3\.2\. Build: 3\.2\.1\./);
    assert.match(renderCurrentLlmsIndex(config), /_llms\/3-2\.md/);

    assert.equal(
      updateSchemaTools(GA_SCHEMA_TOOLS, config),
      [
        'export const DOCS_SCHEMA_RELEASES: Readonly<Record<string, string>> = Object.freeze({',
        "  '3.2': '3.2.1',",
        "  '3.1': '3.1.24',",
        "  '3.0': '3.0.26',",
        "  '2.5': '2.5.3',",
        '});',
        '',
      ].join('\n')
    );
  });

  test('after GA, stable patches on the new and old lines keep one default', () => {
    const config = gaFixture();
    updateDocsConfig(config, '3.2.1', '3.2');

    const patch = updateDocsConfig(config, '3.2.2', '3.2');
    assert.equal(patch.action, 'updated');
    assertSingleDefaultAndLatest(config, '3.2');
    assertCleanRouteAliases(config);
    assert.match(renderCurrentLlmsIndex(config), /Version: 3\.2\. Build: 3\.2\.2\./);

    const maintenance = updateDocsConfig(config, '3.1.25', '3.1');
    assert.equal(maintenance.action, 'updated');
    assertSingleDefaultAndLatest(config, '3.2');
    assert.equal(config.navigation.versions[1].groups[0].pages[0], 'dist/docs/3.1.25/intro');
    assert.equal(
      new Map(config.redirects.map((redirect) => [redirect.source, redirect.destination])).get('/docs/intro'),
      '/dist/docs/3.2.2/intro'
    );
    assert.match(renderCurrentLlmsIndex(config), /Build: 3\.2\.2\./);
  });

  test('GA promotes an existing non-default stable entry instead of duplicating it', () => {
    const config = gaFixture();
    config.navigation.versions.splice(1, 0, {
      version: '3.2',
      tag: 'Latest',
      groups: [{ group: 'Getting Started', pages: ['dist/docs/3.2.0-rc.7/intro'] }],
    });

    const result = updateDocsConfig(config, '3.2.1', '3.2');

    assert.equal(result.action, 'promoted');
    assert.equal(result.sourceVersion, '3.2');
    assert.deepEqual(
      config.navigation.versions.map((entry) => entry.version),
      ['3.2', '3.1', '3.0', '2.5 (archived)']
    );
    assertSingleDefaultAndLatest(config, '3.2');
    assert.deepEqual(collectStrings(config.navigation.versions[0].groups), [
      'Getting Started',
      'dist/docs/3.2.1/intro',
    ]);
  });

  test('GA refuses a prerelease build for a stable label and a live-docs default', () => {
    assert.throws(
      () => updateDocsConfig(gaFixture(), '3.2.0-rc.8', '3.2'),
      /can only be promoted by a stable 3\.2\.N release/
    );
    const config = gaFixture();
    config.navigation.versions[0].groups[0].pages.push('docs/live-page');
    assert.throws(
      () => updateDocsConfig(config, '3.2.1', '3.2'),
      /still references live docs\/ pages/
    );
  });

  test('CLI flips temp copies of the repository docs.json and schema-tools.ts for 3.2.1 GA', (t) => {
    const repoRoot = path.join(__dirname, '..');
    const repoConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs.json'), 'utf8'));
    const repoDefault = docsNavigationVersions(repoConfig).find((entry) => entry.default);
    const [major, minor] = repoDefault.version.split('.').map(Number);
    if (major > 3 || (major === 3 && minor > 2)) {
      t.skip(`docs default ${repoDefault.version} is newer than the 3.2 GA flip`);
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-docs-ga-'));
    const files = {
      docsJson: path.join(root, 'docs.json'),
      dockerignore: path.join(root, '.dockerignore'),
      schemaTools: path.join(root, 'schema-tools.ts'),
      currentIndex: path.join(root, 'llms-current.md'),
    };
    try {
      fs.copyFileSync(path.join(repoRoot, 'docs.json'), files.docsJson);
      fs.copyFileSync(path.join(repoRoot, '.dockerignore'), files.dockerignore);
      fs.copyFileSync(
        path.join(repoRoot, 'server/src/addie/mcp/schema-tools.ts'),
        files.schemaTools
      );

      const stdout = execFileSync(process.execPath, [
        path.join(repoRoot, 'scripts/update-release-docs-nav.mjs'),
        '3.2.1',
        '3.2',
        files.docsJson,
        files.dockerignore,
        files.schemaTools,
        files.currentIndex,
      ], { encoding: 'utf8' });

      const config = JSON.parse(fs.readFileSync(files.docsJson, 'utf8'));
      if (repoDefault.version === '3.1') {
        assert.match(stdout, /Promoted docs\.json version 3\.2 .* to the default; demoted 3\.1/);
      }
      assertSingleDefaultAndLatest(config, '3.2');
      assert.equal(
        docsNavigationVersions(config).some((entry) => /^3\.2-/.test(entry.version)),
        false,
        '3.2 prerelease selectors must leave the version picker'
      );
      assert.ok(docsNavigationVersions(config).some((entry) => entry.version === '3.1'));
      assertCleanRouteAliases(config);
      const bySource = new Map(config.redirects.map((redirect) => [redirect.source, redirect.destination]));
      assert.equal(bySource.get('/3.2'), '/dist/docs/3.2.1/reference/whats-new-in-3-2');
      assert.equal(bySource.get('/docs/reference/3-2-beta'), '/dist/docs/3.2.1/reference/3-2-beta');

      const currentIndex = fs.readFileSync(files.currentIndex, 'utf8');
      assert.match(currentIndex, /^# AdCP Current Documentation: 3\.2\n/);
      assert.match(currentIndex, /Version: 3\.2\. Build: 3\.2\.1\./);

      const schemaTools = fs.readFileSync(files.schemaTools, 'utf8');
      const releases = /DOCS_SCHEMA_RELEASES[^{]*\{\n([\s\S]*?)\n\}\);/.exec(schemaTools)[1];
      assert.match(releases, /^ {2}'3\.2': '3\.2\.1',$/m);
      assert.equal(releases.split('\n')[0], "  '3.2': '3.2.1',", 'the docs default leads the schema map');
      assert.doesNotMatch(releases, /'3\.2-(?:rc|beta)'/);
      assert.match(fs.readFileSync(files.dockerignore, 'utf8'), /^!dist\/docs\/3\.2\.1$/m);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- Release story for any minor line (3.3 beta on top of the 3.2 default) ---

  function storyFixture({ default32 = '3.2.2', seed33 = '3.3.0-beta.0' } = {}) {
    const pages = (build, paths) => paths.map((page) => `dist/docs/${build}/${page}`);
    return {
      banner: {
        content: "AdCP 3.2 is generally available — [see what's new →](/3.2)",
      },
      navigation: {
        versions: [
          {
            version: '3.2',
            tag: 'Latest',
            default: true,
            groups: [
              { group: 'Getting Started', pages: pages(default32, ['intro', 'quickstart']) },
              {
                group: 'Building with AdCP',
                pages: [
                  ...pages(default32, ['building/index']),
                  {
                    group: 'Release notes & migration',
                    pages: pages(default32, [
                      'reference/whats-new-in-v3',
                      'reference/whats-new-in-3-1',
                      'reference/whats-new-in-3-2',
                      'reference/3-2-beta',
                      'reference/migration/index',
                      'reference/migration/3-0-to-3-1',
                      'reference/migration/3-1-to-3-2',
                      'reference/migration/channels',
                    ]),
                  },
                ],
              },
            ],
          },
          versionEntry('3.1', '3.1.24'),
          versionEntry('2.5 (archived)', '2.5.3'),
        ],
      },
      redirects: [
        { source: '/3.2', destination: `/dist/docs/${default32}/reference/whats-new-in-3-2`, permanent: false },
        { source: '/3.2/try', destination: `/dist/docs/${default32}/media-buy/product-discovery/proposal-negotiation`, permanent: false },
        { source: '/3.2/migrate', destination: `/dist/docs/${default32}/reference/migration/3-1-to-3-2`, permanent: false },
        { source: '/3.2/sdk', destination: `/dist/docs/${default32}/building/by-layer/L4/choose-your-sdk`, permanent: false },
        { source: '/docs/reference/whats-new-in-3-2', destination: `/dist/docs/${default32}/reference/whats-new-in-3-2`, permanent: false },
        { source: '/docs/reference/3-2-beta', destination: `/dist/docs/${default32}/reference/3-2-beta`, permanent: false },
        { source: '/docs/reference/migration/3-1-to-3-2', destination: `/dist/docs/${default32}/reference/migration/3-1-to-3-2`, permanent: false },
        { source: '/docs/media-buy/product-discovery/proposal-negotiation', destination: `/dist/docs/${default32}/media-buy/product-discovery/proposal-negotiation`, permanent: false },
        { source: '/docs/reference/whats-new-in-3-1', destination: `/dist/docs/${default32}/reference/whats-new-in-3-1`, permanent: false },
        { source: '/docs/reference/migration/3-0-to-3-1', destination: `/dist/docs/${default32}/reference/migration/3-0-to-3-1`, permanent: false },
        ...(seed33 === 'source'
          ? [
              { source: '/3.3', destination: '/docs/reference/whats-new-in-3-3', permanent: false },
              { source: '/3.3/try', destination: '/docs/reference/3-3-beta', permanent: false },
              { source: '/3.3/migrate', destination: '/docs/reference/migration/3-2-to-3-3', permanent: false },
              { source: '/3.3/sdk', destination: `/dist/docs/${default32}/building/by-layer/L4/choose-your-sdk`, permanent: false },
            ]
          : [
            { source: '/3.3', destination: `/dist/docs/${seed33}/reference/whats-new-in-3-3`, permanent: false },
            { source: '/3.3/try', destination: `/dist/docs/${seed33}/reference/3-3-beta`, permanent: false },
            { source: '/3.3/migrate', destination: `/dist/docs/${seed33}/reference/migration/3-2-to-3-3`, permanent: false },
            { source: '/3.3/sdk', destination: `/dist/docs/${seed33}/building/by-layer/L4/choose-your-sdk`, permanent: false },
            { source: '/docs/reference/whats-new-in-3-3', destination: `/dist/docs/${seed33}/reference/whats-new-in-3-3`, permanent: false },
            { source: '/docs/reference/3-3-beta', destination: `/dist/docs/${seed33}/reference/3-3-beta`, permanent: false },
            { source: '/docs/reference/migration/3-2-to-3-3', destination: `/dist/docs/${seed33}/reference/migration/3-2-to-3-3`, permanent: false },
            ]),
        { source: '/unrelated', destination: '/docs/faq' },
      ],
    };
  }

  const STORY_33_PAGES = new Set([
    'dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3',
    'dist/docs/3.3.0-beta.0/reference/3-3-beta',
    'dist/docs/3.3.0-beta.0/reference/migration/3-2-to-3-3',
  ]);
  const hasStory33 = (page) => STORY_33_PAGES.has(page);

  function destinations(config) {
    return Object.fromEntries(config.redirects.map((redirect) => [redirect.source, redirect.destination]));
  }

  function storyGroup(entry) {
    return entry.groups
      .flatMap((group) => group.pages)
      .find((page) => page && page.group === 'Release notes & migration')
      ?? entry.groups.find((group) => group.group === 'Release notes & migration');
  }

  test('a 3.3 beta.0 snapshot adds the 3.3 story beside the 3.2 pages and keeps the 3.2 aliases', () => {
    const config = storyFixture({ seed33: '3.3.0-pending' });
    const before = destinations(config);

    const result = updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    assert.equal(result.action, 'added');
    assert.equal(result.sourceVersion, '3.2');
    assert.deepEqual(result.storyPagesAdded, [
      'reference/whats-new-in-3-3',
      'reference/3-3-beta',
      'reference/migration/3-2-to-3-3',
    ]);
    assert.deepEqual(config.navigation.versions.map((entry) => entry.version), ['3.2', '3.3-beta', '3.1', '2.5 (archived)']);

    const added = config.navigation.versions[1];
    assert.equal(added.default, undefined);
    const pages = storyGroup(added).pages;
    assert.deepEqual(pages.slice(0, 7), [
      'dist/docs/3.3.0-beta.0/reference/whats-new-in-v3',
      'dist/docs/3.3.0-beta.0/reference/whats-new-in-3-1',
      'dist/docs/3.3.0-beta.0/reference/whats-new-in-3-2',
      'dist/docs/3.3.0-beta.0/reference/3-2-beta',
      'dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3',
      'dist/docs/3.3.0-beta.0/reference/3-3-beta',
      'dist/docs/3.3.0-beta.0/reference/migration/index',
    ]);
    assert.deepEqual(pages.slice(-3), [
      'dist/docs/3.3.0-beta.0/reference/migration/3-1-to-3-2',
      'dist/docs/3.3.0-beta.0/reference/migration/3-2-to-3-3',
      'dist/docs/3.3.0-beta.0/reference/migration/channels',
    ]);
    // The default stays pinned to its own snapshot.
    assert.equal(collectStrings(config.navigation.versions[0].groups).some((value) => value.includes('3.3.0')), false);

    const after = destinations(config);
    for (const source of Object.keys(before).filter(
      (key) => /3\.2|3-2|proposal-negotiation|3-1|3-0/.test(key) && !/3\.3|3-3/.test(key)
    )) {
      assert.equal(after[source], before[source], `${source} keeps pointing where it did`);
    }
    assert.equal(after['/3.3'], '/dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3');
    assert.equal(after['/unrelated'], '/docs/faq');
    assert.ok(result.warnings.some((warning) => /banner does not link to the 3\.3 release story/.test(warning)));
  });

  test('a 3.3 beta checkpoint retargets only the 3.3 story aliases', () => {
    const config = storyFixture();
    updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });
    const before = destinations(config);

    const result = updateDocsConfig(config, '3.3.0-beta.1', '3.3-beta', { snapshotHasPage: hasStory33 });

    assert.equal(result.action, 'updated');
    const after = destinations(config);
    assert.equal(after['/3.3'], '/dist/docs/3.3.0-beta.1/reference/whats-new-in-3-3');
    assert.equal(after['/3.3/try'], '/dist/docs/3.3.0-beta.1/reference/3-3-beta');
    assert.equal(after['/3.3/migrate'], '/dist/docs/3.3.0-beta.1/reference/migration/3-2-to-3-3');
    assert.equal(after['/3.3/sdk'], '/dist/docs/3.3.0-beta.1/building/by-layer/L4/choose-your-sdk');
    assert.equal(after['/docs/reference/whats-new-in-3-3'], '/dist/docs/3.3.0-beta.1/reference/whats-new-in-3-3');
    assert.equal(after['/docs/reference/3-3-beta'], '/dist/docs/3.3.0-beta.1/reference/3-3-beta');
    assert.equal(after['/docs/reference/migration/3-2-to-3-3'], '/dist/docs/3.3.0-beta.1/reference/migration/3-2-to-3-3');
    for (const source of Object.keys(before).filter((key) => !/3\.3|3-3/.test(key))) {
      assert.equal(after[source], before[source], `${source} is not a 3.3 story alias`);
    }
    assert.ok(
      collectStrings(config.navigation.versions[1].groups).every(
        (value) => !value.startsWith('dist/docs/') || value.startsWith('dist/docs/3.3.0-beta.1/')
      )
    );
  });

  test('the 3.3 beta snapshot reports story pages it cannot find and a banner still on 3.2', () => {
    const config = storyFixture();

    const result = updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', {
      snapshotHasPage: (page) => page.endsWith('/reference/whats-new-in-3-3'),
    });

    assert.deepEqual(result.storyPagesAdded, ['reference/whats-new-in-3-3']);
    assert.match(result.warnings[0], /reference\/3-3-beta, reference\/migration\/3-2-to-3-3/);
    assert.equal(result.warnings.length, 2);
  });

  test('a 3.3 banner that already links the line story raises no banner warning', () => {
    const config = storyFixture();
    config.banner.content = 'AdCP 3.3 beta is available — [start testing →](/3.3)';

    const result = updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    assert.deepEqual(result.warnings, []);
    assert.equal(config.banner.content, 'AdCP 3.3 beta is available — [start testing →](/3.3)');
  });

  test('a 3.2 patch while 3.2 is the default still retargets its whole story, as before', () => {
    const config = storyFixture();

    updateDocsConfig(config, '3.2.3', '3.2');

    const after = destinations(config);
    assert.equal(after['/3.2'], '/dist/docs/3.2.3/reference/whats-new-in-3-2');
    assert.equal(after['/3.2/try'], '/dist/docs/3.2.3/media-buy/product-discovery/proposal-negotiation');
    assert.equal(after['/3.2/migrate'], '/dist/docs/3.2.3/reference/migration/3-1-to-3-2');
    assert.equal(after['/docs/reference/3-2-beta'], '/dist/docs/3.2.3/reference/3-2-beta');
    assert.equal(
      after['/docs/media-buy/product-discovery/proposal-negotiation'],
      '/dist/docs/3.2.3/media-buy/product-discovery/proposal-negotiation'
    );
    // The default entry's own clean routes move with its snapshot, as before.
    assert.equal(after['/docs/reference/whats-new-in-3-1'], '/dist/docs/3.2.3/reference/whats-new-in-3-1');
    assert.equal(after['/3.3'], '/dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3');
  });

  test('a patch of a line older than the default leaves the default-owned clean routes alone', () => {
    const config = storyFixture();
    config.navigation.versions[2] = versionEntry('3.1', '3.1.24');

    updateDocsConfig(config, '3.1.25', '3.1');

    const after = destinations(config);
    assert.equal(after['/docs/reference/whats-new-in-3-1'], '/dist/docs/3.2.2/reference/whats-new-in-3-1');
    assert.equal(after['/docs/reference/migration/3-0-to-3-1'], '/dist/docs/3.2.2/reference/migration/3-0-to-3-1');
  });

  test('a late patch of an older line keeps its short aliases current but not the default-owned clean routes', () => {
    const config = storyFixture();
    config.navigation.versions.unshift({
      version: '3.3',
      tag: 'Latest',
      default: true,
      groups: [{ group: 'Getting Started', pages: ['dist/docs/3.3.0/intro'] }],
    });
    delete config.navigation.versions[1].default;
    delete config.navigation.versions[1].tag;

    updateDocsConfig(config, '3.2.3', '3.2');

    const after = destinations(config);
    assert.equal(after['/3.2'], '/dist/docs/3.2.3/reference/whats-new-in-3-2');
    assert.equal(after['/3.2/migrate'], '/dist/docs/3.2.3/reference/migration/3-1-to-3-2');
    assert.equal(after['/docs/reference/whats-new-in-3-2'], '/dist/docs/3.2.2/reference/whats-new-in-3-2');
  });

  test('a direct 3.3.0 GA with no preview adds the 3.3 story to the promoted navigation', () => {
    const config = storyFixture();
    const hasGaStory = (page) => page.startsWith('dist/docs/3.3.0/reference/');

    const result = updateDocsConfig(config, '3.3.0', '3.3', { snapshotHasPage: hasGaStory });

    assert.equal(result.action, 'promoted');
    const promoted = config.navigation.versions[0];
    assert.equal(promoted.version, '3.3');
    const strings = collectStrings(promoted.groups);
    for (const page of ['whats-new-in-3-3', '3-3-beta', 'migration/3-2-to-3-3']) {
      assert.ok(strings.includes(`dist/docs/3.3.0/reference/${page}`), `${page} is in the promoted navigation`);
    }
    assert.deepEqual(result.warnings, []);
  });

  test('the first preview of a new major without a predecessor line still lands its story pages', () => {
    const config = storyFixture();
    config.navigation.versions[0].version = '3.9';
    const stories = new Set([
      'dist/docs/4.0.0-beta.0/reference/whats-new-in-4-0',
      'dist/docs/4.0.0-beta.0/reference/4-0-beta',
    ]);

    const result = updateDocsConfig(config, '4.0.0-beta.0', '4.0-beta', {
      snapshotHasPage: (page) => stories.has(page),
    });

    assert.deepEqual(result.storyPagesAdded, ['reference/whats-new-in-4-0', 'reference/4-0-beta']);
    assert.deepEqual(result.warnings.filter((warning) => /story pages/.test(warning)), []);
  });

  test('story pages in the snapshot but without a nav home are reported separately from missing ones', () => {
    const config = storyFixture();
    config.navigation.versions[0].groups = [
      { group: 'Getting Started', pages: ['dist/docs/3.2.2/intro'] },
    ];

    const result = updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    assert.deepEqual(result.storyPagesAdded, []);
    assert.match(result.warnings[0], /in the 3\.3-beta snapshot but have no place in its navigation/);
    assert.doesNotMatch(result.warnings[0], /not in the 3\.3-beta snapshot/);
  });

  test('a banner linking the story overview directly raises no banner warning', () => {
    const config = storyFixture();
    config.banner.content = 'AdCP 3.3 beta — [see what is new →](/docs/reference/whats-new-in-3-3)';

    const result = updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    assert.deepEqual(result.warnings, []);
  });

  test('a banner linking a different line that shares the 3.3 prefix still warns', () => {
    const config = storyFixture();
    config.banner.content = 'AdCP 3.30 is here — [see what is new →](/3.30)';

    const result = updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    assert.match(result.warnings.join('\n'), /banner does not link to the 3\.3 release story/);
  });

  test('a 3.3 beta.0 snapshot moves source-staged short aliases onto the snapshot and adds the clean page routes', () => {
    const config = storyFixture({ seed33: 'source' });
    const before = destinations(config);
    assert.equal(before['/docs/reference/whats-new-in-3-3'], undefined, 'no clean redirect shadows the source page yet');

    updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    const after = destinations(config);
    assert.equal(after['/3.3'], '/dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3');
    assert.equal(after['/3.3/try'], '/dist/docs/3.3.0-beta.0/reference/3-3-beta');
    assert.equal(after['/3.3/migrate'], '/dist/docs/3.3.0-beta.0/reference/migration/3-2-to-3-3');
    assert.equal(after['/3.3/sdk'], '/dist/docs/3.3.0-beta.0/building/by-layer/L4/choose-your-sdk');
    assert.equal(after['/docs/reference/whats-new-in-3-3'], '/dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3');
    assert.equal(after['/docs/reference/3-3-beta'], '/dist/docs/3.3.0-beta.0/reference/3-3-beta');
    assert.equal(after['/docs/reference/migration/3-2-to-3-3'], '/dist/docs/3.3.0-beta.0/reference/migration/3-2-to-3-3');
    for (const source of ['/docs/reference/whats-new-in-3-3', '/docs/reference/3-3-beta', '/docs/reference/migration/3-2-to-3-3']) {
      assert.equal(config.redirects.find((redirect) => redirect.source === source).permanent, false);
    }
    for (const source of Object.keys(before).filter((key) => !/3\.3|3-3/.test(key))) {
      assert.equal(after[source], before[source], `${source} keeps pointing where it did`);
    }
  });

  test('story redirects stay staged on the source pages while the snapshot lacks them', () => {
    const config = storyFixture({ seed33: 'source' });

    updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: () => false });

    const after = destinations(config);
    assert.equal(after['/3.3'], '/docs/reference/whats-new-in-3-3');
    assert.equal(after['/docs/reference/whats-new-in-3-3'], undefined);
  });

  test('a patch of a line older than the default adds no clean story routes', () => {
    const config = storyFixture({ seed33: 'source' });
    const count = config.redirects.length;

    updateDocsConfig(config, '3.1.25', '3.1', { snapshotHasPage: () => true });

    assert.equal(config.redirects.length, count);
  });

  test('a 3.3 beta.0 snapshot retargets seeded story aliases that point at another build', () => {
    const config = storyFixture({ seed33: '3.3.0-pending' });

    updateDocsConfig(config, '3.3.0-beta.0', '3.3-beta', { snapshotHasPage: hasStory33 });

    const after = destinations(config);
    assert.equal(after['/3.3'], '/dist/docs/3.3.0-beta.0/reference/whats-new-in-3-3');
    assert.equal(after['/docs/reference/migration/3-2-to-3-3'], '/dist/docs/3.3.0-beta.0/reference/migration/3-2-to-3-3');
  });

  test('CLI rejects release versions that are not release-shaped', () => {
    const script = path.join(__dirname, '../scripts/update-release-docs-nav.mjs');
    for (const [version, label] of [
      ['3.3.0-beta.0$&', '3.3-beta'],
      ['../3.3.0', '3.3'],
      ['3.3.0-beta.0', '3.3-beta/..'],
    ]) {
      assert.throws(
        () => execFileSync(process.execPath, [script, version, label], { stdio: 'pipe' }),
        (error) => error.status === 2 && /Invalid release version/.test(String(error.stderr))
      );
    }
  });

  test('CLI adds the 3.3 beta from a copy of the repository docs.json', (t) => {
    const repoRoot = path.join(__dirname, '..');
    const repoConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs.json'), 'utf8'));
    const repoVersions = docsNavigationVersions(repoConfig);
    const repoDefault = repoVersions.find((entry) => entry.default);
    if (repoDefault.version !== '3.2') {
      t.skip(`docs default ${repoDefault.version} is not the 3.2 line this scenario starts from`);
      return;
    }
    // Start from the state before the first 3.3 snapshot, whatever main has since added.
    const keptVersions = repoVersions.filter(
      (entry) => !/^3\.3(?:-|$)/.test(entry.version)
    );
    repoVersions.splice(0, repoVersions.length, ...keptVersions);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-docs-33-'));
    try {
      const reference = path.join(root, 'dist/docs/3.3.0-beta.0/reference');
      fs.mkdirSync(path.join(reference, 'migration'), { recursive: true });
      for (const page of ['whats-new-in-3-3', '3-3-beta', 'migration/3-2-to-3-3']) {
        fs.writeFileSync(path.join(reference, `${page}.mdx`), '---\ntitle: story\n---\n');
      }
      const files = {
        docsJson: path.join(root, 'docs.json'),
        dockerignore: path.join(root, '.dockerignore'),
        schemaTools: path.join(root, 'schema-tools.ts'),
        currentIndex: path.join(root, 'llms-current.md'),
      };
      fs.writeFileSync(files.docsJson, JSON.stringify(repoConfig));
      fs.copyFileSync(path.join(repoRoot, '.dockerignore'), files.dockerignore);
      fs.copyFileSync(path.join(repoRoot, 'server/src/addie/mcp/schema-tools.ts'), files.schemaTools);

      execFileSync(process.execPath, [
        path.join(repoRoot, 'scripts/update-release-docs-nav.mjs'),
        '3.3.0-beta.0',
        '3.3-beta',
        files.docsJson,
        files.dockerignore,
        files.schemaTools,
        files.currentIndex,
      ], { cwd: root, encoding: 'utf8' });

      const config = JSON.parse(fs.readFileSync(files.docsJson, 'utf8'));
      const versions = docsNavigationVersions(config);
      const entry = versions.find((item) => item.version === '3.3-beta');
      const strings = collectStrings(entry.groups);
      for (const page of STORY_33_PAGES) {
        assert.ok(strings.includes(page), `${page} is in the 3.3-beta navigation`);
      }
      assert.equal(versions[0].version, '3.2');
      assert.match(fs.readFileSync(files.schemaTools, 'utf8'), /'3\.3-beta': '3\.3\.0-beta\.0',/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('updates english versions nested under navigation.languages and leaves translations alone', () => {
    const config = {
      banner: { content: 'stable' },
      navigation: {
        languages: [
          {
            language: 'en',
            default: true,
            versions: [
              {
                version: '3.2',
                tag: 'Latest',
                default: true,
                groups: [{ group: 'Getting Started', pages: ['dist/docs/3.2.1/intro'] }],
              },
            ],
          },
          {
            language: 'zh',
            groups: [{ group: '入门', pages: ['docs/zh/intro'] }],
          },
        ],
      },
    };

    const result = updateDocsConfig(config, '3.2.2', '3.2', {
      snapshotHasPage: () => true,
    });

    assert.equal(result.action, 'updated');
    const english = config.navigation.languages.find((entry) => entry.language === 'en');
    const chinese = config.navigation.languages.find((entry) => entry.language === 'zh');
    assert.deepEqual(english.versions[0].groups, [
      { group: 'Getting Started', pages: ['dist/docs/3.2.2/intro'] },
    ]);
    assert.deepEqual(chinese.groups, [{ group: '入门', pages: ['docs/zh/intro'] }]);
    assert.equal(config.navigation.versions, undefined);
    assert.match(renderCurrentLlmsIndex(config), /AdCP Current Documentation: 3\.2/);
  });

  test('throws a clear error when navigation.versions is empty', () => {
    assert.throws(
      () => updateDocsConfig({ navigation: { versions: [] } }, '3.1.0-rc.5', '3.1-rc'),
      /navigation\.versions cannot be empty/
    );
  });
})();
