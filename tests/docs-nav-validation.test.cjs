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

// --- Run tests ---

log('\n🧪 Docs Navigation Validation Tests');
log('====================================\n');

const docsConfig = JSON.parse(fs.readFileSync(DOCS_JSON, 'utf8'));
const { navigation } = docsConfig;

if (!navigation || !navigation.versions) {
  log('No navigation.versions found in docs.json', 'error');
  process.exit(1);
}

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

test('default navigation matches the stable release branch surface', () => {
  let releaseConfig;
  try {
    releaseConfig = JSON.parse(execFileSync(
      'git',
      ['show', 'origin/3.1.x:docs.json'],
      { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ));
  } catch {
    if (process.env.REQUIRE_STABLE_DOCS_REF === '1') {
      throw new Error('origin/3.1.x is required but unavailable');
    }
    return;
  }

  const currentDefault = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const releaseDefault = releaseConfig.navigation.versions.find(version => version.default)
    || releaseConfig.navigation.versions[0];
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
      `Stable navigation drifted from origin/3.1.x.`
      + `\n      Unexpected: ${unexpected.join(', ') || 'none'}`
      + `\n      Missing: ${missing.join(', ') || 'none'}`
    );
  }
});

test('prerelease banner links to the current versioned beta landing page', () => {
  const betaVersion = navigation.versions.find(versionEntry =>
    /-beta$/.test(versionEntry.version)
  );
  if (!betaVersion) return;

  const [majorMinor] = betaVersion.version.split('-');
  const [major, minor] = majorMinor.split('.');
  const landingSuffix = `/reference/${major}-${minor}-beta`;
  const landingPage = collectPages(betaVersion.groups).find(page =>
    page.endsWith(landingSuffix)
  );
  if (!landingPage) {
    throw new Error(`Version "${betaVersion.version}" has no beta landing page`);
  }

  const bannerContent = docsConfig.banner?.content || '';
  const bannerLink = bannerContent.match(/\[[^\]]+\]\(([^)]+)\)/)?.[1];
  if (bannerLink !== `/${landingPage}`) {
    throw new Error(
      `Beta banner must link to /${landingPage}; found ${bannerLink || 'no link'}`
    );
  }
  if (new RegExp(`AdCP ${major}\\.${minor} beta\\.\\d+`).test(bannerContent)) {
    throw new Error('Beta banner must not freeze a moving beta ordinal in its copy');
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
