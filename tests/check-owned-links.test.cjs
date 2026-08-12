const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

function mockResponse(status, location, onCancel = () => {}) {
  return {
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() !== 'location') return null;
        return location ?? null;
      },
    },
    body: {
      async cancel() {
        onCancel();
      },
    },
  };
}

function makeCatalogRoot(markdown, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-links-'));
  const catalog = path.join(root, 'server/src/addie/rules/urls.md');
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(catalog, markdown);
  for (const [file, contents] of Object.entries(extraFiles)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

function outputCollector() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    output: {
      log(message) { logs.push(message); },
      error(message) { errors.push(message); },
    },
  };
}

(async () => {
  const {
    URL_CLASS,
    checkDirectUrl,
    checkStableDocsAlias,
    checkUrl,
    main,
    parseUrlCatalog,
  } = await import('../scripts/check-owned-links.js');

  test('classifies only structured entries in the three live catalog sections', () => {
    const entries = parseUrlCatalog(`
# Canonical URL Reference

Prose may mention https://agenticadvertising.org/not-an-entry.

## Direct destinations — no redirects
- https://agenticadvertising.org/community — Community

## Action entry points — redirects expected
- https://agenticadvertising.org/connect/github — OAuth entry

## Stable documentation aliases — keep unversioned
- https://docs.adcontextprotocol.org/docs/quickstart — Quickstart

## Common hallucinations — these do not exist
- https://agenticadvertising.org/hallucination

## Deprecated — do not cite
- https://agenticadvertising.org/deprecated
`);

    assert.deepEqual(
      entries.map(({ url, classification }) => ({ url, classification })),
      [
        {
          url: 'https://agenticadvertising.org/community',
          classification: URL_CLASS.DIRECT,
        },
        {
          url: 'https://agenticadvertising.org/connect/github',
          classification: URL_CLASS.ACTION,
        },
        {
          url: 'https://docs.adcontextprotocol.org/docs/quickstart',
          classification: URL_CLASS.STABLE_DOCS,
        },
      ],
    );
  });

  test('action entry-point redirects are accepted through ordinary follow reachability', async () => {
    const root = makeCatalogRoot(`
## Action entry points — redirects expected
- https://agenticadvertising.org/connect/github — OAuth entry

## Direct destinations — no redirects

## Stable documentation aliases — keep unversioned
`);
    const calls = [];
    const captured = outputCollector();

    try {
      const ok = await main({
        root,
        output: captured.output,
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          // A followed fetch exposes the final 2xx, not the intermediate 3xx.
          return mockResponse(200);
        },
      });

      assert.equal(ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.method, 'HEAD');
      assert.equal(calls[0].options.redirect, 'follow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts a stable documentation alias that returns 2xx', async () => {
    const result = await checkStableDocsAlias(
      'https://docs.adcontextprotocol.org/docs/quickstart',
      { fetchImpl: async () => mockResponse(200) },
    );

    assert.deepEqual(result, { ok: true, status: 200, method: 'GET' });
  });

  test('accepts an equivalent snapshot redirect at an arbitrary semver release', async () => {
    const target = 'https://docs.adcontextprotocol.org/dist/docs/9.8.0-beta.4/quickstart';
    let calls = 0;
    const result = await checkStableDocsAlias(
      'https://docs.adcontextprotocol.org/docs/quickstart',
      {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? mockResponse(307, target) : mockResponse(200);
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.location, target);
    assert.equal(calls, 2);
  });

  test('normalizes optional registry /index in a snapshot redirect', async () => {
    const target = 'https://docs.adcontextprotocol.org/dist/docs/8.4.1/registry/index';
    let calls = 0;
    const result = await checkStableDocsAlias(
      'https://docs.adcontextprotocol.org/docs/registry#authentication',
      {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? mockResponse(302, target) : mockResponse(200);
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.location, `${target}#authentication`);
  });

  test('rejects drift after an initially equivalent snapshot hop', async () => {
    const source = 'https://docs.adcontextprotocol.org/docs/quickstart';
    const equivalent = 'https://docs.adcontextprotocol.org/dist/docs/3.1.0-rc.15/quickstart';
    const drifted = 'https://docs.adcontextprotocol.org/dist/docs/3.1.0-rc.15/getting-started';
    const result = await checkStableDocsAlias(source, {
      fetchImpl: async (url) => (
        url === source
          ? mockResponse(302, equivalent)
          : mockResponse(302, drifted)
      ),
    });

    assert.equal(result.ok, false);
    assert.equal(result.location, drifted);
    assert.match(result.error, /STABLE DOC ALIAS DRIFT/);
  });

  test('detects equivalent snapshot loops and enforces a redirect hop limit', async () => {
    const source = 'https://docs.adcontextprotocol.org/docs/quickstart';
    const first = 'https://docs.adcontextprotocol.org/dist/docs/3.1.0/quickstart';
    const second = 'https://docs.adcontextprotocol.org/dist/docs/3.2.0-beta.1/quickstart';
    const redirects = new Map([
      [source, first],
      [first, second],
      [second, first],
    ]);
    const loop = await checkStableDocsAlias(source, {
      fetchImpl: async (url) => mockResponse(302, redirects.get(url)),
    });
    const limited = await checkStableDocsAlias(source, {
      maxRedirects: 1,
      fetchImpl: async (url) => mockResponse(302, redirects.get(url)),
    });

    assert.equal(loop.ok, false);
    assert.match(loop.error, /STABLE DOC ALIAS LOOP/);
    assert.equal(limited.ok, false);
    assert.match(limited.error, /STABLE DOC ALIAS REDIRECT LIMIT/);
  });

  test('rejects snapshot destinations without a semver-shaped AdCP release', async () => {
    const source = 'https://docs.adcontextprotocol.org/docs/quickstart';
    const target = 'https://docs.adcontextprotocol.org/dist/docs/latest/quickstart';
    const result = await checkStableDocsAlias(source, {
      fetchImpl: async () => mockResponse(302, target),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /STABLE DOC ALIAS DRIFT/);
  });

  test('inherits omitted fragments, accepts the same fragment, and rejects changes', async () => {
    const source = 'https://docs.adcontextprotocol.org/docs/registry#authentication';
    const snapshot = 'https://docs.adcontextprotocol.org/dist/docs/3.1.0-rc.15/registry/index';

    async function run(firstLocation) {
      let calls = 0;
      return checkStableDocsAlias(source, {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? mockResponse(302, firstLocation) : mockResponse(200);
        },
      });
    }

    const inherited = await run(snapshot);
    const same = await run(`${snapshot}#authentication`);
    const changed = await run(`${snapshot}#overview`);

    assert.equal(inherited.ok, true);
    assert.equal(inherited.location, `${snapshot}#authentication`);
    assert.equal(same.ok, true);
    assert.equal(same.location, `${snapshot}#authentication`);
    assert.equal(changed.ok, false);
    assert.match(changed.error, /STABLE DOC ALIAS DRIFT/);
  });

  test('rejects a stable alias redirect that moves to a different logical page', async () => {
    const source = 'https://docs.adcontextprotocol.org/docs/quickstart';
    const target = 'https://docs.adcontextprotocol.org/dist/docs/4.0.0/getting-started';
    const result = await checkStableDocsAlias(source, {
      fetchImpl: async () => mockResponse(302, target),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      `STABLE DOC ALIAS DRIFT: ${source} → ${target} (expected the same logical path under /dist/docs/<release>)`,
    );
  });

  test('rejects absolute and relative redirects from direct destinations', async () => {
    const source = 'https://agenticadvertising.org/legal/terms';
    const absolute = 'https://agenticadvertising.org/legal/terms-of-service';
    const absoluteResult = await checkDirectUrl(source, {
      fetchImpl: async () => mockResponse(301, absolute),
    });
    const relativeResult = await checkDirectUrl(source, {
      fetchImpl: async () => mockResponse(302, './terms-of-service'),
    });

    assert.equal(
      absoluteResult.error,
      `REDIRECT DRIFT: ${source} → ${absolute} (expected no redirect)`,
    );
    assert.equal(relativeResult.error, absoluteResult.error);
  });

  test('describes a redirect with no Location header', async () => {
    const source = 'https://agenticadvertising.org/legal/privacy';
    const result = await checkDirectUrl(source, {
      fetchImpl: async () => mockResponse(301),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      `REDIRECT DRIFT: ${source} → [missing Location header on HTTP 301] (expected no redirect)`,
    );
  });

  test('uses manual GET for policy checks and cancels the response body', async () => {
    const calls = [];
    let cancellations = 0;
    const result = await checkDirectUrl(
      'https://agenticadvertising.org/community',
      {
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return mockResponse(200, null, () => { cancellations += 1; });
        },
      },
    );

    assert.deepEqual(result, { ok: true, status: 200, method: 'GET' });
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(cancellations, 1);
  });

  test('keeps ordinary reachability checks on follow-redirect HEAD', async () => {
    const calls = [];
    const result = await checkUrl('https://agenticadvertising.org/community', {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return mockResponse(200);
      },
    });

    assert.deepEqual(result, { ok: true, status: 200, method: 'HEAD' });
    assert.equal(calls[0].options.method, 'HEAD');
    assert.equal(calls[0].options.redirect, 'follow');
  });

  test('retries transient manual-check failures with bounded backoff', async () => {
    const sleeps = [];
    let attempts = 0;
    const result = await checkDirectUrl(
      'https://agenticadvertising.org/community',
      {
        retries: 2,
        sleep: async (ms) => { sleeps.push(ms); },
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary reset');
          if (attempts === 2) return mockResponse(503);
          return mockResponse(204);
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('reports malformed and self-redirect Location values', async () => {
    const direct = 'https://agenticadvertising.org/community';
    const malformed = await checkDirectUrl(direct, {
      fetchImpl: async () => mockResponse(302, 'http://[invalid'),
    });
    const docs = 'https://docs.adcontextprotocol.org/docs/quickstart';
    const self = await checkStableDocsAlias(docs, {
      fetchImpl: async () => mockResponse(302, docs),
    });

    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /malformed Location/);
    assert.equal(self.ok, false);
    assert.match(self.error, /STABLE DOC ALIAS DRIFT/);
  });

  test('main accumulates reachability and policy errors and returns false', async () => {
    const direct = 'https://agenticadvertising.org/legal/terms';
    const broken = 'https://agenticadvertising.org/broken-test-entry';
    const root = makeCatalogRoot(`
## Direct destinations — no redirects
- ${direct} — Terms

## Action entry points — redirects expected

## Stable documentation aliases — keep unversioned
`, {
      'README.md': `See ${broken}.`,
    });
    const captured = outputCollector();

    try {
      const ok = await main({
        root,
        output: captured.output,
        fetchImpl: async (url, options) => {
          if (url === broken) return mockResponse(404);
          if (options.redirect === 'manual') {
            return mockResponse(301, '/legal/terms-of-service');
          }
          return mockResponse(200);
        },
      });

      assert.equal(ok, false);
      assert.ok(captured.errors.includes('Broken browser-facing links found:'));
      assert.ok(captured.errors.includes('Canonical URL policy failures found:'));
      assert.ok(captured.errors.some((line) => line.includes(broken)));
      assert.ok(captured.errors.some((line) => line.includes('REDIRECT DRIFT')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed for renamed or missing required policy sections', () => {
    assert.throws(
      () => parseUrlCatalog(`
## Direct destinations - no redirects
- https://agenticadvertising.org/community

## Action entry points — redirects expected

## Stable documentation aliases — keep unversioned
`),
      (error) => {
        assert.equal(error.name, 'CatalogParseError');
        assert.match(error.message, /missing required section "## Direct destinations/);
        assert.match(error.message, /unrecognized live section/);
        return true;
      },
    );
  });

  test('fails closed on an owned URL bullet under an unexpected live section', () => {
    assert.throws(
      () => parseUrlCatalog(`
## Direct destinations — no redirects

## Action entry points — redirects expected

## Stable documentation aliases — keep unversioned

## New live bucket
- https://agenticadvertising.org/community

## Deprecated — do not cite
- https://agenticadvertising.org/deprecated
`),
      /owned URL list entry .* unrecognized live section "New live bucket"/,
    );
  });

  test('CLI exits nonzero before network access when catalog policy parsing fails', () => {
    const root = makeCatalogRoot(`
## Direct destinations renamed
- https://agenticadvertising.org/community
`);
    const script = path.resolve(__dirname, '../scripts/check-owned-links.js');

    try {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid URL catalog/);
      assert.match(result.stderr, /missing required section/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
})();
