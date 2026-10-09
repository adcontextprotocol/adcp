#!/usr/bin/env node
/**
 * Docs navigation validation test suite
 * Validates that docs.json navigation structure is valid for Mintlify,
 * including versioned docs that live under dist/docs/.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { docsNavigationVersions } = require('../scripts/docs-navigation.cjs');

const DOCS_JSON = path.join(__dirname, '../docs.json');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    log(`  ✓ ${name}`, 'success');
  } catch (error) {
    failedTests++;
    log(`  ✗ ${name}`, 'error');
    log(`    ${error.message}`, 'error');
  }
}

/**
 * Recursively collect all page paths from a navigation tree.
 */
function collectPages(node) {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectPages);
  if (node && node.pages) return collectPages(node.pages);
  return [];
}

/**
 * Recursively collect all groups (objects with a `group` key) from a navigation tree.
 */
function collectGroups(node) {
  const groups = [];
  if (Array.isArray(node)) {
    node.forEach(item => groups.push(...collectGroups(item)));
  } else if (node && typeof node === 'object') {
    if (node.group) groups.push(node);
    if (node.pages) groups.push(...collectGroups(node.pages));
  }
  return groups;
}

/**
 * Collect directories where Mintlify generates searchable OpenAPI pages.
 */
function collectOpenApiDirectories(node) {
  if (Array.isArray(node)) return node.flatMap(collectOpenApiDirectories);
  if (!node || typeof node !== 'object') return [];

  const directories = node.openapi?.directory ? [node.openapi.directory] : [];
  if (node.groups) directories.push(...collectOpenApiDirectories(node.groups));
  if (node.pages) directories.push(...collectOpenApiDirectories(node.pages));
  return directories;
}

/**
 * Collect OpenAPI sources from every navigation level.
 */
function collectOpenApiSources(node) {
  if (Array.isArray(node)) return node.flatMap(collectOpenApiSources);
  if (!node || typeof node !== 'object') return [];

  const sources = node.openapi?.source ? [node.openapi.source] : [];
  if (node.groups) sources.push(...collectOpenApiSources(node.groups));
  if (node.pages) sources.push(...collectOpenApiSources(node.pages));
  return sources;
}

function isDirectSlackInvite(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'join.slack.com';
  } catch {
    return false;
  }
}

function containsDirectSlackInvite(content) {
  const urls = content.match(/https?:\/\/[^\s)\]>'\"]+/g) || [];
  return urls.some(isDirectSlackInvite);
}

function snapshotMatchesVersionLabel(label, snapshotVersion) {
  const labelMatch = /^(\d+\.\d+)(?:-([0-9A-Za-z]+)| \(archived\))?$/.exec(label);
  const snapshotMatch = /^(\d+\.\d+)\.\d+(?:-([0-9A-Za-z]+)(?:\.|$))?/.exec(snapshotVersion);
  if (!labelMatch || !snapshotMatch || labelMatch[1] !== snapshotMatch[1]) return false;

  const labelPrerelease = labelMatch[2];
  const snapshotPrerelease = snapshotMatch[2];
  return labelPrerelease
    ? labelPrerelease === snapshotPrerelease
    : snapshotPrerelease === undefined;
}

/**
 * Source pages under docs/ that are intentionally left out of the live-source
 * navigation. Mintlify runs with seo.indexHiddenPages: false, so a page that is
 * not in the sidebar is also missing from site search, sitemap.xml, and the
 * llms indexes. Every entry needs a reason. Entries ending in "/" cover a
 * whole directory.
 */
const NAV_COVERAGE_ALLOWLIST = new Map([
  ['contributing/', 'Contributor and repository-maintenance guides, not protocol documentation'],
  ['zh/', 'Simplified Chinese sources. They are published from navigation.languages at zh/dist/docs/<snapshot>/, not from the English version picker.'],
  ['runbooks/', 'Internal AgenticAdvertising.org operations runbooks'],
  ['snippets/', 'Mintlify snippet sources imported into other pages, not standalone pages'],
  ['aao/aao-admins', 'Internal staff reference; the page sets noindex: true'],
  ['curation/coming-soon', 'Placeholder for an unreleased protocol'],
  ['learning/test-personas', 'Internal personas for evaluating docs, not learner content'],
  [
    'media-buy/advanced-topics/index',
    'Legacy hub page; each child page is listed individually under Media Buy',
  ],
]);

function parseSnapshotVersion(snapshot) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(snapshot);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareSnapshotVersions(left, right) {
  const a = parseSnapshotVersion(left);
  const b = parseSnapshotVersion(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  // A stable release sorts after every prerelease of the same core version.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The live-source version is the navigation entry that tracks docs/ most
 * closely: an entry that routes to docs/ directly, otherwise the entry whose
 * snapshot is the newest release (for example 3.2-rc while 3.2 is in RC, and
 * 3.2 after GA).
 */
function findLiveSourceVersion(versions) {
  let best = null;
  for (const entry of versions) {
    const pages = collectPages(entry.groups);
    if (pages.some(page => page.startsWith('docs/'))) {
      return { entry, snapshot: null, pages };
    }
    const snapshot = pages
      .map(page => /^dist\/docs\/([^/]+)\//.exec(page)?.[1])
      .find(Boolean);
    if (!snapshot || !parseSnapshotVersion(snapshot)) continue;
    if (!best || compareSnapshotVersions(snapshot, best.snapshot) > 0) {
      best = { entry, snapshot, pages };
    }
  }
  return best;
}

function listSourcePages(docsDir) {
  const pages = [];
  const walk = dir => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(fullPath);
      } else if (/\.mdx?$/.test(dirent.name)) {
        pages.push(path.relative(docsDir, fullPath).split(path.sep).join('/').replace(/\.mdx?$/, ''));
      }
    }
  };
  walk(docsDir);
  return pages.sort();
}

function allowlistReason(page) {
  if (NAV_COVERAGE_ALLOWLIST.has(page)) return NAV_COVERAGE_ALLOWLIST.get(page);
  for (const [entry, reason] of NAV_COVERAGE_ALLOWLIST) {
    if (entry.endsWith('/') && page.startsWith(entry)) return reason;
  }
  return null;
}

// --- Run tests ---

log('\n🧪 Docs Navigation Validation Tests');

test('current documentation pages have valid MDX syntax', () => {
  try {
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/check-docs-mdx-syntax.mjs')], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error((error.stderr || error.stdout || error.message).trim());
  }
});
log('====================================\n');

const docsConfig = JSON.parse(fs.readFileSync(DOCS_JSON, 'utf8'));
const { navigation } = docsConfig;
const resolvedVersions = docsNavigationVersions(docsConfig);

if (!navigation || !resolvedVersions) {
  log('No navigation.versions found in docs.json', 'error');
  process.exit(1);
}

// The version picker may live under the English language entry. Expose it
// here so the rest of this file keeps validating the English snapshots.
navigation.versions = resolvedVersions;

const rootDir = path.join(__dirname, '..');
const defaultVersion = (navigation.versions.find(v => v.default) || navigation.versions[0]).version;
const pageOwners = new Map();
const crossVersionDuplicates = [];

test('default version is first in the versions array', () => {
  if (navigation.versions[0].version !== defaultVersion) {
    throw new Error(
      `Default version "${defaultVersion}" must be first so Mintlify applies ` +
      `the correct default routing and search filter.`
    );
  }
});

test('default version carries the Latest tag', () => {
  const defaultEntry = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  if (defaultEntry.tag !== 'Latest') {
    throw new Error('The default docs version must carry the "Latest" tag');
  }
});

test('current llms index discovers the default docs version and build', () => {
  const aliasUrl = 'https://docs.adcontextprotocol.org/llms-current.md';
  const currentIndex = fs.readFileSync(path.join(rootDir, 'llms-current.md'), 'utf8');
  const expectedDestination = `/_llms/${defaultVersion.replaceAll('.', '-')}.md`;
  const expectedProtocolDestination = `/_llms/${defaultVersion.replaceAll('.', '-')}/protocol.md`;
  const defaultEntry = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const builds = new Set(
    collectPages(defaultEntry.groups)
      .map(page => /^dist\/docs\/([^/]+)\//.exec(page)?.[1])
      .filter(Boolean)
  );
  const [build] = builds;

  if (!docsConfig.description?.includes(aliasUrl)) {
    throw new Error(`docs.json description must advertise ${aliasUrl} for /llms.txt clients`);
  }
  if (docsConfig.redirects?.some(
    redirect => ['/llms-current.md', '/_llms/current.md'].includes(redirect.source)
  )) {
    throw new Error('docs.json must not redirect Markdown index routes that Mintlify Cloud reserves');
  }
  if (builds.size !== 1) {
    throw new Error(
      `the default docs version must reference exactly one build; found ${[...builds].join(', ') || 'none'}`
    );
  }
  for (const expected of [
    `# AdCP Current Documentation: ${defaultVersion}`,
    `Version: ${defaultVersion}. Build: ${build}.`,
    `https://docs.adcontextprotocol.org${expectedDestination}`,
    `https://docs.adcontextprotocol.org${expectedProtocolDestination}`,
  ]) {
    if (!currentIndex.includes(expected)) {
      throw new Error(`llms-current.md must include ${expected}`);
    }
  }
});

test('OpenAPI navigation uses release-pinned public sources', () => {
  const sources = collectOpenApiSources(navigation.versions);
  if (sources.length === 0) {
    throw new Error('Versioned navigation must include an OpenAPI source');
  }

  for (const entry of navigation.versions) {
    const pages = collectPages(entry.groups);
    const snapshot = pages
      .map(page => /^dist\/docs\/([^/]+)\//.exec(page)?.[1])
      .find(Boolean);
    const entrySources = collectOpenApiSources(entry.groups);
    const mutableSources = entrySources.filter(
      source => !snapshot || source !==
        `https://raw.githubusercontent.com/adcontextprotocol/adcp/v${snapshot}/static/openapi/registry.yaml`
    );
    if (mutableSources.length > 0) {
      throw new Error(
        `Docs version ${entry.version} must use its immutable snapshot OpenAPI source: ` +
        mutableSources.join(', ')
      );
    }
  }
});

// The stable maintenance branch follows the docs default: 3.1 -> origin/3.1.x,
// and after the 3.2 GA flip, 3.2 -> origin/3.2.x. Until that branch is cut,
// main itself is the stable surface and CI leaves REQUIRE_STABLE_DOCS_REF unset.
function stableDocsRef() {
  if (process.env.STABLE_DOCS_REF) return process.env.STABLE_DOCS_REF;
  const line = /^(\d+\.\d+)$/.exec(defaultVersion)?.[1];
  if (!line) return null;
  const branch = `${line}.x`;
  // On the stable maintenance branch itself, or a pull request into it, the
  // branch is its own release surface. Comparing against its pre-change tip
  // would reject every navigation change there, including the GA flip that
  // makes it the stable surface.
  if ((process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME) === branch) return 'HEAD';
  return `origin/${branch}`;
}

test('default navigation matches the stable release branch surface', () => {
  const stableRef = stableDocsRef();
  if (!stableRef) {
    throw new Error(`Default docs version "${defaultVersion}" must be a stable X.Y release line`);
  }
  let releaseConfig;
  try {
    releaseConfig = JSON.parse(execFileSync(
      'git',
      ['show', `${stableRef}:docs.json`],
      { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ));
  } catch {
    if (process.env.REQUIRE_STABLE_DOCS_REF === '1') {
      throw new Error(`${stableRef} is required but unavailable`);
    }
    return;
  }

  const currentDefault = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const releaseDefault = releaseConfig.navigation.versions.find(version => version.default)
    || releaseConfig.navigation.versions[0];
  // 3.2.x was cut at v3.2.1 before the GA docs snapshot landed on main.
  // Permit only that exact tag as a bootstrap state. The first maintenance
  // branch update must carry the snapshot or route parity is enforced again.
  if (stableRef === 'origin/3.2.x'
    && currentDefault.version === '3.2'
    && releaseDefault.version === '3.1') {
    const releaseSha = execFileSync('git', ['rev-parse', stableRef], {
      cwd: rootDir, encoding: 'utf8'
    }).trim();
    // This is the v3.2.1 tag target, pinned here because broken-links CI
    // checks out shallowly and does not fetch release tags.
    if (releaseSha === 'c32bd78c5389753e3b8f3ffd8a1c04b777854d83') return;
  }
  const normalize = page => page
    .replace(/^dist\/docs\/[^/]+\//, '')
    .replace(/^docs\//, '');
  const currentRoutes = [
    ...collectPages(currentDefault.groups),
    ...collectOpenApiDirectories(currentDefault.groups),
  ].map(normalize).sort();
  const releaseRoutes = [
    ...collectPages(releaseDefault.groups),
    ...collectOpenApiDirectories(releaseDefault.groups),
  ].map(normalize).sort();

  if (JSON.stringify(currentRoutes) !== JSON.stringify(releaseRoutes)) {
    const releaseSet = new Set(releaseRoutes);
    const currentSet = new Set(currentRoutes);
    const unexpected = currentRoutes.filter(route => !releaseSet.has(route));
    const missing = releaseRoutes.filter(route => !currentSet.has(route));
    throw new Error(
      `Stable navigation drifted from ${stableRef}.`
      + `\n      Unexpected: ${unexpected.join(', ') || 'none'}`
      + `\n      Missing: ${missing.join(', ') || 'none'}`
    );
  }
});

test('prerelease banner links directly or through a public alias to the current preview story', () => {
  const previewVersion = navigation.versions.find(versionEntry =>
    /-(?:rc|beta)$/.test(versionEntry.version)
  );
  if (!previewVersion) return;

  const [majorMinor] = previewVersion.version.split('-');
  const [major, minor] = majorMinor.split('.');
  const landingSuffix = `/reference/${major}-${minor}-beta`;
  const landingPage = collectPages(previewVersion.groups).find(page =>
    page.endsWith(landingSuffix)
  );

  const bannerContent = docsConfig.banner?.content || '';
  const bannerLink = bannerContent.match(/\[[^\]]+\]\(([^)]+)\)/)?.[1];
  const bannerRedirect = docsConfig.redirects?.find(redirect =>
    redirect.source === bannerLink
  );
  const overviewPage = collectPages(previewVersion.groups).find(page =>
    page.endsWith(`/reference/whats-new-in-${major}-${minor}`)
  );
  const previewBuilds = new Set(
    collectPages(previewVersion.groups)
      .map(page => /^dist\/docs\/([^/]+)\//.exec(page)?.[1])
      .filter(Boolean)
  );
  const [previewBuild] = previewBuilds;
  const officialReleaseUrl = previewBuilds.size === 1
    ? `https://github.com/adcontextprotocol/adcp/releases/tag/v${previewBuild}`
    : null;
  const allowedDestinations = new Set([
    landingPage ? `/${landingPage}` : null,
    overviewPage ? `/${overviewPage}` : null,
    officialReleaseUrl
  ]);
  const resolvedDestination = bannerRedirect?.destination || bannerLink;
  if (!allowedDestinations.has(resolvedDestination)) {
    throw new Error(
      `Prerelease banner must resolve to the current story; found ${bannerLink || 'no link'}`
    );
  }
  if (new RegExp(`AdCP ${major}\\.${minor} (?:beta|rc)\\.\\d+`, 'i').test(bannerContent)) {
    throw new Error('Prerelease banner must not freeze a moving prerelease ordinal in its copy');
  }
});

for (const versionEntry of navigation.versions) {
  const { version, groups } = versionEntry;
  log(`Version: ${version}`);

  const allPages = collectPages(groups);
  const allGroups = collectGroups(groups);
  const allSearchRoutes = [...allPages, ...collectOpenApiDirectories(groups)];

  test('uses one canonical route family', () => {
    const livePages = allSearchRoutes.filter(page => page.startsWith('docs/'));
    const snapshotPages = allSearchRoutes.filter(page => page.startsWith('dist/docs/'));
    if (livePages.length > 0 && snapshotPages.length > 0) {
      throw new Error(
        `Version "${version}" mixes live and snapshot routes, which splits its search index`
      );
    }
  });

  for (const page of allPages) {
    const owner = pageOwners.get(page);
    if (owner) {
      crossVersionDuplicates.push(`${page} (${owner}, ${version})`);
    } else {
      pageOwners.set(page, version);
    }
  }

  // Test 1: All page references resolve to files on disk
  test(`all ${allPages.length} page files exist`, () => {
    const missing = [];
    for (const pagePath of allPages) {
      const mdx = path.join(rootDir, pagePath + '.mdx');
      const md = path.join(rootDir, pagePath + '.md');
      if (!fs.existsSync(mdx) && !fs.existsSync(md)) {
        missing.push(pagePath);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Missing files:\n      ${missing.join('\n      ')}`);
    }
  });

  // Test 2: No empty groups
  test('no empty groups', () => {
    const empty = allGroups.filter(g => {
      const pages = collectPages(g.pages || []);
      return pages.length === 0;
    });
    if (empty.length > 0) {
      throw new Error(`Empty groups: ${empty.map(g => g.group).join(', ')}`);
    }
  });

  // Test 3: No duplicate page references
  test('no duplicate page references', () => {
    const seen = new Set();
    const dupes = allPages.filter(p => seen.has(p) || !seen.add(p));
    if (dupes.length > 0) {
      throw new Error(`Duplicate pages: ${dupes.join(', ')}`);
    }
  });

  // Test 4: Page paths should not contain file extensions
  test('page paths have no file extensions', () => {
    const withExt = allPages.filter(p => /\.(mdx?|json|ya?ml)$/.test(p));
    if (withExt.length > 0) {
      throw new Error(`Page paths should not include file extensions: ${withExt.join(', ')}`);
    }
  });

  // Test 5: Versioned (dist/docs/) pages must have consistent version prefix
  const distSearchRoutes = allSearchRoutes.filter(p => p.startsWith('dist/docs/'));
  if (distSearchRoutes.length > 0) {
    test('indexed routes share a consistent snapshot prefix', () => {
      const prefixes = new Set(distSearchRoutes.map(p => {
        const parts = p.split('/');
        return `${parts[0]}/${parts[1]}/${parts[2]}`;
      }));
      if (prefixes.size > 1) {
        throw new Error(`Mixed version prefixes: ${[...prefixes].join(', ')}`);
      }
    });

    test('snapshot prefix matches the version label', () => {
      const snapshotVersion = distSearchRoutes[0].split('/')[2];
      if (!snapshotMatchesVersionLabel(version, snapshotVersion)) {
        throw new Error(
          `Version "${version}" cannot use snapshot "${snapshotVersion}"; ` +
          `Mintlify search filters by the navigation version label`
        );
      }
    });

    test('uses the latest committed snapshot for its release line', () => {
      const snapshotVersion = distSearchRoutes[0].split('/')[2];
      const availableSnapshots = fs.readdirSync(path.join(rootDir, 'dist/docs'), {
        withFileTypes: true,
      })
        .filter(entry => entry.isDirectory() && snapshotMatchesVersionLabel(version, entry.name))
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      const latestSnapshot = availableSnapshots.at(-1);
      if (snapshotVersion !== latestSnapshot) {
        throw new Error(
          `Version "${version}" uses stale snapshot "${snapshotVersion}"; ` +
          `latest committed snapshot is "${latestSnapshot}"`
        );
      }
    });
  }

  // Test 6: Non-default versions must not use a single wrapper group containing sub-groups.
  // Mintlify breaks routing when non-default versions nest all groups inside a wrapper.
  if (version !== defaultVersion) {
    test('non-default version uses flat top-level groups', () => {
      if (groups.length === 1 && groups[0].pages) {
        const hasNestedGroups = groups[0].pages.some(
          p => p && typeof p === 'object' && p.group
        );
        if (hasNestedGroups) {
          throw new Error(
            `Version "${version}" has a single wrapper group "${groups[0].group}" ` +
            `containing nested sub-groups. Non-default versions must use flat ` +
            `top-level groups to avoid Mintlify routing failures.`
          );
        }
      }
    });
  }

  log('');
}

test('simplified chinese navigation publishes translated pages without reusing english paths', () => {
  const languages = navigation.languages;
  if (!Array.isArray(languages)) {
    throw new Error('docs.json navigation.languages is required');
  }
  const english = languages.find((entry) => entry.language === 'en');
  const chinese = languages.find((entry) => entry.language === 'zh');
  if (!english || english.default !== true || languages[0] !== english) {
    throw new Error('English must stay the default language and the first language entry');
  }
  if (!chinese) throw new Error('Missing zh language');
  const zhPages = collectPages(chinese.groups || []);
  const defaultEnglish = english.versions.find((entry) => entry.default) || english.versions[0];
  const snapshot = collectPages(defaultEnglish.groups)
    .map((page) => /^dist\/docs\/([^/]+)\//.exec(page)?.[1])
    .find(Boolean);
  if (!snapshot) throw new Error('default English navigation has no dist/docs snapshot');
  for (const page of [
    'intro',
    'quickstart',
    'glossary',
    'protocol/architecture',
    'building/concepts/index',
    'building/concepts/protocol-comparison',
    'building/concepts/adcp-vs-openrtb',
    'building/concepts/how-agents-communicate',
    'building/concepts/security-model',
    'building/concepts/industry-landscape',
    'building/concepts/managing-response-size',
    'building/index',
    'building/schemas-and-sdks',
    'building/by-layer/L4/index',
    'building/by-layer/L4/choose-your-sdk',
    'building/by-layer/L4/build-a-caller',
    'building/by-layer/L4/build-an-agent',
    'building/by-layer/L4/migrate-from-hand-rolled',
    'protocol/calling-an-agent',
    'building/operating/operating-an-agent',
    'accounts/overview',
  ]) {
    const published = `zh/dist/docs/${snapshot}/${page}`;
    if (!zhPages.includes(published)) throw new Error(`zh navigation missing ${published}`);
    const authored = path.join(rootDir, 'docs/zh', `${page}.mdx`);
    const mirror = path.join(rootDir, `${published}.mdx`);
    // readlink fails for non-links; verify the intended source without a
    // separate metadata check followed by reading through a mutable link.
    const linkTarget = fs.readlinkSync(mirror);
    if (path.resolve(path.dirname(mirror), linkTarget) !== authored) {
      throw new Error(`${published}.mdx must be a symlink to docs/zh/${page}.mdx`);
    }
    const target = fs.readFileSync(authored, 'utf8');
    if (!target.startsWith('---')) throw new Error(`${published}.mdx does not resolve to MDX frontmatter`);
  }
  const englishPages = new Set(collectPages(navigation.versions));
  const overlap = zhPages.filter((page) => englishPages.has(page));
  if (overlap.length > 0) {
    throw new Error(`page paths reused across languages: ${overlap.join(', ')}`);
  }
  const missing = zhPages.filter((page) => {
    const mdx = path.join(rootDir, `${page}.mdx`);
    const md = path.join(rootDir, `${page}.md`);
    return !fs.existsSync(mdx) && !fs.existsSync(md);
  });
  if (missing.length > 0) {
    throw new Error(`Missing zh files:\n      ${missing.join('\n      ')}`);
  }
});

log('Nav coverage');

const liveSource = findLiveSourceVersion(navigation.versions);
const sourcePages = listSourcePages(path.join(rootDir, 'docs'));

test('every published docs/ page is in the live-source navigation or allowlisted', () => {
  if (!liveSource) throw new Error('Could not identify the live-source docs version');
  const { entry, snapshot, pages } = liveSource;
  const navRoutes = new Set(pages.map(page => page
    .replace(/^dist\/docs\/[^/]+\//, '')
    .replace(/^docs\//, '')));
  const inSnapshot = page => !snapshot || ['.mdx', '.md'].some(ext =>
    fs.existsSync(path.join(rootDir, 'dist/docs', snapshot, `${page}${ext}`)));

  const missing = [];
  const pending = [];
  for (const page of sourcePages) {
    if (navRoutes.has(page) || allowlistReason(page)) continue;
    // A page added to docs/ after the snapshot was cut cannot be linked yet;
    // it becomes required when the next snapshot PR retargets this entry.
    if (inSnapshot(page)) missing.push(page);
    else pending.push(page);
  }

  if (pending.length > 0) {
    log(`    Awaiting the next ${entry.version} snapshot (add to nav in the snapshot PR): ` +
      pending.join(', '), 'warning');
  }
  if (missing.length > 0) {
    throw new Error(
      `Pages missing from the "${entry.version}" navigation are invisible to Mintlify ` +
      `search, sitemap.xml, and llms indexes. Add them to the "${entry.version}" entry in ` +
      `docs.json${snapshot ? ` (as dist/docs/${snapshot}/<page>)` : ''}, or add them to ` +
      `NAV_COVERAGE_ALLOWLIST in tests/docs-nav-validation.test.cjs with a reason:\n      ` +
      missing.join('\n      ')
    );
  }
});

test('nav coverage allowlist has no stale entries', () => {
  if (!liveSource) throw new Error('Could not identify the live-source docs version');
  const navRoutes = new Set(liveSource.pages.map(page => page
    .replace(/^dist\/docs\/[^/]+\//, '')
    .replace(/^docs\//, '')));
  const stale = [];
  for (const [entry, reason] of NAV_COVERAGE_ALLOWLIST) {
    if (!reason || !reason.trim()) stale.push(`${entry} (missing reason)`);
    const matches = entry.endsWith('/')
      ? sourcePages.filter(page => page.startsWith(entry))
      : sourcePages.filter(page => page === entry);
    if (matches.length === 0) stale.push(`${entry} (no matching docs/ page)`);
    const listed = matches.filter(page => navRoutes.has(page));
    if (listed.length > 0) {
      stale.push(`${entry} (in the ${liveSource.entry.version} navigation: ${listed.join(', ')})`);
    }
  }
  if (stale.length > 0) {
    throw new Error(`Remove or fix stale NAV_COVERAGE_ALLOWLIST entries:\n      ${stale.join('\n      ')}`);
  }
});

test('live-source version selection follows semver precedence', () => {
  const ordered = ['3.1.24', '3.2.0-beta.11', '3.2.0-rc.6', '3.2.0-rc.10', '3.2.0', '3.2.1'];
  for (let i = 1; i < ordered.length; i++) {
    if (compareSnapshotVersions(ordered[i], ordered[i - 1]) <= 0) {
      throw new Error(`${ordered[i]} must sort after ${ordered[i - 1]}`);
    }
  }
  const entry = (version, snapshot) => ({
    version,
    groups: [{ group: 'G', pages: [`dist/docs/${snapshot}/intro`] }],
  });
  const picked = findLiveSourceVersion([
    entry('3.1', '3.1.24'),
    entry('3.2-rc', '3.2.0-rc.6'),
    entry('3.2-beta', '3.2.0-beta.11'),
  ]);
  if (picked?.entry.version !== '3.2-rc') {
    throw new Error(`expected 3.2-rc as live source, got ${picked?.entry.version}`);
  }
  const afterGa = findLiveSourceVersion([entry('3.2', '3.2.0'), entry('3.1', '3.1.25')]);
  if (afterGa?.entry.version !== '3.2') {
    throw new Error(`expected 3.2 as live source after GA, got ${afterGa?.entry.version}`);
  }
});

log('');

test('page files belong to only one version', () => {
  if (crossVersionDuplicates.length > 0) {
    throw new Error(`Pages referenced across versions:\n      ${crossVersionDuplicates.join('\n      ')}`);
  }
});

test('navigable pages are canonical and never redirect', () => {
  const redirectSources = new Map(
    docsConfig.redirects.map(redirect => [redirect.source, redirect.destination])
  );
  const redirectedPages = [];

  for (const [page, version] of pageOwners) {
    const destination = redirectSources.get(`/${page}`);
    if (destination) {
      redirectedPages.push(`${page} (${version}) -> ${destination}`);
    }
  }

  if (redirectedPages.length > 0) {
    throw new Error(
      `Mintlify indexes navigation paths before redirects, so redirected pages ` +
      `disappear from version-filtered search:\n      ${redirectedPages.join('\n      ')}`
    );
  }
});

test('default snapshot pages retain clean-route aliases', () => {
  const defaultEntry = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const snapshotPages = collectPages(defaultEntry.groups)
    .filter(page => page.startsWith('dist/docs/'));
  if (snapshotPages.length === 0) return;

  const redirectsBySource = new Map(
    docsConfig.redirects.map(redirect => [redirect.source, redirect])
  );
  const brokenAliases = [];

  for (const page of snapshotPages) {
    const cleanPath = `/docs/${page.split('/').slice(3).join('/')}`;
    const redirect = redirectsBySource.get(cleanPath);
    if (redirect?.destination !== `/${page}` || redirect.permanent !== false) {
      brokenAliases.push(`${cleanPath} -> /${page}`);
    }
  }

  if (brokenAliases.length > 0) {
    throw new Error(
      `Default snapshot pages require temporary clean-route aliases:\n      ` +
      brokenAliases.join('\n      ')
    );
  }
});

test('docs entry points route Slack invitations through the joining guide', () => {
  const defaultVersionEntry = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const directInvitePages = [];

  for (const page of collectPages(defaultVersionEntry.groups).filter(page => page.startsWith('docs/'))) {
    if (page === 'docs/community/joining-slack') continue;
    const filePath = fs.existsSync(path.join(rootDir, `${page}.mdx`))
      ? path.join(rootDir, `${page}.mdx`)
      : path.join(rootDir, `${page}.md`);
    const content = fs.readFileSync(filePath, 'utf8');
    if (containsDirectSlackInvite(content)) directInvitePages.push(page);
  }

  if (directInvitePages.length > 0) {
    throw new Error(
      `Direct Slack invites bypass the joining guide: ${directInvitePages.join(', ')}`
    );
  }

  const currentEntryPoints = [
    'CHARTER.md',
    'CONTRIBUTORS.md',
    'docs.json',
    'server/public/dashboard.html',
    'server/public/dashboard-membership.html',
  ];
  const directInviteEntryPoints = currentEntryPoints.filter(relativePath => (
    containsDirectSlackInvite(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'))
  ));
  if (directInviteEntryPoints.length > 0) {
    throw new Error(
      `Slack entry points bypass the joining guide: ${directInviteEntryPoints.join(', ')}`
    );
  }

  // Clean stable routes redirect to the latest immutable 3.1 snapshot.
  // Its global custom-script support lets us repair stale invite anchors at
  // render time without mutating those release artifacts.
  const recoveryScript = fs.readFileSync(
    path.join(rootDir, 'docs/slack-invite-recovery.js'),
    'utf8'
  );
  const loadRecoveryHarness = routePath => {
    const directInvite = 'https://join.slack.com/t/agenticads/shared_invite/example';
    const makeElement = (href = directInvite, text = '') => ({
      nodeType: 1,
      href,
      textNodes: text ? [{ nodeValue: text }] : [],
      matches: selector => (
        selector === 'a[href^="https://join.slack.com/"]' && isDirectSlackInvite(href)
      ),
      querySelectorAll: () => [],
    });
    const initialAnchor = makeElement();
    const document = {
      readyState: 'complete',
      documentElement: {},
      textNodes: [],
      querySelectorAll: () => [initialAnchor],
      createTreeWalker: root => {
        let index = 0;
        return { nextNode: () => (root.textNodes || [])[index++] || null };
      },
    };
    let observerCallback;
    class MutationObserver {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    }
    const window = { location: { pathname: routePath } };
    vm.runInNewContext(recoveryScript, {
      window,
      document,
      MutationObserver,
      Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
      NodeFilter: { SHOW_TEXT: 4 },
    });
    return {
      directInvite,
      initialAnchor,
      makeElement,
      navigate(pathname) { window.location.pathname = pathname; },
      add(node) { observerCallback([{ addedNodes: [node] }]); },
    };
  };

  const guideUrl = 'https://docs.adcontextprotocol.org/docs/community/joining-slack';
  const harness = loadRecoveryHarness('/dist/docs/3.1.19/intro');
  if (harness.initialAnchor.href !== guideUrl) {
    throw new Error('Snapshot pages must rewrite their direct Slack invite to the recovery guide');
  }

  const lookalikeUrl = 'https://attacker.example/?next=https://join.slack.com/t/example';
  const lookalikeAnchor = harness.makeElement(lookalikeUrl);
  harness.add(lookalikeAnchor);
  if (lookalikeAnchor.href !== lookalikeUrl) {
    throw new Error('Slack invite recovery must not rewrite URLs on unrelated hosts');
  }

  harness.navigate('/dist/docs/3.1.19/community/joining-slack');
  const guideContent = harness.makeElement(harness.directInvite, 'For AAO members only');
  harness.add(guideContent);
  if (guideContent.href !== harness.directInvite) {
    throw new Error('SPA navigation to the joining guide must preserve its direct Slack invite');
  }
  if (guideContent.textNodes[0].nodeValue.includes('AAO members')) {
    throw new Error('The joining guide must repair legacy organization terminology');
  }

  harness.navigate('/dist/docs/3.1.19/intro');
  const introContent = harness.makeElement();
  harness.add(introContent);
  if (introContent.href !== guideUrl) {
    throw new Error('SPA navigation away from the joining guide must resume invite rewriting');
  }
});

// --- Summary ---
log('====================================');
log(`Tests completed: ${totalTests}`);
if (passedTests > 0) log(`✅ Passed: ${passedTests}`, 'success');
if (failedTests > 0) {
  log(`❌ Failed: ${failedTests}`, 'error');
  process.exit(1);
}
log('\n🎉 All docs navigation tests passed!\n', 'success');
