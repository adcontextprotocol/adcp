#!/usr/bin/env node
/**
 * Update docs.json navigation for a release documentation snapshot.
 *
 * Existing version entries keep their structure and only retarget existing
 * dist/docs/<old-version>/ paths. New version labels are cloned from the live
 * default navigation, pinned to dist/docs/<release-version>/, and flattened so
 * Mintlify can route the non-default version correctly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DIST_DOCS_PREFIX_RE = /^dist\/docs\/[^/]+\//;

function clone(value) {
  // docs.json navigation is JSON-pure, so JSON clone is sufficient here.
  return JSON.parse(JSON.stringify(value));
}

function mapStrings(value, mapper) {
  if (typeof value === 'string') {
    return mapper(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, mapper));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, mapper)])
    );
  }
  return value;
}

function retargetExistingPath(releaseVersion, value) {
  return value.replace(DIST_DOCS_PREFIX_RE, `dist/docs/${releaseVersion}/`);
}

function snapshotPath(releaseVersion, value) {
  if (value.startsWith('docs/')) {
    return `dist/docs/${releaseVersion}/${value.slice('docs/'.length)}`;
  }
  return retargetExistingPath(releaseVersion, value);
}

function looseGroupName(pages, fallback) {
  // Current live nav has intro + quickstart as the only loose leading pages.
  if (
    pages.length <= 2 &&
    pages.every((page) => /\/(intro|quickstart)$/.test(page))
  ) {
    return 'Getting Started';
  }

  if (pages.length === 1 && /\/faq$/.test(pages[0])) {
    return 'FAQ';
  }

  return fallback || 'Documentation';
}

export function flattenVersionGroups(groups) {
  // Mintlify only needs flattening when a non-default version clones the live
  // nav's single "Documentation" wrapper. Multiple top-level groups are
  // already in the shape non-default versions need.
  if (!Array.isArray(groups) || groups.length !== 1) {
    return groups;
  }

  const [wrapper] = groups;
  if (
    !wrapper ||
    typeof wrapper !== 'object' ||
    !Array.isArray(wrapper.pages) ||
    !wrapper.pages.some((page) => page && typeof page === 'object' && page.group)
  ) {
    return groups;
  }

  const flattened = [];
  let loosePages = [];

  const flushLoosePages = () => {
    if (loosePages.length === 0) return;
    flattened.push({
      group: looseGroupName(loosePages, wrapper.group),
      pages: loosePages,
    });
    loosePages = [];
  };

  for (const page of wrapper.pages) {
    if (typeof page === 'string') {
      loosePages.push(page);
    } else {
      flushLoosePages();
      flattened.push(page);
    }
  }
  flushLoosePages();

  return flattened;
}

export function updateDocsConfig(config, releaseVersion, majorMinor) {
  if (!releaseVersion || !majorMinor) {
    throw new Error('releaseVersion and majorMinor are required');
  }

  const versions = config?.navigation?.versions;
  if (!Array.isArray(versions)) {
    throw new Error('docs.json must contain navigation.versions');
  }

  const existingIndex = versions.findIndex((entry) => entry.version === majorMinor);
  if (existingIndex >= 0) {
    const entry = clone(versions[existingIndex]);
    entry.groups = mapStrings(entry.groups, (value) =>
      retargetExistingPath(releaseVersion, value)
    );
    if (!entry.default) {
      entry.groups = flattenVersionGroups(entry.groups);
    }
    versions[existingIndex] = entry;
    return {
      config,
      action: 'updated',
      sourceVersion: entry.version,
    };
  }

  const defaultIndex = versions.findIndex((entry) => entry.default);
  const sourceIndex = defaultIndex >= 0 ? defaultIndex : 0;
  const sourceEntry = versions[sourceIndex];
  if (!sourceEntry) {
    throw new Error('docs.json navigation.versions cannot be empty');
  }

  const newEntry = clone(sourceEntry);
  delete newEntry.default;
  newEntry.version = majorMinor;
  newEntry.groups = flattenVersionGroups(
    mapStrings(newEntry.groups, (value) => snapshotPath(releaseVersion, value))
  );

  versions.splice(sourceIndex + 1, 0, newEntry);
  return {
    config,
    action: 'added',
    sourceVersion: sourceEntry.version,
  };
}

function main() {
  const [releaseVersion, majorMinor, docsJsonPath = 'docs.json'] = process.argv.slice(2);
  if (!releaseVersion || !majorMinor) {
    console.error('Usage: update-release-docs-nav.mjs <release-version> <major-minor> [docs.json]');
    process.exit(2);
  }

  const config = JSON.parse(readFileSync(docsJsonPath, 'utf8'));
  const { action, sourceVersion } = updateDocsConfig(config, releaseVersion, majorMinor);
  writeFileSync(docsJsonPath, `${JSON.stringify(config, null, 2)}\n`);

  if (action === 'added') {
    console.log(`Added docs.json version ${majorMinor} from ${sourceVersion}`);
  } else {
    console.log(`Updated docs.json version ${majorMinor}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
