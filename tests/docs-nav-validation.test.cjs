#!/usr/bin/env node
/**
 * Docs navigation validation test suite
 * Validates that docs.json navigation structure is valid for Mintlify,
 * including versioned docs that live under dist/docs/.
 */

const fs = require('fs');
const path = require('path');

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
const defaultVersion = navigation.default;

for (const versionEntry of navigation.versions) {
  const { version, groups } = versionEntry;
  log(`Version: ${version}`);

  const allPages = collectPages(groups);
  const allGroups = collectGroups(groups);

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

// --- Summary ---
log('====================================');
log(`Tests completed: ${totalTests}`);
if (passedTests > 0) log(`✅ Passed: ${passedTests}`, 'success');
if (failedTests > 0) {
  log(`❌ Failed: ${failedTests}`, 'error');
  process.exit(1);
}
log('\n🎉 All docs navigation tests passed!\n', 'success');
