const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

class MockR2Object {
  constructor(key, body, httpMetadata = {}) {
    this.key = key;
    this.body = body;
    this.httpMetadata = httpMetadata;
    this.httpEtag = `"${key}"`;
    this.uploaded = new Date('2026-05-24T00:00:00Z');
  }

  writeHttpMetadata(headers) {
    for (const [key, value] of Object.entries(this.httpMetadata)) {
      if (value !== undefined) headers.set(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
    }
  }
}

class MockBucket {
  constructor(entries, options = {}) {
    this.entries = new Map(entries);
    this.pageSize = options.pageSize ?? Infinity;
    this.getCalls = new Map();
    this.headCalls = new Map();
  }

  async get(key) {
    this.getCalls.set(key, (this.getCalls.get(key) ?? 0) + 1);
    return this.entries.get(key) ?? null;
  }

  async head(key) {
    this.headCalls.set(key, (this.headCalls.get(key) ?? 0) + 1);
    const object = this.entries.get(key);
    return object ? new MockR2Object(key, null, object.httpMetadata) : null;
  }

  async list(options = {}) {
    const prefix = options.prefix ?? '';
    const keys = [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const pageKeys = keys.slice(start, start + this.pageSize);
    const next = start + pageKeys.length;
    const truncated = next < keys.length;
    if (options.delimiter) {
      const delimitedPrefixes = [];
      const seen = new Set();
      for (const key of pageKeys) {
        const rest = key.slice(prefix.length);
        const delimiterIndex = rest.indexOf(options.delimiter);
        if (delimiterIndex === -1) continue;
        const childPrefix = `${prefix}${rest.slice(0, delimiterIndex + 1)}`;
        if (!seen.has(childPrefix)) {
          seen.add(childPrefix);
          delimitedPrefixes.push(childPrefix);
        }
      }
      return { objects: [], delimitedPrefixes, truncated, cursor: truncated ? String(next) : undefined };
    }
    return {
      objects: pageKeys.map((key) => ({ key })),
      truncated,
      cursor: truncated ? String(next) : undefined,
    };
  }
}

class MockEdgeCache {
  constructor() {
    this.entries = new Map();
    this.matches = 0;
    this.puts = 0;
  }

  async match(request) {
    this.matches += 1;
    return this.entries.get(request.url)?.clone();
  }

  async put(request, response) {
    this.puts += 1;
    this.entries.set(request.url, response.clone());
  }
}

function object(key, body, httpMetadata = {}) {
  return [key, new MockR2Object(key, body, httpMetadata)];
}

async function loadWorker() {
  return import('../workers/artifact-cdn/src/index.js');
}

function env() {
  return {
    ARTIFACTS: new MockBucket([
      object('schemas/3.0.12/index.json', '{"version":"3.0.12"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('schemas/3.0.12/foo.json', '{"version":"3.0.12"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('schemas/3.1.0-beta.3/index.json', '{"version":"3.1.0-beta.3"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('schemas/3.1.0-beta.3/foo.json', '{"version":"3.1.0-beta.3"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('schemas/3.1.0/index.json', '{"version":"3.1.0"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('schemas/3.1.0/foo.json', '{"version":"3.1.0"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('schemas/index.json', '{"latest_stable":"3.1.0"}', { contentType: 'application/json; charset=utf-8' }),
      object('schemas/latest.json', '{"latest_stable":"3.1.0"}', { contentType: 'application/json; charset=utf-8' }),
      object('schemas/latest/foo.json', '{"version":"latest"}', { contentType: 'application/json; charset=utf-8' }),
      object('compliance/3.0.12/index.json', '{"version":"3.0.12"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('compliance/3.1.0-beta.3/index.json', '{"version":"3.1.0-beta.3"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('compliance/3.1.0/index.json', '{"version":"3.1.0"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('protocol/3.0.12.tgz', 'pinned-tarball', {
        contentType: 'application/gzip',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('protocol/3.0.12.tgz.sha256', 'pinned-checksum', {
        contentType: 'text/plain; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('protocol/3.0.12.tgz.sig', 'pinned-signature', {
        contentType: 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('protocol/3.0.12.tgz.crt', 'pinned-certificate', {
        contentType: 'application/x-pem-file',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('protocol/latest.tgz', 'latest-tarball', {
        contentType: 'application/gzip',
        cacheControl: 'public, no-cache, must-revalidate',
      }),
      object('protocol/latest.tgz.sha256', 'latest-checksum', {
        contentType: 'text/plain; charset=utf-8',
        cacheControl: 'public, no-cache, must-revalidate',
      }),
    ]),
  };
}

function paginatedEnv() {
  return {
    ARTIFACTS: new MockBucket([
      object('schemas/3.0.0/a.json', 'old'),
      object('schemas/3.0.1/a.json', 'old'),
      object('schemas/3.0.2/a.json', 'old'),
      object('schemas/3.0.3/a.json', 'old'),
      object('schemas/3.1.0-beta.3/foo.json', '{"version":"3.1.0-beta.3"}'),
      object('schemas/3.1.0/foo.json', '{"version":"3.1.0"}'),
    ], { pageSize: 2 }),
  };
}

async function fetchPath(path, init) {
  const { clearVersionCacheForTests, handleRequest } = await loadWorker();
  clearVersionCacheForTests();
  return handleRequest(new Request(`https://artifacts.example${path}`, init), env(), {});
}

async function withMockEdgeCache(cache, callback) {
  const hadCaches = Object.hasOwn(globalThis, 'caches');
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await callback();
  } finally {
    if (hadCaches) {
      globalThis.caches = previousCaches;
    } else {
      delete globalThis.caches;
    }
  }
}

describe('artifact CDN Worker', () => {
  it('rewrites major aliases to the latest matching semver directory', async () => {
    const response = await fetchPath('/schemas/v3/foo.json');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '3.1.0' });
    assert.equal(response.headers.get('cache-control'), 'public, no-cache, must-revalidate');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('paginates R2 prefix listings before resolving aliases', async () => {
    const { clearVersionCacheForTests, handleRequest } = await loadWorker();
    clearVersionCacheForTests();
    const response = await handleRequest(
      new Request('https://artifacts.example/schemas/v3/foo.json'),
      paginatedEnv(),
      {},
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '3.1.0' });
  });

  it('rewrites minor aliases to the latest patch in that minor', async () => {
    const response = await fetchPath('/schemas/v3.0/foo.json');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '3.0.12' });
    assert.equal(response.headers.get('cache-control'), 'public, no-cache, must-revalidate');
  });

  it('preserves the v1 to latest compatibility alias', async () => {
    const response = await fetchPath('/schemas/v1/foo.json');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: 'latest' });
  });

  it('serves root schema discovery files as revalidated mutable artifacts', async () => {
    const index = await fetchPath('/schemas/index.json');
    const latest = await fetchPath('/schemas/latest.json');

    assert.equal(index.status, 200);
    assert.deepEqual(await index.json(), { latest_stable: '3.1.0' });
    assert.equal(index.headers.get('cache-control'), 'public, no-cache, must-revalidate');

    assert.equal(latest.status, 200);
    assert.deepEqual(await latest.json(), { latest_stable: '3.1.0' });
    assert.equal(latest.headers.get('cache-control'), 'public, no-cache, must-revalidate');
  });

  it('keeps pinned semver paths immutable', async () => {
    const response = await fetchPath('/schemas/3.0.12/foo.json');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  it('resolves a pinned docs-only version bump to the nearest published release', async () => {
    const response = await fetchPath('/schemas/3.0.19/foo.json');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '3.0.12' });
    assert.equal(response.headers.get('cache-control'), 'public, no-cache, must-revalidate');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('redirects a bare pinned-fallback version directory to the resolved index.json', async () => {
    const response = await fetchPath('/schemas/3.0.19/');

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/schemas/3.0.12/index.json');
  });

  it('never resolves a stable pin to a prerelease on the same line', async () => {
    // 3.2.x has no stable release published; a stable 3.2.5 pin must fall
    // back to the highest stable in the major (3.1.0), not a prerelease.
    const response = await fetchPath('/schemas/3.2.5/foo.json');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '3.1.0' });
    assert.equal(response.headers.get('cache-control'), 'public, no-cache, must-revalidate');
  });

  it('does not edge-cache resolved pinned fallbacks', async () => {
    const { clearVersionCacheForTests, handleRequest } = await loadWorker();
    const testEnv = env();
    const edgeCache = new MockEdgeCache();
    const ctx = { waitUntil: () => assert.fail('resolved fallbacks should not write to edge cache') };
    clearVersionCacheForTests();

    await withMockEdgeCache(edgeCache, async () => {
      const response = await handleRequest(
        new Request('https://artifacts.example/schemas/3.0.19/foo.json'),
        testEnv,
        ctx,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { version: '3.0.12' });
    });

    assert.equal(edgeCache.matches, 0);
    assert.equal(edgeCache.puts, 0);
  });

  it('404s a pinned version with no resolvable release in its major', async () => {
    const response = await fetchPath('/schemas/4.0.0/foo.json');

    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not Found');
  });

  it('uses edge cache for immutable versioned schema objects', async () => {
    const { clearVersionCacheForTests, handleRequest } = await loadWorker();
    const testEnv = env();
    const edgeCache = new MockEdgeCache();
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    clearVersionCacheForTests();

    await withMockEdgeCache(edgeCache, async () => {
      const first = await handleRequest(
        new Request('https://artifacts.example/schemas/3.0.12/foo.json?cache_bust=1'),
        testEnv,
        ctx,
      );
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { version: '3.0.12' });
      await Promise.all(pending);

      const second = await handleRequest(
        new Request('https://artifacts.example/schemas/3.0.12/foo.json?cache_bust=2'),
        testEnv,
        ctx,
      );
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { version: '3.0.12' });
    });

    assert.equal(testEnv.ARTIFACTS.getCalls.get('schemas/3.0.12/foo.json'), 1);
    assert.equal(edgeCache.matches, 2);
    assert.equal(edgeCache.puts, 1);
  });

  it('does not edge-cache movable aliases', async () => {
    const { clearVersionCacheForTests, handleRequest } = await loadWorker();
    const testEnv = env();
    const edgeCache = new MockEdgeCache();
    const ctx = { waitUntil: () => assert.fail('aliases should not write to edge cache') };
    clearVersionCacheForTests();

    await withMockEdgeCache(edgeCache, async () => {
      const first = await handleRequest(new Request('https://artifacts.example/schemas/v3/foo.json'), testEnv, ctx);
      const second = await handleRequest(new Request('https://artifacts.example/schemas/v3/foo.json'), testEnv, ctx);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(await first.json(), { version: '3.1.0' });
      assert.deepEqual(await second.json(), { version: '3.1.0' });
    });

    assert.equal(testEnv.ARTIFACTS.getCalls.get('schemas/3.1.0/foo.json'), 2);
    assert.equal(edgeCache.matches, 0);
    assert.equal(edgeCache.puts, 0);
  });

  it('redirects bare alias directories to concrete index.json paths', async () => {
    const response = await fetchPath('/schemas/v3/');

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/schemas/3.1.0/index.json');
  });

  it('redirects bare version paths before serving index.json', async () => {
    const response = await fetchPath('/schemas/3.1.0-beta.3');

    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), '/schemas/3.1.0-beta.3/');
  });

  it('builds the same discovery shape for schemas and compliance', async () => {
    const response = await fetchPath('/schemas/');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.versions.map((entry) => entry.version), ['3.1.0', '3.1.0-beta.3', '3.0.12']);
    assert.deepEqual(body.aliases, [
      { alias: 'v3', resolves_to: '3.1.0', path: '/schemas/v3/' },
      { alias: 'v3.0', resolves_to: '3.0.12', path: '/schemas/v3.0/' },
      { alias: 'v3.1', resolves_to: '3.1.0', path: '/schemas/v3.1/' },
    ]);
    assert.equal(body.latest_stable, '3.1.0');
    assert.deepEqual(body.latest, {
      path: '/schemas/latest/',
      note: 'Development version, may differ from released versions',
    });
  });

  it('serves protocol files without alias rewriting', async () => {
    const response = await fetchPath('/protocol/latest.tgz');

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'latest-tarball');
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.equal(response.headers.get('cache-control'), 'public, no-cache, must-revalidate');
  });

  it('uses edge cache for pinned protocol tarballs', async () => {
    const { clearVersionCacheForTests, handleRequest } = await loadWorker();
    const testEnv = env();
    const edgeCache = new MockEdgeCache();
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    clearVersionCacheForTests();

    await withMockEdgeCache(edgeCache, async () => {
      const first = await handleRequest(new Request('https://artifacts.example/protocol/3.0.12.tgz'), testEnv, ctx);
      assert.equal(first.status, 200);
      assert.equal(await first.text(), 'pinned-tarball');
      await Promise.all(pending);

      const second = await handleRequest(new Request('https://artifacts.example/protocol/3.0.12.tgz'), testEnv, ctx);
      assert.equal(second.status, 200);
      assert.equal(await second.text(), 'pinned-tarball');
    });

    assert.equal(testEnv.ARTIFACTS.getCalls.get('protocol/3.0.12.tgz'), 1);
    assert.equal(edgeCache.matches, 2);
    assert.equal(edgeCache.puts, 1);
  });

  it('revalidates pinned protocol sidecars without edge caching them', async () => {
    const { clearVersionCacheForTests, handleRequest } = await loadWorker();
    const testEnv = env();
    const edgeCache = new MockEdgeCache();
    const ctx = { waitUntil: () => assert.fail('sidecars should not write to edge cache') };
    clearVersionCacheForTests();

    await withMockEdgeCache(edgeCache, async () => {
      const first = await handleRequest(new Request('https://artifacts.example/protocol/3.0.12.tgz.sig'), testEnv, ctx);
      const second = await handleRequest(new Request('https://artifacts.example/protocol/3.0.12.tgz.sig'), testEnv, ctx);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(await first.text(), 'pinned-signature');
      assert.equal(await second.text(), 'pinned-signature');
      assert.equal(first.headers.get('cache-control'), 'public, no-cache, must-revalidate');
      assert.equal(second.headers.get('cache-control'), 'public, no-cache, must-revalidate');
    });

    assert.equal(testEnv.ARTIFACTS.getCalls.get('protocol/3.0.12.tgz.sig'), 2);
    assert.equal(edgeCache.matches, 0);
    assert.equal(edgeCache.puts, 0);
  });

  it('revalidates pinned protocol checksums', async () => {
    const response = await fetchPath('/protocol/3.0.12.tgz.sha256');

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'pinned-checksum');
    assert.equal(response.headers.get('cache-control'), 'public, no-cache, must-revalidate');
  });

  it('revalidates pinned protocol certificates on GET and HEAD', async () => {
    const getResponse = await fetchPath('/protocol/3.0.12.tgz.crt');
    const headResponse = await fetchPath('/protocol/3.0.12.tgz.crt', { method: 'HEAD' });

    assert.equal(getResponse.status, 200);
    assert.equal(await getResponse.text(), 'pinned-certificate');
    assert.equal(getResponse.headers.get('cache-control'), 'public, no-cache, must-revalidate');
    assert.equal(headResponse.status, 200);
    assert.equal(await headResponse.text(), '');
    assert.equal(headResponse.headers.get('cache-control'), 'public, no-cache, must-revalidate');
  });

  it('lists protocol tarballs for discovery', async () => {
    const response = await fetchPath('/protocol/');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.versions, [
      {
        version: '3.0.12',
        tarball: '/protocol/3.0.12.tgz',
        checksum: '/protocol/3.0.12.tgz.sha256',
        signature: '/protocol/3.0.12.tgz.sig',
        certificate: '/protocol/3.0.12.tgz.crt',
      },
    ]);
    assert.equal(body.latest.tarball, '/protocol/latest.tgz');
    assert.equal(body.latest.published_version, '3.0.12');
  });

  it('serves protocol discovery at the bare protocol path', async () => {
    const response = await fetchPath('/protocol');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.latest.tarball, '/protocol/latest.tgz');
  });

  it('supports HEAD without streaming an object body', async () => {
    const response = await fetchPath('/protocol/3.0.12.tgz', { method: 'HEAD' });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
});
