const test = require('node:test');
const assert = require('node:assert/strict');
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

  test('keeps Addie schema routing on the same frozen release as docs', () => {
    const source = [
      'export const DOCS_SCHEMA_RELEASES = Object.freeze({',
      "  '3.1': '3.1.19',",
      "  '3.2-beta': '3.2.0-beta.10',",
      '});',
      '',
    ].join('\n');

    assert.equal(
      updateSchemaTools(source, '3.1.20', '3.1'),
      source.replace("'3.1.19'", "'3.1.20'")
    );
    assert.equal(
      updateSchemaTools(source, '3.2.0-beta.11', '3.2-beta'),
      source.replace("'3.2.0-beta.10'", "'3.2.0-beta.11'")
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

    assert.equal(
      updateSchemaTools(source, '3.2.0-rc.0', '3.2-rc'),
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

  test('throws a clear error when navigation.versions is empty', () => {
    assert.throws(
      () => updateDocsConfig({ navigation: { versions: [] } }, '3.1.0-rc.5', '3.1-rc'),
      /navigation\.versions cannot be empty/
    );
  });
})();
