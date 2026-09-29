#!/usr/bin/env node
/**
 * Update docs.json navigation for a release documentation snapshot.
 *
 * Existing version entries keep their structure and only retarget existing
 * dist/docs/<old-version>/ paths. New version labels are cloned from the live
 * default navigation, pinned to dist/docs/<release-version>/, and flattened so
 * Mintlify can route the non-default version correctly.
 *
 * A stable release on a minor line newer than the current default (for
 * example `3.2.1 3.2` while 3.1 is the default) promotes that line: the new
 * stable entry becomes the only default and the only `Latest` entry, the old
 * default is demoted, and the line's beta/RC selectors leave the version
 * picker. Their immutable dist/docs snapshots and redirects stay in place.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DIST_DOCS_PREFIX_RE = /^dist\/docs\/[^/]+\//;
const DIST_DOCS_ABSOLUTE_PREFIX_RE = /^\/dist\/docs\/[^/]+\//;
const PRERELEASE_DOCS_LABEL_RE = /^(\d+)\.(\d+)-([0-9A-Za-z]+)$/;
const STABLE_DOCS_LABEL_RE = /^(\d+)\.(\d+)$/;
const STABLE_RELEASE_VERSION_RE = /^(\d+)\.(\d+)\.\d+$/;
const ARCHIVED_LABEL_SUFFIX_RE = /\s*\(archived\)\s*$/i;
const LATEST_TAG = 'Latest';
const PRERELEASE_BANNER_VERSION_RE = /AdCP (\d+)\.(\d+) ([0-9A-Za-z]+)\.\d+/g;
const OFFICIAL_PRERELEASE_RELEASE_URL_RE = /https:\/\/github\.com\/adcontextprotocol\/adcp\/releases\/tag\/v\d+\.\d+\.\d+-(?:beta|rc)\.\d+/g;
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
// Mintlify Cloud handles Markdown requests before docs.json redirects, both
// inside /_llms and at the root. These obsolete redirects must stay removed;
// llms-current.md is a real source page instead.
const OBSOLETE_CURRENT_LLMS_REDIRECTS = new Set([
  '/llms-current.md',
  '/_llms/current.md',
]);
// Production builds fetch versioned navigation specs reliably from public URLs;
// release tags keep each docs version tied to the spec shipped with that release.
const RELEASE_OPENAPI_URL = (releaseVersion) =>
  `https://raw.githubusercontent.com/adcontextprotocol/adcp/v${releaseVersion}/static/openapi/registry.yaml`;
const DOCKERIGNORE_SCHEMA_MARKER = '!dist/schemas';

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

function compareVersionLines(left, right) {
  const [leftMajor, leftMinor] = left.split('.').map(Number);
  const [rightMajor, rightMinor] = right.split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor;
}

function snapshotBuilds(groups) {
  return new Set(
    collectStrings(groups)
      .map((value) => /^dist\/docs\/([^/]+)\//.exec(value)?.[1])
      .filter(Boolean)
  );
}

function isLiveDocsPath(value) {
  return value.startsWith('docs/');
}

function removeObsoleteCurrentLlmsRedirects(config) {
  if (!Array.isArray(config.redirects)) return;
  config.redirects = config.redirects.filter(
    (redirect) => !OBSOLETE_CURRENT_LLMS_REDIRECTS.has(redirect?.source)
  );
}

export function renderCurrentLlmsIndex(config) {
  const versions = config?.navigation?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('docs.json must contain at least one navigation version');
  }

  const current = versions.find((entry) => entry.default) ?? versions[0];
  if (typeof current?.version !== 'string') {
    throw new Error('the current docs navigation entry must have a version');
  }

  const builds = snapshotBuilds(current.groups);
  if (builds.size !== 1) {
    throw new Error(
      `the current docs navigation must reference exactly one release build; found ${[...builds].join(', ') || 'none'}`
    );
  }

  const version = current.version;
  const build = [...builds][0];
  const slug = version.replaceAll('.', '-');
  const base = 'https://docs.adcontextprotocol.org';
  return [
    `# AdCP Current Documentation: ${version}`,
    '',
    `> Current stable AdCP documentation. Version: ${version}. Build: ${build}.`,
    '',
    '## Indexes',
    '',
    `- [AdCP ${version} full index](${base}/_llms/${slug}.md): Complete current documentation index for build ${build}.`,
    `- [AdCP ${version} protocol index](${base}/_llms/${slug}/protocol.md): Complete current protocol documentation for build ${build}.`,
    '',
  ].join('\n');
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
  const officialReleaseUrl = `https://github.com/adcontextprotocol/adcp/releases/tag/v${releaseVersion}`;
  const hasOfficialReleaseUrl = OFFICIAL_PRERELEASE_RELEASE_URL_RE.test(content);
  OFFICIAL_PRERELEASE_RELEASE_URL_RE.lastIndex = 0;

  if (!content.includes(sourcePath) && !snapshotPathPattern.test(content) && !hasOfficialReleaseUrl) {
    return false;
  }

  const destination = `/dist/docs/${releaseVersion}/reference/${slug}`;
  config.banner.content = content
    .replace(sourcePath, destination)
    .replace(snapshotPathPattern, destination)
    .replace(OFFICIAL_PRERELEASE_RELEASE_URL_RE, officialReleaseUrl)
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

/**
 * Decide whether a release promotes a new stable minor line to the default.
 * Only a stable `X.Y` label for a line newer than the current default does.
 */
function shouldPromoteStableLine(versions, releaseVersion, majorMinor) {
  if (!STABLE_DOCS_LABEL_RE.test(majorMinor)) return false;
  const defaultEntry = versions.find((entry) => entry.default) ?? versions[0];
  const defaultLine = versionLine(defaultEntry?.version);
  if (!defaultLine || compareVersionLines(majorMinor, defaultLine) <= 0) {
    return false;
  }
  if (!STABLE_RELEASE_VERSION_RE.test(releaseVersion) || versionLine(releaseVersion) !== majorMinor) {
    throw new Error(
      `stable docs line ${majorMinor} can only be promoted by a stable ${majorMinor}.N release; got ${releaseVersion}`
    );
  }
  return true;
}

function promoteStableLine(config, releaseVersion, majorMinor) {
  const versions = config.navigation.versions;
  const previousDefaultIndex = versions.findIndex((entry) => entry.default);
  const previousDefault = versions[previousDefaultIndex >= 0 ? previousDefaultIndex : 0];
  const sameLinePrereleases = versions.filter((entry) => {
    const match = PRERELEASE_DOCS_LABEL_RE.exec(entry.version ?? '');
    return match && `${match[1]}.${match[2]}` === majorMinor;
  });
  const existingStable = versions.find((entry) => entry.version === majorMinor);
  // Prefer an existing stable entry, then the newest same-line preview (the
  // first one in the picker, i.e. RC before beta), then the old default.
  const sourceEntry = existingStable ?? sameLinePrereleases[0] ?? previousDefault;
  if (!sourceEntry) {
    throw new Error('docs.json navigation.versions cannot be empty');
  }

  if (collectStrings(previousDefault.groups).some(isLiveDocsPath)) {
    throw new Error(
      `docs.json default ${previousDefault.version} still references live docs/ pages; ` +
      `pin it to its dist/docs snapshot before promoting ${majorMinor}`
    );
  }

  const {
    version: _version,
    default: _default,
    tag: _tag,
    groups: sourceGroups,
    ...rest
  } = clone(sourceEntry);
  const promotedGroups = pinOpenApiSources(
    mapStrings(sourceGroups, (value) => snapshotPath(releaseVersion, value)),
    releaseVersion
  );
  const promoted = {
    version: majorMinor,
    tag: LATEST_TAG,
    ...rest,
    groups: promotedGroups,
    default: true,
  };

  const retired = new Set([...sameLinePrereleases, existingStable].filter(Boolean));
  const remaining = versions
    .filter((entry) => !retired.has(entry))
    .map((entry) => {
      const demoted = { ...entry };
      delete demoted.default;
      if (demoted.tag === LATEST_TAG) delete demoted.tag;
      if (entry === previousDefault) {
        demoted.groups = flattenVersionGroups(demoted.groups);
      }
      return demoted;
    });

  // Mintlify requires the default version first.
  config.navigation.versions = [promoted, ...remaining];

  // Point clean /docs/* routes at the new default. Aliases for pages that only
  // exist in the old default keep pointing at its immutable snapshot.
  updateDefaultSnapshotAliases(config, [], promoted.groups);
  updateReleaseStoryAliases(config, releaseVersion);
  removeObsoleteCurrentLlmsRedirects(config);

  return {
    config,
    action: 'promoted',
    sourceVersion: sourceEntry.version,
    previousDefault: previousDefault.version,
    retired: sameLinePrereleases.map((entry) => entry.version),
  };
}

export function updateDocsConfig(config, releaseVersion, majorMinor) {
  if (!releaseVersion || !majorMinor) {
    throw new Error('releaseVersion and majorMinor are required');
  }

  const versions = config?.navigation?.versions;
  if (!Array.isArray(versions)) {
    throw new Error('docs.json must contain navigation.versions');
  }

  if (shouldPromoteStableLine(versions, releaseVersion, majorMinor)) {
    return promoteStableLine(config, releaseVersion, majorMinor);
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
    removeObsoleteCurrentLlmsRedirects(config);
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
  removeObsoleteCurrentLlmsRedirects(config);
  return {
    config,
    action: 'added',
    sourceVersion: sourceEntry.version,
  };
}

export function updateDockerignore(content, releaseVersion) {
  const directoryRule = `!dist/docs/${releaseVersion}`;
  const contentsRule = `${directoryRule}/**`;
  if (content.split('\n').includes(directoryRule)) return content;

  const markerIndex = content.indexOf(DOCKERIGNORE_SCHEMA_MARKER);
  if (markerIndex < 0) {
    throw new Error(`.dockerignore must contain ${DOCKERIGNORE_SCHEMA_MARKER}`);
  }

  return `${content.slice(0, markerIndex)}${directoryRule}\n${contentsRule}\n${content.slice(markerIndex)}`;
}

/**
 * Map each docs.json navigation version to the single release build it pins,
 * in picker order. Addie's schema routing mirrors this exactly: the first
 * entry is the docs default, and retired selectors disappear from both.
 */
export function docsSchemaReleases(config) {
  const versions = config?.navigation?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('docs.json must contain at least one navigation version');
  }
  const ordered = [...versions].sort(
    (left, right) => Number(Boolean(right.default)) - Number(Boolean(left.default))
  );
  return ordered.map((entry) => {
    const label = String(entry.version ?? '').replace(ARCHIVED_LABEL_SUFFIX_RE, '');
    const builds = snapshotBuilds(entry.groups);
    if (!label || builds.size !== 1) {
      throw new Error(
        `docs version ${label || '<unnamed>'} must reference exactly one dist/docs build; found ${[...builds].join(', ') || 'none'}`
      );
    }
    return [label, [...builds][0]];
  });
}

const SCHEMA_RELEASES_BLOCK_RE =
  /(export const DOCS_SCHEMA_RELEASES(?:\s*:[^=]+)?\s*=\s*Object\.freeze\(\{\n)([\s\S]*?)(\n\}\);)/;

export function updateSchemaTools(content, config) {
  const match = SCHEMA_RELEASES_BLOCK_RE.exec(content);
  if (!match) {
    throw new Error('schema-tools.ts must declare DOCS_SCHEMA_RELEASES = Object.freeze({ ... })');
  }
  const indent = /^(\s*)'/m.exec(match[2])?.[1] ?? '  ';
  const body = docsSchemaReleases(config)
    .map(([label, build]) => `${indent}'${label}': '${build}',`)
    .join('\n');
  return content.replace(SCHEMA_RELEASES_BLOCK_RE, (_, open, _body, close) => `${open}${body}${close}`);
}

function main() {
  const [
    releaseVersion,
    majorMinor,
    docsJsonPath = 'docs.json',
    dockerignorePath = '.dockerignore',
    schemaToolsPath = 'server/src/addie/mcp/schema-tools.ts',
    currentLlmsIndexPath = 'llms-current.md',
  ] = process.argv.slice(2);
  if (!releaseVersion || !majorMinor) {
    console.error(
      'Usage: update-release-docs-nav.mjs <release-version> <major-minor> [docs.json] [.dockerignore] [schema-tools.ts] [llms-current.md]'
    );
    process.exit(2);
  }

  // Compute every output before writing so a failure leaves no partial update.
  const config = JSON.parse(readFileSync(docsJsonPath, 'utf8'));
  const result = updateDocsConfig(config, releaseVersion, majorMinor);
  const currentLlmsIndex = renderCurrentLlmsIndex(config);
  const dockerignore = updateDockerignore(readFileSync(dockerignorePath, 'utf8'), releaseVersion);
  const schemaTools = updateSchemaTools(readFileSync(schemaToolsPath, 'utf8'), config);

  writeFileSync(docsJsonPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(currentLlmsIndexPath, currentLlmsIndex);
  writeFileSync(dockerignorePath, dockerignore);
  writeFileSync(schemaToolsPath, schemaTools);

  if (result.action === 'promoted') {
    console.log(
      `Promoted docs.json version ${majorMinor} (from ${result.sourceVersion}) to the default; ` +
      `demoted ${result.previousDefault}` +
      (result.retired.length > 0 ? `; retired selectors ${result.retired.join(', ')}` : '')
    );
  } else if (result.action === 'added') {
    console.log(`Added docs.json version ${majorMinor} from ${result.sourceVersion}`);
  } else {
    console.log(`Updated docs.json version ${majorMinor}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
