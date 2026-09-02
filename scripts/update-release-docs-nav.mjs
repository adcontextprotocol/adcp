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
const DIST_DOCS_ABSOLUTE_PREFIX_RE = /^\/dist\/docs\/[^/]+\//;
const PRERELEASE_DOCS_LABEL_RE = /^(\d+)\.(\d+)-([0-9A-Za-z]+)$/;
const PRERELEASE_BANNER_VERSION_RE = /AdCP (\d+)\.(\d+) ([0-9A-Za-z]+)\.\d+/g;
const VERSION_LINE_RE = /^(\d+\.\d+)/;
const RELEASE_STORY_ALIASES = new Set([
  '/3.2',
  '/3.2/try',
  '/3.2/migrate',
  '/3.2/sdk',
  '/docs/reference/whats-new-in-3-2',
  '/docs/reference/3-2-beta',
  '/docs/reference/migration/3-1-to-3-2',
  '/docs/media-buy/product-discovery/proposal-negotiation',
]);
// Production builds fetch versioned navigation specs reliably from public URLs;
// release tags keep each docs version tied to the spec shipped with that release.
const RELEASE_OPENAPI_URL = (releaseVersion) =>
  `https://raw.githubusercontent.com/adcontextprotocol/adcp/v${releaseVersion}/static/openapi/registry.yaml`;

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

function collectStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function snapshotAlias(page) {
  const match = /^dist\/docs\/[^/]+\/(.+)$/.exec(page);
  if (!match) return undefined;
  return {
    source: `/docs/${match[1]}`,
    destination: `/${page}`,
  };
}

function updateDefaultSnapshotAliases(config, previousGroups, updatedGroups) {
  const previousSources = new Set(
    collectStrings(previousGroups).map(snapshotAlias).filter(Boolean).map(({ source }) => source)
  );
  const desiredAliases = new Map(
    collectStrings(updatedGroups)
      .map(snapshotAlias)
      .filter(Boolean)
      .map((alias) => [alias.source, alias])
  );

  if (!Array.isArray(config.redirects)) config.redirects = [];
  config.redirects = config.redirects.filter(
    (redirect) => !previousSources.has(redirect?.source) || desiredAliases.has(redirect.source)
  );

  const redirectsBySource = new Map(
    config.redirects.map((redirect) => [redirect?.source, redirect])
  );
  for (const alias of desiredAliases.values()) {
    const existing = redirectsBySource.get(alias.source);
    if (existing) {
      existing.destination = alias.destination;
      existing.permanent = false;
    } else {
      config.redirects.push({ ...alias, permanent: false });
    }
  }
}

function pinOpenApiSources(value, releaseVersion) {
  if (Array.isArray(value)) {
    return value.map((item) => pinOpenApiSources(item, releaseVersion));
  }
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        pinOpenApiSources(item, releaseVersion),
      ])
    );
    if (result.openapi?.source) {
      result.openapi.source = RELEASE_OPENAPI_URL(releaseVersion);
    }
    return result;
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

function versionLine(value) {
  return typeof value === 'string' ? VERSION_LINE_RE.exec(value)?.[1] : undefined;
}

function updateReleaseStoryAliases(config, releaseVersion) {
  if (!Array.isArray(config.redirects) || versionLine(releaseVersion) !== '3.2') {
    return;
  }

  for (const redirect of config.redirects) {
    if (
      RELEASE_STORY_ALIASES.has(redirect?.source) &&
      typeof redirect.destination === 'string'
    ) {
      redirect.destination = redirect.destination.replace(
        DIST_DOCS_ABSOLUTE_PREFIX_RE,
        `/dist/docs/${releaseVersion}/`
      );
    }
  }
}

function updatePrereleaseBanner(config, releaseVersion, majorMinor) {
  const match = PRERELEASE_DOCS_LABEL_RE.exec(majorMinor);
  const content = config?.banner?.content;
  if (!match || typeof content !== 'string') return false;

  const [, major, minor, prerelease] = match;
  const slug = `${major}-${minor}-${prerelease}`;
  const sourcePath = `/docs/reference/${slug}`;
  const snapshotPathPattern = new RegExp(
    `/dist/docs/[^/]+/reference/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );

  if (!content.includes(sourcePath) && !snapshotPathPattern.test(content)) {
    return false;
  }

  const destination = `/dist/docs/${releaseVersion}/reference/${slug}`;
  config.banner.content = content
    .replace(sourcePath, destination)
    .replace(snapshotPathPattern, destination)
    .replace(
      PRERELEASE_BANNER_VERSION_RE,
      (version, bannerMajor, bannerMinor, bannerPrerelease) =>
        bannerMajor === major &&
        bannerMinor === minor &&
        bannerPrerelease === prerelease
          ? `AdCP ${major}.${minor} ${prerelease}`
          : version
    );
  return true;
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
    const previousGroups = clone(entry.groups);
    entry.groups = mapStrings(entry.groups, (value) =>
      retargetExistingPath(releaseVersion, value)
    );
    entry.groups = pinOpenApiSources(entry.groups, releaseVersion);
    if (!entry.default) {
      entry.groups = flattenVersionGroups(entry.groups);
    }
    versions[existingIndex] = entry;
    if (entry.default) {
      updateDefaultSnapshotAliases(config, previousGroups, entry.groups);
    }
    updatePrereleaseBanner(config, releaseVersion, majorMinor);
    updateReleaseStoryAliases(config, releaseVersion);
    return {
      config,
      action: 'updated',
      sourceVersion: entry.version,
    };
  }

  const targetLine = versionLine(majorMinor);
  const sameLineIndex = versions.findIndex(
    (entry) => entry.version !== majorMinor && versionLine(entry.version) === targetLine
  );
  const defaultIndex = versions.findIndex((entry) => entry.default);
  const sourceIndex = sameLineIndex >= 0 ? sameLineIndex : defaultIndex >= 0 ? defaultIndex : 0;
  const sourceEntry = versions[sourceIndex];
  if (!sourceEntry) {
    throw new Error('docs.json navigation.versions cannot be empty');
  }

  const newEntry = clone(sourceEntry);
  delete newEntry.default;
  newEntry.version = majorMinor;
  newEntry.groups = flattenVersionGroups(
    pinOpenApiSources(
      mapStrings(newEntry.groups, (value) => snapshotPath(releaseVersion, value)),
      releaseVersion
    )
  );

  if (sameLineIndex >= 0) {
    delete versions[sameLineIndex].tag;
  }
  const insertionIndex = sameLineIndex >= 0 ? sameLineIndex : sourceIndex + 1;
  versions.splice(insertionIndex, 0, newEntry);
  updatePrereleaseBanner(config, releaseVersion, majorMinor);
  updateReleaseStoryAliases(config, releaseVersion);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
