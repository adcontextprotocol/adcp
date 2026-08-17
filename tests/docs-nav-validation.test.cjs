#!/usr/bin/env node
/**
 * Docs navigation validation test suite
 * Validates that docs.json navigation structure is valid for Mintlify,
 * including versioned docs that live under dist/docs/.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function isLiveDocsVersionCompatible(liveVersion, packageVersion) {
  const liveMatch = /^(\d+)\.(\d+)$/.exec(liveVersion);
  const packageMatch = /^(\d+)\.(\d+)\.\d+(?:-([0-9A-Za-z.-]+))?$/.exec(packageVersion);
  if (!liveMatch || !packageMatch) return false;

  const liveLine = [Number(liveMatch[1]), Number(liveMatch[2])];
  const packageLine = [Number(packageMatch[1]), Number(packageMatch[2])];
  if (!packageMatch[3]) {
    return liveLine[0] === packageLine[0] && liveLine[1] === packageLine[1];
  }

  // A prerelease package does not make that release line the live docs line.
  // Keep the latest stable docs active until the release is promoted, while
  // still rejecting a docs label from a future line.
  return liveLine[0] < packageLine[0]
    || (liveLine[0] === packageLine[0] && liveLine[1] <= packageLine[1]);
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
      `Default version "${defaultVersion}" must be first; Mintlify can omit its ` +
      `file-backed routes when an archived version precedes it.`
    );
  }
});

test('live docs version matching keeps prerelease packages unreleased', () => {
  if (!isLiveDocsVersionCompatible('3.1', '3.1.14')) {
    throw new Error('A stable package must accept its matching live docs line');
  }
  if (isLiveDocsVersionCompatible('3.0', '3.1.14')) {
    throw new Error('A stable package must reject an older live docs line');
  }
  if (!isLiveDocsVersionCompatible('3.1', '3.2.0-beta.0')) {
    throw new Error('A prerelease package must preserve the prior stable live docs line');
  }
  if (isLiveDocsVersionCompatible('3.3', '3.2.0-beta.0')) {
    throw new Error('A prerelease package must reject a future live docs line');
  }
});

test('one release-labeled version owns the live docs tree', () => {
  const liveVersions = navigation.versions.filter(versionEntry =>
    collectPages(versionEntry.groups).some(page => page.startsWith('docs/'))
  );
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
  ).version;

  if (liveVersions.length !== 1) {
    throw new Error(`Expected one live docs owner, found ${liveVersions.length}`);
  }

  const [liveVersion] = liveVersions;
  if (liveVersion !== navigation.versions[0] || !liveVersion.default) {
    throw new Error('The live docs owner must be the first and default version');
  }
  if (!isLiveDocsVersionCompatible(liveVersion.version, packageVersion)) {
    throw new Error(
      `Live docs version "${liveVersion.version}" is incompatible with package release "${packageVersion}"`
    );
  }
  if (liveVersion.tag !== 'Latest') {
    throw new Error('The live docs owner must carry the "Latest" tag');
  }
});

for (const versionEntry of navigation.versions) {
  const { version, groups } = versionEntry;
  log(`Version: ${version}`);

  const allPages = collectPages(groups);
  const allGroups = collectGroups(groups);

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
  const distPages = allPages.filter(p => p.startsWith('dist/docs/'));
  if (distPages.length > 0) {
    test('dist/docs pages share a consistent version prefix', () => {
      const prefixes = new Set(distPages.map(p => {
        const parts = p.split('/');
        return `${parts[0]}/${parts[1]}/${parts[2]}`;
      }));
      if (prefixes.size > 1) {
        throw new Error(`Mixed version prefixes: ${[...prefixes].join(', ')}`);
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

test('live docs route Slack invitations through the joining guide', () => {
  const liveVersion = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const directInvitePages = [];

  for (const page of collectPages(liveVersion.groups).filter(page => page.startsWith('docs/'))) {
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

  // Mintlify temporarily redirects live routes to immutable 3.1.2 snapshots.
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
  const harness = loadRecoveryHarness('/dist/docs/3.1.2/intro');
  if (harness.initialAnchor.href !== guideUrl) {
    throw new Error('Snapshot pages must rewrite their direct Slack invite to the recovery guide');
  }

  const lookalikeUrl = 'https://attacker.example/?next=https://join.slack.com/t/example';
  const lookalikeAnchor = harness.makeElement(lookalikeUrl);
  harness.add(lookalikeAnchor);
  if (lookalikeAnchor.href !== lookalikeUrl) {
    throw new Error('Slack invite recovery must not rewrite URLs on unrelated hosts');
  }

  harness.navigate('/dist/docs/3.1.2/community/joining-slack');
  const guideContent = harness.makeElement(harness.directInvite, 'For AAO members only');
  harness.add(guideContent);
  if (guideContent.href !== harness.directInvite) {
    throw new Error('SPA navigation to the joining guide must preserve its direct Slack invite');
  }
  if (guideContent.textNodes[0].nodeValue.includes('AAO members')) {
    throw new Error('The joining guide must repair legacy organization terminology');
  }

  harness.navigate('/dist/docs/3.1.2/intro');
  const introContent = harness.makeElement();
  harness.add(introContent);
  if (introContent.href !== guideUrl) {
    throw new Error('SPA navigation away from the joining guide must resume invite rewriting');
  }
});

// Emergency fallback while Mintlify omits file-backed docs/** routes.
// Remove this invariant with the temporary redirects once live files publish again.
test('temporary snapshot redirects cover every available live page', () => {
  const liveVersion = navigation.versions.find(version => version.default)
    || navigation.versions[0];
  const livePages = collectPages(liveVersion.groups)
    .filter(page => page.startsWith('docs/'));
  const expectedRedirects = new Map();
  const uncoveredPages = [];

  for (const page of livePages) {
    const relativePath = page.slice('docs/'.length);
    const destination = `/dist/docs/3.1.2/${relativePath}`;
    const filePath = path.join(rootDir, destination.slice(1));
    if (fs.existsSync(`${filePath}.mdx`) || fs.existsSync(`${filePath}.md`)) {
      expectedRedirects.set(`/${page}`, destination);
    } else {
      uncoveredPages.push(page);
    }
  }

  // This file is linked by Addie but intentionally omitted from navigation.
  expectedRedirects.set(
    '/docs/aao/aao-admins',
    '/dist/docs/3.1.2/aao/aao-admins'
  );

  const expectedUncoveredPages = [
    'docs/reference/migration/asset-access',
    'docs/reference/migration/cross-role-governance-enforcement',
    'docs/protocol/language-and-localization',
    'docs/protocol/sync_agent_notification_configs',
    'docs/accounts/provisioning-walkthrough',
    'docs/media-buy/product-discovery/proposal-negotiation',
    'docs/media-buy/media-buys/indicators',
    'docs/media-buy/task-reference/list_products',
    'docs/media-buy/task-reference/request_proposals',
    'docs/media-buy/task-reference/refine_proposals',
    'docs/media-buy/task-reference/decline_proposals',
    'docs/media-buy/task-reference/buy_products',
    'docs/media-buy/task-reference/accept_proposal',
    'docs/media-buy/task-reference/control_media_buy',
    'docs/creative/channels/radio',
    'docs/governance/campaign/tasks/report_plan_adjustment',
    'docs/brand-protocol/tasks/search_brands',
  ];
  if (JSON.stringify(uncoveredPages) !== JSON.stringify(expectedUncoveredPages)) {
    throw new Error(
      `Unexpected live pages without a 3.1.2 snapshot: ${uncoveredPages.join(', ')}`
    );
  }

  const snapshotRedirects = docsConfig.redirects.filter(redirect =>
    redirect.destination.startsWith('/dist/docs/3.1.2/')
  );
  if (snapshotRedirects.length !== expectedRedirects.size) {
    throw new Error(
      `Expected ${expectedRedirects.size} snapshot redirects, found ${snapshotRedirects.length}`
    );
  }

  for (const [source, destination] of expectedRedirects) {
    const matches = docsConfig.redirects.filter(redirect => redirect.source === source);
    if (matches.length !== 1 || matches[0].destination !== destination) {
      throw new Error(`${source} must redirect exactly once to ${destination}`);
    }
    if (matches[0].permanent !== false) {
      throw new Error(`${source} snapshot fallback must be temporary`);
    }
  }

  const generatedApiRedirect = snapshotRedirects.find(redirect =>
    redirect.source.startsWith('/docs/registry/api-reference/')
  );
  if (generatedApiRedirect) {
    throw new Error(`Generated API route must not be redirected: ${generatedApiRedirect.source}`);
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
