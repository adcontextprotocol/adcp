// Root schema discovery pointers (/schemas/index.json, /schemas/latest.json).
//
// adcontextprotocol/adcp#8318: the published documents froze at 3.2.1 while
// 3.2.5, 3.1.29, and 3.0.28 shipped, because no publication step uploaded
// them. These tests pin both halves of the fix: the pointers are rebuilt from
// what the CDN actually serves, and a post-publication check fails when the
// live documents are not the ones this run published.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  aliasCandidates,
  buildPublishablePointers,
  derivePointers,
  publishedEntry,
  retiredVersions,
  versionsFromListing,
} = require('../scripts/build-schema-discovery-pointers.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

const SCHEMA_ID = 'https://adcontextprotocol.org/schemas/index.json';
const JSON_SCHEMA = 'http://json-schema.org/draft-07/schema#';

const entry = (version, stability, extra = {}) => ({
  version,
  stability,
  prerelease: version.includes('-'),
  deprecated: false,
  ...extra,
  path: `/schemas/${version}/`,
  index: `/schemas/${version}/index.json`,
});

const DEFAULT_STABLE = ['3.2.5', '3.1.29', '3.0.28', '2.5.3'];

function source({ stable = DEFAULT_STABLE, extra = [], overrides = {} } = {}) {
  const versions = [...extra, ...stable.map((version) => entry(version, 'stable'))]
    .sort((a, b) => (a.version < b.version ? 1 : -1));
  const derived = derivePointers(versions.filter((v) => v.stability === 'stable').map((v) => v.version));
  return {
    $schema: JSON_SCHEMA,
    $id: SCHEMA_ID,
    title: 'AdCP Schema Discovery',
    description: 'Root discovery document.',
    channel: 'stable',
    latest: derived.latestStable,
    latest_stable: derived.latestStable,
    aliases: derived.aliases,
    latest_by_major: derived.latestByMajor,
    latest_by_minor: derived.latestByMinor,
    versions,
    ...overrides,
  };
}

// Everything present and fully published, the healthy steady state.
const build = (options) => buildPublishablePointers({
  source: source(),
  presentVersions: DEFAULT_STABLE,
  confirmedVersions: DEFAULT_STABLE,
  allowBootstrap: true,
  ...options,
});

test('aliases follow the newest confirmed release on each line', () => {
  const { index, latest } = build();

  assert.equal(index.latest_stable, '3.2.5');
  assert.equal(index.latest, '3.2.5');
  assert.deepEqual(index.aliases, {
    v3: '3.2.5', 'v3.2': '3.2.5', 'v3.1': '3.1.29', 'v3.0': '3.0.28', v2: '2.5.3', 'v2.5': '2.5.3',
  });
  assert.deepEqual(index.latest_by_major, { 2: '2.5.3', 3: '3.2.5' });
  assert.deepEqual(index.latest_by_minor, { '3.2': '3.2.5', '3.1': '3.1.29', '3.0': '3.0.28', '2.5': '2.5.3' });
  assert.deepEqual(latest, {
    latest: '3.2.5',
    latest_stable: '3.2.5',
    channel: 'stable',
    path: '/schemas/3.2.5/',
    index: '/schemas/3.2.5/index.json',
  });
});

test('a release absent from the CDN never wins an alias', () => {
  // The live condition on 2026-10-19: 3.0.27 and 3.0.28 are released and
  // committed, but no schemas/3.0.28/ prefix exists, so /schemas/3.0.28/
  // silently falls back to 3.0.26 bytes. Advertising it would hand file-based
  // consumers a path whose payload disagrees with the version they asked for.
  const { index, absent } = build({
    source: source({ stable: ['3.2.5', '3.0.28', '3.0.27', '3.0.26'] }),
    presentVersions: ['3.2.5', '3.0.26'],
    confirmedVersions: ['3.2.5', '3.0.26'],
  });

  assert.equal(index.aliases['v3.0'], '3.0.26');
  assert.equal(index.latest_by_minor['3.0'], '3.0.26');
  assert.ok(!index.versions.some((candidate) => candidate.version === '3.0.28'));
  assert.deepEqual(absent.sort(), ['3.0.27', '3.0.28']);
});

test('a prefix without a confirmed index.json is listed but never aliased', () => {
  // Release publication is progressive and per-object, so schemas/3.2.6/
  // exists the moment its first object lands. Letting a prefix win an alias
  // would advertise a half-uploaded release under an immutable cache policy.
  const { index, unconfirmed } = build({
    source: source({ stable: ['3.2.6', '3.2.5', '3.1.29'] }),
    presentVersions: ['3.2.6', '3.2.5', '3.1.29'],
    confirmedVersions: ['3.2.5', '3.1.29'],
  });

  assert.equal(index.latest_stable, '3.2.5');
  assert.equal(index.aliases.v3, '3.2.5');
  assert.equal(index.aliases['v3.2'], '3.2.5');
  assert.ok(index.versions.some((candidate) => candidate.version === '3.2.6'));
  // Only the candidate the caller actually tested and rejected is a gap.
  // 3.1.29 won its own line and nothing older than a winner was ever tested.
  assert.deepEqual(unconfirmed, ['3.2.6']);
});

test('a release older than its line winner is never reported as a gap', () => {
  // The caller stops walking a line at the first confirmation, so older
  // patches are untested, not missing. Reporting them buries the real gap.
  const { unconfirmed } = build({
    source: source({ stable: ['3.2.5', '3.2.4', '3.2.3', '3.1.29'] }),
    presentVersions: ['3.2.5', '3.2.4', '3.2.3', '3.1.29'],
    confirmedVersions: ['3.2.5', '3.1.29'],
  });
  assert.deepEqual(unconfirmed, []);
});

test('a version the source retired is not reported as dropped', () => {
  const retired = source({
    stable: ['3.2.5'],
    extra: [entry('3.2.0-rc.5', 'unpublished', { published: false })],
  });
  const { dropped } = build({
    source: retired,
    presentVersions: ['3.2.5'],
    confirmedVersions: ['3.2.5'],
    publishedIndex: {
      latest_stable: '3.2.5',
      aliases: { v3: '3.2.5' },
      versions: [{ version: '3.2.5' }, { version: '3.2.0-rc.5' }],
    },
  });
  assert.deepEqual(dropped, []);
});

test('alias candidates are offered newest-first per line so the caller can stop early', () => {
  const candidates = aliasCandidates(
    source({ stable: ['3.2.6', '3.2.5', '3.1.29', '3.1.28', '3.0.26'] }),
    ['3.2.6', '3.2.5', '3.1.29', '3.1.28'],
  );

  assert.deepEqual(candidates, [
    { minor: '3.2', version: '3.2.6' },
    { minor: '3.2', version: '3.2.5' },
    { minor: '3.1', version: '3.1.29' },
    { minor: '3.1', version: '3.1.28' },
  ]);
});

test('withdrawn and prerelease entries are listed but never aliased', () => {
  const { index } = build({
    source: source({
      stable: ['3.2.1', '3.1.2'],
      extra: [
        entry('3.2.0', 'unpublished', { published: false }),
        entry('3.2.0-rc.7', 'rc', { deprecated: true, superseded_by: '3.2.1' }),
        entry('3.1.3', 'withdrawn', { deprecated: true, withdrawn: true }),
      ],
    }),
    presentVersions: ['3.2.1', '3.2.0', '3.2.0-rc.7', '3.1.3', '3.1.2'],
    confirmedVersions: ['3.2.1', '3.1.2'],
  });

  assert.equal(index.latest_stable, '3.2.1');
  assert.deepEqual(index.aliases, { v3: '3.2.1', 'v3.2': '3.2.1', 'v3.1': '3.1.2' });
  assert.equal(index.versions.length, 5);
});

test('no URL or identifier is copied out of the source document', () => {
  // The published document is what every file-based consumer resolves
  // against, so each entry is rebuilt from the version string.
  const poisoned = source();
  poisoned.versions[0].path = 'https://evil.example/schemas/';
  poisoned.versions[0].index = 'https://evil.example/pwn.json';
  poisoned.versions[0].extra_field = 'dropped';
  poisoned.title = 'AdCP Schema Discovery';

  const { index } = build({ source: poisoned });
  const serialized = JSON.stringify(index);

  assert.ok(!serialized.includes('evil.example'));
  assert.ok(!serialized.includes('extra_field'));
  assert.equal(index.$id, SCHEMA_ID);
  assert.equal(index.$schema, JSON_SCHEMA);
  assert.equal(index.channel, 'stable');
  for (const published of index.versions) {
    assert.equal(published.path, `/schemas/${published.version}/`);
    assert.equal(published.index, `/schemas/${published.version}/index.json`);
  }
  assert.deepEqual(publishedEntry(entry('3.1.3', 'withdrawn', { deprecated: true, withdrawn: true })), {
    version: '3.1.3',
    stability: 'withdrawn',
    prerelease: false,
    deprecated: true,
    withdrawn: true,
    path: '/schemas/3.1.3/',
    index: '/schemas/3.1.3/index.json',
  });
});

test('a source document that disagrees with its own version list is refused', () => {
  // The whole defect is a frozen pointer. Publishing a document whose aliases
  // predate its version list would freeze it again, one release behind.
  assert.throws(
    () => build({ source: source({ overrides: { aliases: { v3: '3.2.1' } } }) }),
    /Stale schema discovery source: aliases .*npm run build:schemas/s,
  );
  assert.throws(
    () => build({ source: source({ overrides: { latest_stable: '3.2.1' } }) }),
    /Stale schema discovery source: latest_stable/,
  );
  assert.throws(
    () => build({ source: source({ overrides: { $id: 'https://evil.example/schemas/index.json' } }) }),
    /source \$id is/,
  );
  assert.throws(
    () => build({ source: source({ overrides: { channel: 'beta' } }) }),
    /source channel is/,
  );
  assert.throws(
    () => build({ source: source({ extra: [entry('3.9.9', 'experimental')] }) }),
    /unknown stability/,
  );
});

const PUBLISHED = {
  latest_stable: '3.2.5',
  aliases: { v3: '3.2.5', 'v3.2': '3.2.5', 'v3.1': '3.1.29' },
  latest_by_major: { 3: '3.2.5' },
  latest_by_minor: { '3.2': '3.2.5', '3.1': '3.1.29' },
  versions: [{ version: '3.2.5' }, { version: '3.1.29' }],
};

test('a pointer never moves backwards', () => {
  // A truncated or stale view must fail loudly rather than un-release 3.2.5.
  assert.throws(
    () => build({
      source: source({ stable: ['3.2.5', '3.2.4', '3.1.29'] }),
      presentVersions: ['3.2.4', '3.1.29'],
      confirmedVersions: ['3.2.4', '3.1.29'],
      publishedIndex: PUBLISHED,
    }),
    /Refusing to regress published schema discovery pointer (latest_stable|aliases\.v3)/,
  );

  assert.throws(
    () => build({
      source: source({ stable: ['3.2.5'] }),
      presentVersions: ['3.2.5'],
      confirmedVersions: ['3.2.5'],
      publishedIndex: PUBLISHED,
    }),
    /Refusing to drop published schema discovery pointer aliases\.v3\.1/,
  );

  const { index } = build({
    source: source({ stable: ['3.2.6', '3.2.5', '3.1.29'] }),
    presentVersions: ['3.2.6', '3.2.5', '3.1.29'],
    confirmedVersions: ['3.2.6', '3.2.5', '3.1.29'],
    publishedIndex: PUBLISHED,
  });
  assert.equal(index.latest_stable, '3.2.6');
});

test('withdrawing the release that owns an alias is the one legitimate regression', () => {
  // RELEASE_STATUS_OVERRIDES has retired 3.1.3 and 3.2.0 before. Without this
  // exemption the next such override on a live alias would wedge every deploy.
  const withdrawn = source({
    stable: ['3.2.4', '3.1.29'],
    extra: [entry('3.2.5', 'withdrawn', { deprecated: true, withdrawn: true })],
  });
  assert.ok(retiredVersions(withdrawn).has('3.2.5'));

  const { index } = build({
    source: withdrawn,
    presentVersions: ['3.2.5', '3.2.4', '3.1.29'],
    confirmedVersions: ['3.2.4', '3.1.29'],
    publishedIndex: PUBLISHED,
  });
  assert.equal(index.latest_stable, '3.2.4');
  assert.equal(index.aliases['v3.2'], '3.2.4');
});

test('a missing published index disables the regression guard, so it is refused', () => {
  assert.throws(
    () => buildPublishablePointers({
      source: source(),
      presentVersions: DEFAULT_STABLE,
      confirmedVersions: DEFAULT_STABLE,
      publishedIndex: null,
    }),
    /refusing to publish without the regression guard/,
  );
  assert.throws(
    () => build({ publishedIndex: {}, allowBootstrap: false }),
    /Published schemas\/index\.json has no latest_stable/,
  );
});

test('a dropped enumeration entry is reported, not fatal', () => {
  // Losing an older entry is consumer-visible but not an alias misdirection,
  // and failing on it would wedge every deploy over a listing wobble.
  const { dropped, index } = build({
    source: source({ stable: ['3.2.5', '3.1.29'] }),
    presentVersions: ['3.2.5'],
    confirmedVersions: ['3.2.5'],
    publishedIndex: { ...PUBLISHED, aliases: { v3: '3.2.5' }, latest_by_major: {}, latest_by_minor: {} },
  });
  assert.deepEqual(dropped, ['3.1.29']);
  assert.equal(index.latest_stable, '3.2.5');
});

test('an empty confirmed set is refused rather than published as empty pointers', () => {
  assert.throws(
    () => build({ presentVersions: [], confirmedVersions: [] }),
    /No stable schema version has a confirmed index\.json/,
  );
  assert.throws(
    () => build({ presentVersions: ['3.2.5'], confirmedVersions: ['3.1.29'] }),
    /Confirmed schema version 3\.1\.29 is absent from the CDN listing/,
  );
});

test('version directories come from the delimited bucket listing', () => {
  assert.deepEqual(
    versionsFromListing({
      CommonPrefixes: [
        { Prefix: 'schemas/3.2.5/' },
        { Prefix: 'schemas/3.2.0-rc.7/' },
        { Prefix: 'schemas/latest/' },
        { Prefix: 'schemas/v3/' },
      ],
      Contents: [{ Key: 'schemas/index.json' }],
    }),
    ['3.2.5', '3.2.0-rc.7'],
  );
  assert.deepEqual(versionsFromListing({}), []);
  // A partial version set is how a pointer would silently regress.
  assert.throws(() => versionsFromListing({ IsTruncated: true, CommonPrefixes: [] }), /Truncated schemas\/ listing/);
  assert.throws(() => versionsFromListing({ NextContinuationToken: 'x' }), /Truncated schemas\/ listing/);
});

test('a compromised published index cannot pollute or pass', () => {
  // The served copy is attacker-reachable if the bucket is ever compromised.
  // JSON.parse, unlike an object literal, makes `__proto__` an own property.
  assert.throws(
    () => build({
      publishedIndex: JSON.parse('{"latest_stable":"3.2.5","aliases":{"__proto__":"9.9.9","v3":"3.2.5"}}'),
    }),
    /Refusing to (compare non-stable|regress|drop) .*__proto__/,
  );
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.v3, undefined);
  assert.throws(
    () => build({ publishedIndex: { latest_stable: '9.9.9' } }),
    /Refusing to regress published schema discovery pointer latest_stable: 9\.9\.9 -> 3\.2\.5/,
  );
});

test('deploy publishes the pointers and verifies them against the public origin', () => {
  // No execution path covers the workflow wiring itself.
  assert.match(DEPLOY, /--build-latest --latest-only --quiet/);
  assert.match(DEPLOY, /--pointer-output-dir "\$\{RUNNER_TEMP\}\/schema-pointers"/);
  assert.match(DEPLOY, /node scripts\/verify-schema-discovery\.mjs/);
});

// ── Post-publication verification ───────────────────────────────────

const verifier = () => import('../scripts/verify-schema-discovery.mjs');

const EXPECTED = {
  latest: '3.2.5',
  latest_stable: '3.2.5',
  channel: 'stable',
  aliases: { v3: '3.2.5', 'v3.1': '3.1.29' },
  latest_by_major: { 3: '3.2.5' },
  latest_by_minor: { '3.2': '3.2.5', '3.1': '3.1.29' },
};
const EXPECTED_TEXT = `${JSON.stringify(EXPECTED, null, 2)}\n`;

function origin(documents) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const key = new URL(url).pathname;
    const body = typeof documents[key] === 'function' ? documents[key](requests.length) : documents[key];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch, requests };
}

const run = async (documents, overrides = {}) => {
  const { verifySchemaDiscovery } = await verifier();
  const remote = origin(documents);
  const problems = await verifySchemaDiscovery(
    { origin: 'https://cdn.invalid', attempts: 3, delayMs: 0, expectedIndex: 'index', ...overrides },
    { fetch: remote.fetch, sleep: async () => {}, readText: async () => EXPECTED_TEXT, log: () => {} },
  );
  return { problems, requests: remote.requests };
};

test('a current published pointer passes on the first fetch', async () => {
  const { problems, requests } = await run({ '/schemas/index.json': EXPECTED_TEXT });
  assert.deepEqual(problems, []);
  assert.equal(requests.length, 1);
  // The canonical URL is what consumers request; no cache-busted variant.
  assert.equal(requests[0], 'https://cdn.invalid/schemas/index.json');
});

test('a trailing alias fails after exhausting retries', async () => {
  const stale = `${JSON.stringify({
    ...EXPECTED, latest: '3.2.1', latest_stable: '3.2.1', aliases: { v3: '3.2.1', 'v3.1': '3.1.24' },
  }, null, 2)}\n`;
  const { problems, requests } = await run({ '/schemas/index.json': stale });
  assert.equal(requests.length, 3);
  assert.ok(problems.some((problem) => problem.includes('latest_stable is "3.2.1", expected "3.2.5"')));
  assert.ok(problems.some((problem) => problem.includes('aliases.v3 is "3.2.1", expected "3.2.5"')));
  assert.ok(problems.some((problem) => problem.includes('aliases.v3.1 is "3.1.24", expected "3.1.29"')));
});

test('matching pointers over different bytes still fail', async () => {
  // Uploading is not serving. A document whose pointers happen to agree but
  // whose body differs is not the document this run published.
  const { problems } = await run({
    '/schemas/index.json': `${JSON.stringify({ ...EXPECTED, versions: [] }, null, 2)}\n`,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pointers match but .* does not serve the published bytes/);
});

test('propagation lag is retried rather than failed', async () => {
  const stale = `${JSON.stringify({ ...EXPECTED, latest_stable: '3.2.1' }, null, 2)}\n`;
  const { problems, requests } = await run({
    '/schemas/index.json': (attempt) => (attempt < 3 ? stale : EXPECTED_TEXT),
  });
  assert.deepEqual(problems, []);
  assert.equal(requests.length, 3);
});

test('an unreachable or unparseable document is a failure, never a pass', async () => {
  const missing = await run({});
  assert.equal(missing.problems.length, 1);
  assert.match(missing.problems[0], /could not read .*\/schemas\/index\.json.*HTTP 404/);

  const garbage = await run({ '/schemas/index.json': '<html>503</html>' });
  assert.ok(garbage.problems.length > 0);
  assert.ok(garbage.problems.some((problem) => /latest is undefined, expected "3\.2\.5"/.test(problem)));
});

test('schemas/latest.json is verified when the publication step produced it', async () => {
  const { problems, requests } = await run(
    { '/schemas/index.json': EXPECTED_TEXT, '/schemas/latest.json': '{"latest":"3.2.1"}' },
    { expectedLatest: 'latest' },
  );
  assert.ok(requests.some((url) => url.endsWith('/schemas/latest.json')));
  assert.ok(problems.some((problem) => problem.startsWith('schemas/latest.json: latest is "3.2.1"')));
});

test('parseArgs rejects unusable settings', async () => {
  const { parseArgs } = await verifier();
  assert.equal(parseArgs(['--expected-index', 'a']).origin, 'https://adcontextprotocol.org');
  assert.equal(parseArgs(['--expected-index', 'a', '--origin', 'https://cdn.invalid/']).origin, 'https://cdn.invalid');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--expected-index', 'a', '--attempts', '0']), /--attempts must be a positive integer/);
  assert.throws(() => parseArgs(['--expected-index', 'a', '--delay-ms', '-1']), /--delay-ms must be a non-negative integer/);
  assert.throws(() => parseArgs(['--expected-index', 'a', '--origin', 'file:///etc']), /--origin must be an http\(s\) URL/);
  assert.throws(() => parseArgs([]), /--expected-index/);
});
