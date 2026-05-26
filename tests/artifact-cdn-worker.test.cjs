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
  }

  async get(key) {
    return this.entries.get(key) ?? null;
  }

  async head(key) {
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
      object('schemas/latest/foo.json', '{"version":"latest"}', { contentType: 'application/json; charset=utf-8' }),
      object('compliance/3.0.12/index.json', '{"version":"3.0.12"}', {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      }),
      object('compliance/3.1.0-beta.3/index.json', '{"version":"3.1.0-beta.3"}', {
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
    ], { pageSize: 2 }),
  };
}

async function fetchPath(path, init) {
  const { clearVersionCacheForTests, handleRequest } = await loadWorker();
  clearVersionCacheForTests();
  return handleRequest(new Request(`https://artifacts.example${path}`, init), env(), {});
}

describe('artifact CDN Worker', () => {
  it('rewrites major aliases to the latest matching semver directory', async () => {
    const response = await fetchPath('/schemas/v3/foo.json');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '3.1.0-beta.3' });
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
    assert.deepEqual(await response.json(), { version: '3.1.0-beta.3' });
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

  it('keeps pinned semver paths immutable', async () => {
    const response = await fetchPath('/schemas/3.0.12/foo.json');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  it('redirects bare alias directories to concrete index.json paths', async () => {
    const response = await fetchPath('/schemas/v3/');

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/schemas/3.1.0-beta.3/index.json');
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
    assert.deepEqual(body.versions.map((entry) => entry.version), ['3.1.0-beta.3', '3.0.12']);
    assert.deepEqual(body.aliases, [
      { alias: 'v3', resolves_to: '3.1.0-beta.3', path: '/schemas/v3/' },
      { alias: 'v3.0', resolves_to: '3.0.12', path: '/schemas/v3.0/' },
      { alias: 'v3.1', resolves_to: '3.1.0-beta.3', path: '/schemas/v3.1/' },
    ]);
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

  it('lists protocol tarballs for discovery', async () => {
    const response = await fetchPath('/protocol/');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.versions, [
      {
        version: '3.0.12',
        tarball: '/protocol/3.0.12.tgz',
        checksum: '/protocol/3.0.12.tgz.sha256',
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
