#!/usr/bin/env node
/**
 * Update docs.json navigation for a release documentation snapshot.
 *
 * Existing version entries keep their structure and only retarget existing
 * dist/docs/<old-version>/ paths. New version labels are cloned from the live
 * default navigation, pinned to dist/docs/<release-version>/, and flattened so
 * Mintlify can route the non-default version correctly.
 *
 * The first preview of a new minor line (for example `3.3-beta` while 3.2 is
 * the default) is cloned from another line's navigation, so the line's release
 * story pages (whats-new-in-X-Y, X-Y-beta, migration/X-(Y-1)-to-X-Y) are added
 * beside their predecessors. The line's public aliases (/X.Y, /X.Y/try|migrate|sdk
 * and the clean /docs/reference routes) are retargeted to each new snapshot when
 * they already exist in docs.json; other lines' aliases are never touched.
 *
 * A stable release on a minor line newer than the current default (for
 * example `3.2.1 3.2` while 3.1 is the default) promotes that line: the new
 * stable entry becomes the only default and the only `Latest` entry, the old
 * default is demoted, and the line's beta/RC selectors leave the version
 * picker. Their immutable dist/docs snapshots and redirects stay in place.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { docsNavigationVersions, setDocsNavigationVersions } = require('./docs-navigation.cjs');

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
const CLI_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+\.\d+)?$/;
const CLI_DOCS_LABEL_RE = /^\d+\.\d+(?:-[0-9A-Za-z]+)?$/;
// Pages that only one line's story links to. They are rewritten with that
// line's story aliases but are not derivable from the line number.
const RELEASE_STORY_EXTRA_ALIASES = new Map([
  ['3.2', ['/docs/media-buy/product-discovery/proposal-negotiation']],
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
  const versions = docsNavigationVersions(config);
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

function lineSlug(line) {
  return line.replace('.', '-');
}

function previousLine(line) {
  const [major, minor] = line.split('.').map(Number);
  return minor > 0 ? `${major}.${minor - 1}` : undefined;
}

/**
 * The public aliases and clean routes a minor line's release story owns:
 * /X.Y, /X.Y/try|migrate|sdk, whats-new-in-X-Y, X-Y-beta, and the migration
 * guide from the previous minor. Short aliases are always owned by the line.
 * Clean /docs/ routes are also the default line's snapshot aliases, so they
 * are returned separately and rewritten only for a line at or above the
 * default (see updateReleaseStoryAliases).
 */
function releaseStoryAliases(line) {
  const slug = lineSlug(line);
  const previous = previousLine(line);
  return {
    short: [`/${line}`, `/${line}/try`, `/${line}/migrate`, `/${line}/sdk`],
    clean: [
      `/docs/reference/whats-new-in-${slug}`,
      `/docs/reference/${slug}-beta`,
      ...(previous ? [`/docs/reference/migration/${lineSlug(previous)}-to-${slug}`] : []),
      ...(RELEASE_STORY_EXTRA_ALIASES.get(line) ?? []),
    ],
  };
}

function releaseStoryPages(line) {
  const slug = lineSlug(line);
  const previous = previousLine(line);
  const beforePrevious = previous ? previousLine(previous) : undefined;
  const overview = `reference/whats-new-in-${slug}`;
  const migration = previous ? `reference/migration/${lineSlug(previous)}-to-${slug}` : undefined;
  return [
    {
      page: overview,
      after: previous
        ? [`reference/${lineSlug(previous)}-beta`, `reference/whats-new-in-${lineSlug(previous)}`]
        : [],
      siblings: /\/reference\/whats-new-in-/,
    },
    { page: `reference/${slug}-beta`, after: [overview], siblings: /\/reference\/whats-new-in-/ },
    ...(migration
      ? [{
          page: migration,
          siblings: /\/reference\/migration\//,
          after: [
            ...(beforePrevious
              ? [`reference/migration/${lineSlug(beforePrevious)}-to-${lineSlug(previous)}`]
              : []),
            'reference/migration/index',
          ],
        }]
      : []),
  ];
}

function insertAfterPage(node, anchorSuffix, page) {
  if (Array.isArray(node)) {
    const index = node.findIndex(
      (item) => typeof item === 'string' && item.endsWith(`/${anchorSuffix}`)
    );
    if (index >= 0) {
      node.splice(index + 1, 0, page);
      return true;
    }
    return node.some((item) => insertAfterPage(item, anchorSuffix, page));
  }
  if (node && typeof node === 'object') {
    return insertAfterPage(node.pages, anchorSuffix, page);
  }
  return false;
}

/**
 * A new line's first preview is cloned from the default line's navigation,
 * which has no entries for pages that line never shipped. Add the line's
 * story pages next to their predecessors so they are reachable and indexed,
 * and report any that the snapshot does not contain.
 */
function appendToGroupWith(node, siblingPattern, page) {
  if (Array.isArray(node)) {
    if (node.some((item) => typeof item === 'string' && siblingPattern.test(item))) {
      node.push(page);
      return true;
    }
    return node.some((item) => appendToGroupWith(item, siblingPattern, page));
  }
  if (node && typeof node === 'object') {
    return appendToGroupWith(node.pages, siblingPattern, page);
  }
  return false;
}

function addReleaseStoryPages(groups, releaseVersion, line, snapshotHasPage) {
  const present = new Set(collectStrings(groups));
  const added = [];
  const notInSnapshot = [];
  const noInsertionPoint = [];
  for (const { page, after, siblings } of releaseStoryPages(line)) {
    const snapshotPage = `dist/docs/${releaseVersion}/${page}`;
    if (present.has(snapshotPage)) continue;
    if (!snapshotHasPage(snapshotPage)) {
      notInSnapshot.push(page);
      continue;
    }
    if (
      after.some((anchor) => insertAfterPage(groups, anchor, snapshotPage)) ||
      appendToGroupWith(groups, siblings, snapshotPage)
    ) {
      present.add(snapshotPage);
      added.push(page);
    } else {
      noInsertionPoint.push(page);
    }
  }
  return { added, notInSnapshot, noInsertionPoint };
}

function storyPageWarnings({ notInSnapshot, noInsertionPoint }, line, label) {
  const warnings = [];
  if (notInSnapshot.length > 0) {
    warnings.push(
      `${line} release story pages are not in the ${label} snapshot: ${notInSnapshot.join(', ')}. ` +
      'Publish them in docs/ before cutting the release.'
    );
  }
  if (noInsertionPoint.length > 0) {
    warnings.push(
      `${line} release story pages are in the ${label} snapshot but have no place in its navigation: ` +
      `${noInsertionPoint.join(', ')}. Add them to docs.json by hand.`
    );
  }
  return warnings;
}

// The banner must resolve to the line's story: a /X.Y alias, the overview or
// beta page, or the line's GitHub release (what the docs-nav test accepts).
function bannerLinksLineStory(content, line) {
  const slug = lineSlug(line);
  const text = String(content ?? '');
  const isDigitOrDot = (char) => char !== undefined && /[0-9.]/.test(char);
  // Plain string search: `line` comes from a command-line argument.
  const hasAlias = (needle, boundary) => {
    for (let from = text.indexOf(needle); from >= 0; from = text.indexOf(needle, from + 1)) {
      if (!boundary(text[from + needle.length])) return true;
    }
    return false;
  };
  return (
    hasAlias(`(/${line}`, isDigitOrDot) ||
    hasAlias(`/reference/whats-new-in-${slug}`, (char) => /\w/.test(char ?? '')) ||
    hasAlias(`/reference/${slug}-beta`, (char) => /\w/.test(char ?? '')) ||
    text.includes(`/releases/tag/v${line}.`)
  );
}

function snapshotPageExists(page) {
  return ['.mdx', '.md'].some((extension) => existsSync(`${page}${extension}`));
}

function defaultVersionLine(config) {
  const versions = docsNavigationVersions(config);
  const entry = Array.isArray(versions) ? versions.find((item) => item.default) ?? versions[0] : undefined;
  return versionLine(entry?.version);
}

function updateReleaseStoryAliases(config, releaseVersion, snapshotHasPage, { addCleanRoutes = false } = {}) {
  const line = versionLine(releaseVersion);
  if (!Array.isArray(config.redirects) || !line) {
    return;
  }

  const { short, clean } = releaseStoryAliases(line);
  const shortAliases = new Set(short);
  const aliases = new Set(short);
  // An older line's clean routes belong to the default line's snapshot, so a
  // late patch of that line must not retarget them.
  const defaultLine = defaultVersionLine(config);
  const ownsCleanRoutes = !defaultLine || compareVersionLines(line, defaultLine) >= 0;
  if (ownsCleanRoutes) {
    for (const alias of clean) aliases.add(alias);
  }

  for (const redirect of config.redirects) {
    if (
      aliases.has(redirect?.source) &&
      typeof redirect.destination === 'string'
    ) {
      const sourcePage = /^\/docs\/(.+)$/.exec(redirect.destination)?.[1];
      if (sourcePage && shortAliases.has(redirect.source)) {
        // A short alias staged on the live source page moves to the snapshot
        // as soon as the snapshot has that page.
        if (snapshotHasPage(`dist/docs/${releaseVersion}/${sourcePage}`)) {
          redirect.destination = `/dist/docs/${releaseVersion}/${sourcePage}`;
        }
        continue;
      }
      redirect.destination = redirect.destination.replace(
        DIST_DOCS_ABSOLUTE_PREFIX_RE,
        `/dist/docs/${releaseVersion}/`
      );
    }
  }

  if (!ownsCleanRoutes || !addCleanRoutes) return;
  // The story pages serve from source until a snapshot has them, so their
  // clean routes carry no redirect before then (a redirect would shadow the
  // page). The first preview of a line adds each one the snapshot has; later
  // snapshots retarget them above.
  const redirectsBySource = new Map(
    config.redirects.map((redirect) => [redirect?.source, redirect])
  );
  for (const { page } of releaseStoryPages(line)) {
    const snapshotPage = `dist/docs/${releaseVersion}/${page}`;
    if (!snapshotHasPage(snapshotPage)) continue;
    const source = `/docs/${page}`;
    const existing = redirectsBySource.get(source);
    if (existing) {
      existing.destination = `/${snapshotPage}`;
    } else {
      const added = { source, destination: `/${snapshotPage}`, permanent: false };
      config.redirects.push(added);
      redirectsBySource.set(source, added);
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

function promoteStableLine(config, releaseVersion, majorMinor, snapshotHasPage) {
  const versions = docsNavigationVersions(config);
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
  const warnings = [];
  if (sourceEntry === previousDefault) {
    // A GA with no preview of its own is cloned from the old default, which
    // lacks this line's story pages.
    const story = addReleaseStoryPages(
      promotedGroups,
      releaseVersion,
      majorMinor,
      snapshotHasPage
    );
    warnings.push(...storyPageWarnings(story, majorMinor, majorMinor));
  }
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
  setDocsNavigationVersions(config, [promoted, ...remaining]);

  // Point clean /docs/* routes at the new default. Aliases for pages that only
  // exist in the old default keep pointing at its immutable snapshot.
  updateDefaultSnapshotAliases(config, [], promoted.groups);
  updateReleaseStoryAliases(config, releaseVersion, snapshotHasPage);
  removeObsoleteCurrentLlmsRedirects(config);

  return {
    config,
    action: 'promoted',
    warnings,
    sourceVersion: sourceEntry.version,
    previousDefault: previousDefault.version,
    retired: sameLinePrereleases.map((entry) => entry.version),
  };
}

export function updateDocsConfig(config, releaseVersion, majorMinor, options = {}) {
  const { snapshotHasPage = snapshotPageExists } = options;
  if (!releaseVersion || !majorMinor) {
    throw new Error('releaseVersion and majorMinor are required');
  }

  const versions = docsNavigationVersions(config);
  if (!Array.isArray(versions)) {
    throw new Error('docs.json must contain navigation.versions');
  }

  if (shouldPromoteStableLine(versions, releaseVersion, majorMinor)) {
    return promoteStableLine(config, releaseVersion, majorMinor, snapshotHasPage);
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
    updateReleaseStoryAliases(config, releaseVersion, snapshotHasPage);
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

  const result = {
    config,
    action: 'added',
    sourceVersion: sourceEntry.version,
  };
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
  const warnings = [];
  const firstPreviewOfLine =
    sameLineIndex < 0 && PRERELEASE_DOCS_LABEL_RE.test(majorMinor);
  if (firstPreviewOfLine) {
    // Cloned from another line's navigation, which lacks this line's story.
    const story = addReleaseStoryPages(
      newEntry.groups,
      releaseVersion,
      targetLine,
      snapshotHasPage
    );
    warnings.push(...storyPageWarnings(story, targetLine, majorMinor));
    result.storyPagesAdded = story.added;
  }
  const insertionIndex = sameLineIndex >= 0 ? sameLineIndex : sourceIndex + 1;
  versions.splice(insertionIndex, 0, newEntry);
  updatePrereleaseBanner(config, releaseVersion, majorMinor);
  if (firstPreviewOfLine && !bannerLinksLineStory(config.banner?.content, targetLine)) {
    warnings.push(
      `banner does not link to the ${targetLine} release story. Point it at /${targetLine} ` +
      'in the beta.0 Version Packages PR; the docs-nav test rejects a banner that ' +
      'is not the current preview story.'
    );
  }
  updateReleaseStoryAliases(config, releaseVersion, snapshotHasPage, {
    addCleanRoutes: firstPreviewOfLine,
  });
  removeObsoleteCurrentLlmsRedirects(config);
  result.warnings = warnings;
  return result;
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
  const versions = docsNavigationVersions(config);
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

  // The release tag or dispatch input reaches file paths and string
  // replacement here, so accept only release-shaped values.
  if (!CLI_RELEASE_VERSION_RE.test(releaseVersion) || !CLI_DOCS_LABEL_RE.test(majorMinor)) {
    console.error(
      `Invalid release version "${releaseVersion}" or docs label "${majorMinor}"; ` +
      'expected X.Y.Z[-tag.N] and X.Y[-tag]'
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

  for (const warning of result.warnings ?? []) {
    console.warn(`::warning::${warning}`);
  }

  if (result.action === 'promoted') {
    console.log(
      `Promoted docs.json version ${majorMinor} (from ${result.sourceVersion}) to the default; ` +
      `demoted ${result.previousDefault}` +
      (result.retired.length > 0 ? `; retired selectors ${result.retired.join(', ')}` : '')
    );
  } else if (result.action === 'added') {
    console.log(`Added docs.json version ${majorMinor} from ${result.sourceVersion}`);
    if (result.storyPagesAdded?.length > 0) {
      console.log(`Added release story pages to ${majorMinor}: ${result.storyPagesAdded.join(', ')}`);
    }
  } else {
    console.log(`Updated docs.json version ${majorMinor}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
