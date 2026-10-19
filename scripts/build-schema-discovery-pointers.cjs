#!/usr/bin/env node
// Root schema discovery pointers (/schemas/index.json, /schemas/latest.json)
// for publication to the artifact CDN.
//
// Why this exists: `scripts/build-schemas.cjs` regenerates both documents from
// the release directories in `dist/schemas/`, but the publication pipeline had
// no step that uploaded them. `release.yml` uploads one version with
// `--version V --skip-latest`; routine deploys upload mutable development
// artifacts with `--latest-only`. Both excluded the root pointers, so the
// published copies froze at whatever a manual bulk backfill last wrote while
// new releases kept landing (adcontextprotocol/adcp#8318).
//
// The pointers now ride along with the routine deploy, under the publication
// authority rule in RELEASING.md: routine deployment must never advertise a
// version that release authority has not already published. This builder
// enforces that mechanically, in two tiers:
//
//   * `versions[]` lists the releases whose `schemas/<version>/` prefix exists
//     on the CDN, from one delimited listing.
//   * an alias (`latest_stable`, `v3`, `v3.2`, …) may only resolve to a
//     release whose `schemas/<version>/index.json` object the caller has
//     confirmed with a HEAD. A prefix appears as soon as release publication
//     writes its first object, and that publication is progressive and
//     per-object, so prefix existence alone would let a half-uploaded release
//     win an alias under an immutable cache policy.
//
// It also refuses a source document that disagrees with its own version list,
// and refuses to move any pointer backwards relative to the copy currently
// served — except onto a release the source marks withdrawn or unpublished,
// which is the one legitimate backwards move.
//
// Every URL in the output is derived from a validated version string. Nothing
// is copied out of the source document except two prose fields.
//
// Deriving from the bucket's `schemas/` prefixes is what the CDN worker's
// dynamic `/schemas/` discovery already does
// (workers/artifact-cdn/src/index.js getVersions/findMatchingVersion), so the
// static document and the dynamic one resolve each alias the same way.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_ORIGIN = 'https://adcontextprotocol.org';
const EXPECTED_ID = `${SCHEMA_ORIGIN}/schemas/index.json`;
const EXPECTED_JSON_SCHEMA = 'http://json-schema.org/draft-07/schema#';
const EXPECTED_CHANNEL = 'stable';
const STABLE_STABILITY = 'stable';
const KNOWN_STABILITIES = new Set(['stable', 'rc', 'beta', 'prerelease', 'withdrawn', 'unpublished']);
// A release the source has retired. scripts/build-schemas.cjs marks these
// through RELEASE_STATUS_OVERRIDES; they may legitimately lose an alias.
const RETIRED_STABILITIES = new Set(['withdrawn', 'unpublished']);
// Entry fields carried through, in the order scripts/build-schemas.cjs emits
// them. Anything else in a source entry is dropped.
const ENTRY_FLAGS = ['prerelease', 'deprecated', 'withdrawn', 'published'];
const POINTER_MAPS = ['aliases', 'latest_by_major', 'latest_by_minor'];

// Node builtins only, like scripts/check-release-state.cjs: this runs inside
// the publication path, so it must not depend on an installed tree. Only the
// `major.minor.patch[-prerelease]` shape the release lines actually use is
// recognised, and only stable versions are ever ordered — aliases and the
// monotonic guard never compare prerelease precedence.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  return {
    major: match[1],
    minor: `${match[1]}.${match[2]}`,
    order: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null,
  };
}

function isValidVersion(version) {
  return parseVersion(version) !== null;
}

function isStableVersion(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease === null;
}

// Descending order over stable versions only.
function compareStableDescending(a, b) {
  const left = parseVersion(a).order;
  const right = parseVersion(b).order;
  return (right[0] - left[0]) || (right[1] - left[1]) || (right[2] - left[2]);
}

function sortedStable(versions) {
  return [...new Set(versions)].filter(isStableVersion).sort(compareStableDescending);
}

// Mirrors buildRootSchemaDiscovery() in scripts/build-schemas.cjs: newest
// first, first one wins each alias.
function derivePointers(stableVersions) {
  const stable = sortedStable(stableVersions);
  const aliases = {};
  const latestByMajor = {};
  const latestByMinor = {};
  for (const version of stable) {
    const { major, minor } = parseVersion(version);
    if (!latestByMajor[major]) {
      latestByMajor[major] = version;
      aliases[`v${major}`] = version;
    }
    if (!latestByMinor[minor]) {
      latestByMinor[minor] = version;
      aliases[`v${minor}`] = version;
    }
  }
  return { latestStable: stable[0] || null, aliases, latestByMajor, latestByMinor };
}

function stableVersionsOf(entries) {
  return entries
    .filter((entry) => entry.stability === STABLE_STABILITY)
    .map((entry) => entry.version)
    .filter(isStableVersion);
}

// Key order carries no meaning in these maps, so compare canonically rather
// than failing publication over a reordered alias table.
function canonical(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value ?? null);
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function assertEqualPointer(label, actual, expected) {
  const left = canonical(actual);
  const right = canonical(expected);
  if (left !== right) {
    throw new Error(
      `Stale schema discovery source: ${label} is ${left} but the document's own version list derives ${right}. `
      + 'Run `npm run build:schemas` so dist/schemas/index.json matches dist/schemas/*.',
    );
  }
}

// A source document that disagrees with its own `versions` array was written
// before the release directories it now sits beside. Publishing it would
// re-freeze the pointers, which is the bug this script exists to close.
function assertSourceIsCurrent(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Schema discovery source is not an object.');
  }
  if (!Array.isArray(source.versions) || source.versions.length === 0) {
    throw new Error('Schema discovery source has no versions array.');
  }
  if (source.$id !== EXPECTED_ID) {
    throw new Error(`Schema discovery source $id is ${JSON.stringify(source.$id)}, expected ${EXPECTED_ID}.`);
  }
  if (source.$schema !== EXPECTED_JSON_SCHEMA) {
    throw new Error(`Schema discovery source $schema is ${JSON.stringify(source.$schema)}, expected ${EXPECTED_JSON_SCHEMA}.`);
  }
  if (source.channel !== EXPECTED_CHANNEL) {
    throw new Error(`Schema discovery source channel is ${JSON.stringify(source.channel)}, expected ${EXPECTED_CHANNEL}.`);
  }
  for (const entry of source.versions) {
    if (!entry || typeof entry !== 'object' || !isValidVersion(entry.version)) {
      throw new Error(`Schema discovery source has an entry without a valid version: ${JSON.stringify(entry)}.`);
    }
    if (!KNOWN_STABILITIES.has(entry.stability)) {
      throw new Error(`Schema discovery source entry ${entry.version} has unknown stability ${JSON.stringify(entry.stability)}.`);
    }
    if (Object.hasOwn(entry, 'superseded_by') && !isValidVersion(entry.superseded_by)) {
      throw new Error(`Schema discovery source entry ${entry.version} has an invalid superseded_by.`);
    }
    for (const flag of ENTRY_FLAGS) {
      if (Object.hasOwn(entry, flag) && typeof entry[flag] !== 'boolean') {
        throw new Error(`Schema discovery source entry ${entry.version} has a non-boolean ${flag}.`);
      }
    }
  }
  const derived = derivePointers(stableVersionsOf(source.versions));
  assertEqualPointer('latest_stable', source.latest_stable, derived.latestStable);
  assertEqualPointer('latest', source.latest, derived.latestStable);
  assertEqualPointer('aliases', source.aliases, derived.aliases);
  assertEqualPointer('latest_by_major', source.latest_by_major, derived.latestByMajor);
  assertEqualPointer('latest_by_minor', source.latest_by_minor, derived.latestByMinor);
}

// The CDN listing and the local release set are read at different moments and
// can disagree transiently. A pointer must never regress, so compare against
// the copy currently served and refuse to publish a lower target.
//
// `retired` exempts a release the source has withdrawn or unpublished: that is
// a deliberate editorial decision, and without the exemption the first such
// override on a live alias would wedge every deploy.
function assertNoRegression(published, candidate, { allowBootstrap = false, retired = new Set() } = {}) {
  if (!published) {
    if (allowBootstrap) return;
    // The served copy is the only defense against a bad listing. On the
    // routine-deploy path that object always exists, so its absence means
    // something is wrong — do not respond by dropping the safety check.
    throw new Error(
      'No published schemas/index.json to compare against; refusing to publish without the regression guard. '
      + 'Pass --allow-bootstrap only for a reviewed first publication.',
    );
  }
  if (typeof published.latest_stable !== 'string') {
    throw new Error('Published schemas/index.json has no latest_stable; refusing to publish without the regression guard.');
  }

  const compare = (label, before, after) => {
    if (!before || retired.has(before)) return;
    if (!after) {
      throw new Error(
        `Refusing to drop published schema discovery pointer ${label} (was ${JSON.stringify(before)}). `
        + 'The CDN no longer serves a release it advertises; recover that release per RELEASING.md rather than overriding this.',
      );
    }
    if (!isStableVersion(before) || !isStableVersion(after)) {
      throw new Error(`Refusing to compare non-stable schema discovery pointer ${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}.`);
    }
    if (compareStableDescending(after, before) > 0) {
      throw new Error(
        `Refusing to regress published schema discovery pointer ${label}: ${before} -> ${after}. `
        + 'The CDN no longer serves a release it advertises; recover that release per RELEASING.md rather than overriding this.',
      );
    }
  };

  compare('latest_stable', published.latest_stable, candidate.latest_stable);
  for (const map of POINTER_MAPS) {
    const before = published[map];
    if (!before || typeof before !== 'object') continue;
    for (const key of Object.keys(before)) {
      compare(`${map}.${key}`, before[key], candidate[map][key]);
    }
  }
}

// Rebuild each entry from an allowlist so no URL, id, or free-form field from
// the source document reaches the public discovery index verbatim.
function publishedEntry(entry) {
  const published = { version: entry.version, stability: entry.stability };
  for (const flag of ENTRY_FLAGS) {
    if (Object.hasOwn(entry, flag)) published[flag] = entry[flag];
  }
  if (Object.hasOwn(entry, 'superseded_by')) published.superseded_by = entry.superseded_by;
  published.path = `/schemas/${entry.version}/`;
  published.index = `/schemas/${entry.version}/index.json`;
  return published;
}

function retiredVersions(source) {
  return new Set(source.versions
    .filter((entry) => RETIRED_STABILITIES.has(entry.stability) || entry.published === false)
    .map((entry) => entry.version));
}

/**
 * Stable releases an alias could resolve to, newest first within each line, as
 * `<minor> <version>` pairs. The caller walks these in order and confirms each
 * candidate's manifest object before letting it win its line.
 */
function aliasCandidates(source, presentVersions) {
  assertSourceIsCurrent(source);
  const present = new Set(presentVersions);
  return sortedStable(stableVersionsOf(source.versions).filter((version) => present.has(version)))
    .map((version) => ({ minor: parseVersion(version).minor, version }));
}

/**
 * @param {object} source  Freshly built dist/schemas/index.json.
 * @param {Iterable<string>} presentVersions  Versions with a CDN prefix.
 * @param {Iterable<string>} confirmedVersions  Versions whose schemas/<v>/index.json was confirmed.
 * @param {object|null} publishedIndex  The schemas/index.json currently served.
 * @param {boolean} allowBootstrap  Permit a first publication with no served copy.
 */
function buildPublishablePointers({
  source, presentVersions, confirmedVersions, publishedIndex = null, allowBootstrap = false,
}) {
  assertSourceIsCurrent(source);

  const present = new Set(presentVersions);
  const confirmed = new Set(confirmedVersions);
  for (const version of confirmed) {
    if (!present.has(version)) {
      throw new Error(`Confirmed schema version ${version} is absent from the CDN listing; refusing inconsistent inputs.`);
    }
  }

  const entries = source.versions.filter((entry) => present.has(entry.version));
  const absent = source.versions
    .filter((entry) => !present.has(entry.version))
    .map((entry) => entry.version);
  const derived = derivePointers([...confirmed]);
  if (!derived.latestStable) {
    throw new Error('No stable schema version has a confirmed index.json on the CDN; refusing to publish empty pointers.');
  }

  // The caller walks each line newest-first and stops at the first
  // confirmation, so a present stable release newer than its line's winner is
  // one it tested and rejected. Anything older was never tested — reporting
  // it would bury the real gap in noise.
  const unconfirmed = stableVersionsOf(entries).filter((version) => {
    if (confirmed.has(version)) return false;
    const winner = derived.latestByMinor[parseVersion(version).minor];
    return winner === undefined || compareStableDescending(version, winner) < 0;
  });

  const index = {
    $schema: EXPECTED_JSON_SCHEMA,
    $id: EXPECTED_ID,
    title: String(source.title ?? ''),
    description: String(source.description ?? ''),
    latest: derived.latestStable,
    latest_stable: derived.latestStable,
    channel: EXPECTED_CHANNEL,
    aliases: derived.aliases,
    latest_by_major: derived.latestByMajor,
    latest_by_minor: derived.latestByMinor,
    versions: entries.map(publishedEntry),
  };

  assertNoRegression(publishedIndex, index, { allowBootstrap, retired: retiredVersions(source) });


  // Losing an older entry from `versions[]` is consumer-visible but not an
  // alias misdirection, and failing on it would wedge every deploy over a
  // listing wobble. Report it instead; the alias guard above stays fatal.
  const retired = retiredVersions(source);
  const dropped = Array.isArray(publishedIndex?.versions)
    ? publishedIndex.versions
      .map((entry) => entry?.version)
      .filter((version) => isValidVersion(version) && !present.has(version) && !retired.has(version))
    : [];

  const latest = {
    latest: index.latest_stable,
    latest_stable: index.latest_stable,
    channel: EXPECTED_CHANNEL,
    path: `/schemas/${index.latest_stable}/`,
    index: `/schemas/${index.latest_stable}/index.json`,
  };

  return { index, latest, absent, unconfirmed, dropped };
}

// `aws s3api list-objects-v2 --prefix schemas/ --delimiter /` output.
function versionsFromListing(listing) {
  // The AWS CLI auto-paginates and merges pages, so a truncated response here
  // means something returned a partial view. Publishing from a partial version
  // set is exactly how a pointer would silently regress.
  if (listing?.IsTruncated === true || listing?.NextContinuationToken) {
    throw new Error('Truncated schemas/ listing; refusing to publish pointers from a partial version set.');
  }
  const prefixes = Array.isArray(listing?.CommonPrefixes) ? listing.CommonPrefixes : [];
  return prefixes
    .map((entry) => String(entry?.Prefix || ''))
    .filter((prefix) => prefix.startsWith('schemas/') && prefix.endsWith('/'))
    .map((prefix) => prefix.slice('schemas/'.length, -1))
    .filter(isValidVersion);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const USAGE = [
  'Usage:',
  '  build-schema-discovery-pointers.cjs candidates --source FILE --listing FILE',
  '  build-schema-discovery-pointers.cjs build --source FILE --listing FILE --confirmed FILE',
  '      [--published-index FILE] [--allow-bootstrap] --out-index FILE --out-latest FILE',
  '',
  '`candidates` prints "<minor> <version>" lines, newest first. Confirm each',
  'candidate\'s schemas/<version>/index.json object and pass the winners to',
  '`build` through --confirmed.',
].join('\n');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode === '-h' || mode === '--help') return { mode: 'help' };
  if (mode !== 'candidates' && mode !== 'build') throw new Error(USAGE);
  const options = { mode };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}\n${USAGE}`);
    const name = flag.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (name === 'allowBootstrap') {
      options.allowBootstrap = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value\n${USAGE}`);
    options[name] = value;
    i += 1;
  }
  const required = mode === 'candidates'
    ? ['source', 'listing']
    : ['source', 'listing', 'confirmed', 'outIndex', 'outLatest'];
  for (const key of required) {
    if (!options[key]) throw new Error(USAGE);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'help') {
    console.log(USAGE);
    return;
  }
  const source = readJson(options.source);
  const presentVersions = versionsFromListing(readJson(options.listing));

  if (options.mode === 'candidates') {
    for (const { minor, version } of aliasCandidates(source, presentVersions)) {
      console.log(`${minor} ${version}`);
    }
    return;
  }

  const publishedIndex = options.publishedIndex && fs.existsSync(options.publishedIndex)
    ? readJson(options.publishedIndex)
    : null;

  const {
    index, latest, absent, unconfirmed, dropped,
  } = buildPublishablePointers({
    source,
    presentVersions,
    confirmedVersions: readLines(options.confirmed),
    publishedIndex,
    allowBootstrap: Boolean(options.allowBootstrap),
  });

  writeJson(options.outIndex, index);
  writeJson(options.outLatest, latest);

  // Not fatal: routine deployment cannot publish a version directory, only
  // release authority can. Surface the gap so it stays actionable.
  const gaps = [...new Set([...absent.filter(isStableVersion), ...unconfirmed])].sort(compareStableDescending);
  if (gaps.length > 0) {
    console.log(
      `::warning title=Schema versions missing from the CDN::${gaps.join(', ')} `
      + 'are released in this checkout but have no complete schemas/<version>/index.json on the CDN, so the '
      + 'discovery pointers skip them. Recover those releases per RELEASING.md.',
    );
  }
  if (dropped.length > 0) {
    console.log(
      `::warning title=Schema versions dropped from discovery::${dropped.join(', ')} `
      + 'were listed by the published schemas/index.json but have no CDN prefix now. '
      + 'Aliases are unaffected; investigate before the enumeration matters.',
    );
  }
  console.log(`Schema discovery pointers: latest_stable=${index.latest_stable} aliases=${JSON.stringify(index.aliases)}`);
}

module.exports = {
  aliasCandidates,
  buildPublishablePointers,
  derivePointers,
  parseVersion,
  publishedEntry,
  retiredVersions,
  versionsFromListing,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
