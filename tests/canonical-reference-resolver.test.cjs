#!/usr/bin/env node
/**
 * Canonical reference resolver regression tests.
 *
 * These tests execute the format_schema fetch-contract fixtures through the
 * upstream SDK resolver. Storyboards assert that sellers emit canonical
 * format_schema references; this suite asserts that the resolver contract
 * those references depend on stays enforced in CI.
 *
 * Run: npm run test:canonical-reference-resolver
 */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const dns = require('node:dns/promises');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

const { createCanonicalReferenceResolver } = require('@adcp/sdk/canonical-references');

const FIXTURES_DIR = path.resolve(__dirname, '../static/examples/format-schemas');
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const ZERO_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const EXPECTED_FIXTURES = [
  'negative/01_digest_mismatch.json',
  'negative/02_http_scheme.json',
  'negative/03_redirect_chain.json',
  'negative/04_oversized_body.json',
  'negative/05_ssrf_rfc1918.json',
  'negative/06_ssrf_metadata_endpoint.json',
  'negative/07_ref_cross_origin.json',
  'negative/08_ref_depth_exceeded.json',
  'negative/09_catastrophic_regex.json',
  'negative/10_invalid_schema.json',
  'negative/11_persistent_404.json',
  'positive/01_well_formed_digest_match.json',
  'positive/02_intra_document_ref.json',
  'positive/03_cached_after_404.json',
];

function fixture(relativePath, expectedOutcome) {
  const loaded = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, relativePath), 'utf8'));
  if (expectedOutcome !== undefined) {
    assert.equal(loaded.expected_outcome, expectedOutcome, `${relativePath} expected_outcome drifted`);
  }
  return loaded;
}

function fixtureSetup(relativePath, expectedOutcome) {
  return fixture(relativePath, expectedOutcome).setup;
}

function assertFixtureField(actual, expected, label) {
  assert.equal(actual, expected, `${label} drifted`);
}

function fixtureResponseBody(relativePath, expectedOutcome) {
  return fixtureSetup(relativePath, expectedOutcome).response_body;
}

function fixtureRoutePath(relativePath) {
  const requestUri = fixtureSetup(relativePath).request_uri;
  return new URL(requestUri).pathname;
}

function fixtureRoute(relativePath, expectedOutcome, responseBody) {
  const setup = fixtureSetup(relativePath, expectedOutcome);
  return jsonRoute(
    responseBody ?? setup.response_body,
    setup.response_status ?? 200,
    setup.response_headers ?? {},
  );
}

function bytesForJson(document) {
  return Buffer.from(JSON.stringify(document), 'utf8');
}

function digestForJson(document) {
  return `sha256:${createHash('sha256').update(bytesForJson(document)).digest('hex')}`;
}

function localResolver(options = {}) {
  return createCanonicalReferenceResolver({
    allowUnsafeHttp: true,
    allowPrivateNetwork: true,
    timeoutMs: 1_000,
    validationBudgetMs: 2_000,
    ...options,
  });
}

async function withRoutes(routes, fn) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const route = routes[pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    route(req, res);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function jsonRoute(document, status = 200, extraHeaders = {}) {
  const body = bytesForJson(document);
  const headers = {
    ...extraHeaders,
    'content-length': body.byteLength,
  };
  if (!hasHeader(headers, 'content-type')) {
    headers['content-type'] = 'application/schema+json';
  }
  return (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
}

function textRoute(text, status = 200, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  const headers = {
    ...extraHeaders,
    'content-length': body.byteLength,
  };
  if (!hasHeader(headers, 'content-type')) {
    headers['content-type'] = 'text/plain';
  }
  return (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
}

function expectFailure(result, expected) {
  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  assert.equal(result.status, expected.status);
  assert.equal(result.error.code, expected.code);
  if (expected.securitySignal) {
    assert.equal(result.error.securitySignal, expected.securitySignal);
  }
  if (expected.httpStatus !== undefined) {
    assert.equal(result.httpStatus, expected.httpStatus);
  }
}

function deepRefSchema(depth) {
  const definitions = {};
  for (let i = 0; i < depth; i++) {
    const current = `d${i}`;
    const next = `d${i + 1}`;
    definitions[current] = { $ref: `#/definitions/${next}` };
  }
  definitions[`d${depth}`] = { type: 'string' };
  return {
    $schema: DRAFT_07,
    $id: '/schemas/test/deep-refs.json',
    type: 'object',
    definitions,
    properties: {
      value: { $ref: '#/definitions/d0' },
    },
  };
}

test('all format_schema fixtures are covered by this resolver runner', () => {
  const discovered = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) => fs.readdirSync(path.join(FIXTURES_DIR, dir.name))
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => `${dir.name}/${fileName}`))
    .sort();

  assert.deepEqual(discovered, EXPECTED_FIXTURES);
});

test('positive format_schema fixtures resolve through the SDK resolver', async (t) => {
  const cases = [
    'positive/01_well_formed_digest_match.json',
    'positive/02_intra_document_ref.json',
  ];

  for (const fixturePath of cases) {
    await t.test(fixturePath, async () => {
      const setup = fixtureSetup(fixturePath, 'pass');
      const routePath = new URL(setup.request_uri).pathname;
      const document = setup.response_body;

      await withRoutes({ [routePath]: fixtureRoute(fixturePath, 'pass') }, async (baseUrl) => {
        const result = await localResolver().resolveFormatSchema({
          uri: `${baseUrl}${routePath}`,
          digest: digestForJson(document),
        });

        assert.equal(result.ok, true, JSON.stringify(result, null, 2));
        assert.equal(result.status, 'resolved');
        assert.equal(result.kind, 'format_schema');
        assert.equal(result.schemaMeta.draft, 'draft-07');
        assert.equal(result.fromCache, false);
      });
    });
  }
});

test('positive cache fixture resolves a cached immutable uri@digest after origin instability', async () => {
  const setup = fixtureSetup('positive/03_cached_after_404.json', 'pass');
  assertFixtureField(setup.cache_state, 'uri_at_digest_present', 'positive/03 cache_state');
  assertFixtureField(setup.response_status, 404, 'positive/03 response_status');
  const cachedBody = fixtureResponseBody('positive/01_well_formed_digest_match.json', 'pass');
  let hits = 0;

  await withRoutes({
    [fixtureRoutePath('positive/03_cached_after_404.json')]: (_req, res) => {
      hits += 1;
      if (hits === 1) {
        fixtureRoute('positive/01_well_formed_digest_match.json', 'pass', cachedBody)(_req, res);
        return;
      }
      textRoute('missing', setup.response_status)(_req, res);
    },
  }, async (baseUrl) => {
    const resolver = localResolver();
    const ref = {
      uri: `${baseUrl}${fixtureRoutePath('positive/03_cached_after_404.json')}`,
      digest: digestForJson(cachedBody),
    };

    const first = await resolver.resolveFormatSchema(ref);
    assert.equal(first.ok, true, JSON.stringify(first, null, 2));
    assert.equal(first.fromCache, false);

    const second = await resolver.resolveFormatSchema(ref);
    assert.equal(second.ok, true, JSON.stringify(second, null, 2));
    assert.equal(second.fromCache, true);
    assert.equal(hits >= 1 && hits <= 2, true, 'resolver should either cache-first or re-fetch once before fallback');
  });
});

test('negative digest fixture fails closed and reports substitution signal', async () => {
  const setup = fixtureSetup('negative/01_digest_mismatch.json', 'fail:digest_mismatch');
  assertFixtureField(setup.declared_digest, ZERO_DIGEST, 'negative/01 declared_digest');

  await withRoutes({ [new URL(setup.request_uri).pathname]: fixtureRoute('negative/01_digest_mismatch.json', 'fail:digest_mismatch') }, async (baseUrl) => {
    const result = await localResolver().resolveFormatSchema({
      uri: `${baseUrl}${new URL(setup.request_uri).pathname}`,
      digest: ZERO_DIGEST,
    });

    expectFailure(result, {
      status: 'digest_mismatch',
      code: 'digest_mismatch',
      securitySignal: 'substitution_attack',
    });
  });
});

test('negative transport fixtures fail before schema consumption', async (t) => {
  await t.test('http scheme is blocked without the test escape hatch', async () => {
    const setup = fixtureSetup('negative/02_http_scheme.json', 'fail:transport');
    assertFixtureField(setup.fetch_attempted, false, 'negative/02 fetch_attempted');
    const result = await createCanonicalReferenceResolver().resolveFormatSchema({
      uri: setup.request_uri,
      digest: ZERO_DIGEST,
    });

    expectFailure(result, {
      status: 'blocked_unsafe_url',
      code: 'non_https_url',
    });
  });

  await t.test('redirects are not followed', async () => {
    const setup = fixtureSetup('negative/03_redirect_chain.json', 'fail:transport');
    assertFixtureField(setup.response_status, 302, 'negative/03 response_status');
    await withRoutes({
      [new URL(setup.request_uri).pathname]: (_req, res) => {
        res.writeHead(setup.response_status, { location: setup.response_headers.Location });
        res.end();
      },
    }, async (baseUrl) => {
      const result = await localResolver().resolveFormatSchema({
        uri: `${baseUrl}${new URL(setup.request_uri).pathname}`,
        digest: ZERO_DIGEST,
      });

      expectFailure(result, {
        status: 'blocked_unsafe_url',
        code: 'redirect_blocked',
        httpStatus: 302,
      });
    });
  });

  await t.test('oversized bodies are capped during fetch', async () => {
    const setup = fixtureSetup('negative/04_oversized_body.json', 'fail:transport');
    assert.equal(setup.response_body_size_bytes > 64, true, 'negative/04 body must exceed test cap');
    await withRoutes({
      [new URL(setup.request_uri).pathname]: textRoute('x'.repeat(256), setup.response_status, setup.response_headers),
    }, async (baseUrl) => {
      const result = await localResolver({ maxBodyBytes: 64 }).resolveFormatSchema({
        uri: `${baseUrl}${new URL(setup.request_uri).pathname}`,
        digest: ZERO_DIGEST,
      });

      expectFailure(result, {
        status: 'unresolvable',
        code: 'body_too_large',
      });
    });
  });
});

test('negative SSRF fixtures are blocked by address policy', async (t) => {
  await t.test('RFC1918 target is blocked', async () => {
    const setup = fixtureSetup('negative/05_ssrf_rfc1918.json', 'fail:transport');
    // The fixture uses an `.invalid` documentation hostname, which this SDK
    // rejects before DNS. Use a neutral hostname with the fixture's resolved IP
    // so this subtest exercises the DNS-resolves-to-private-address path.
    const fixtureUrl = new URL(setup.request_uri);
    const uri = `https://internal-adcp-fixture.net${fixtureUrl.pathname}`;
    const hostname = new URL(uri).hostname;
    assertFixtureField(setup.resolved_ip, '10.99.99.99', 'negative/05 resolved_ip');
    const originalLookup = dns.lookup;
    dns.lookup = async (lookupHostname, options) => {
      if (lookupHostname === hostname) {
        return options?.all ? [{ address: setup.resolved_ip, family: 4 }] : { address: setup.resolved_ip, family: 4 };
      }
      return originalLookup.call(dns, lookupHostname, options);
    };

    let result;
    try {
      result = await createCanonicalReferenceResolver({ timeoutMs: 1_000 }).resolveFormatSchema({
        uri,
        digest: ZERO_DIGEST,
      });
    } finally {
      dns.lookup = originalLookup;
    }

    expectFailure(result, {
      status: 'blocked_unsafe_url',
      code: 'unsafe_url',
    });
  });

  await t.test('cloud metadata endpoint is blocked', async () => {
    const setup = fixtureSetup('negative/06_ssrf_metadata_endpoint.json', 'fail:transport');
    const hostname = new URL(setup.request_uri).hostname;
    assert.equal(hostname, 'metadata.google.internal');
    const originalLookup = dns.lookup;
    dns.lookup = async (lookupHostname, options) => {
      if (lookupHostname === hostname) {
        return options?.all ? [{ address: '169.254.169.254', family: 4 }] : { address: '169.254.169.254', family: 4 };
      }
      return originalLookup.call(dns, lookupHostname, options);
    };

    let result;
    try {
      result = await createCanonicalReferenceResolver({ timeoutMs: 1_000 }).resolveFormatSchema({
        uri: setup.request_uri,
        digest: ZERO_DIGEST,
      });
    } finally {
      dns.lookup = originalLookup;
    }

    expectFailure(result, {
      status: 'blocked_unsafe_url',
      code: 'unsafe_url',
    });
  });
});

test('negative ref-sandbox fixtures reject unsafe or excessive $ref graphs', async (t) => {
  await t.test('cross-origin $ref is rejected', async () => {
    const setup = fixtureSetup('negative/07_ref_cross_origin.json', 'fail:ref_violation');
    const document = setup.response_body;

    await withRoutes({ [new URL(setup.request_uri).pathname]: fixtureRoute('negative/07_ref_cross_origin.json', 'fail:ref_violation') }, async (baseUrl) => {
      const result = await localResolver().resolveFormatSchema({
        uri: `${baseUrl}${new URL(setup.request_uri).pathname}`,
        digest: digestForJson(document),
      });

      expectFailure(result, {
        status: 'invalid_schema',
        code: 'ref_sandbox_violation',
      });
    });
  });

  await t.test('transitive $ref depth is bounded', async () => {
    const setup = fixtureSetup('negative/08_ref_depth_exceeded.json', 'fail:ref_violation');
    assert.match(setup.response_body_summary, /9 deep/);
    const document = deepRefSchema(9);

    await withRoutes({ [new URL(setup.request_uri).pathname]: fixtureRoute('negative/08_ref_depth_exceeded.json', 'fail:ref_violation', document) }, async (baseUrl) => {
      const result = await localResolver().resolveFormatSchema({
        uri: `${baseUrl}${new URL(setup.request_uri).pathname}`,
        digest: digestForJson(document),
      });

      expectFailure(result, {
        status: 'invalid_schema',
        code: 'ref_sandbox_violation',
      });
    });
  });
});

test('negative compile-budget fixture rejects unsafe regex patterns', async () => {
  const setup = fixtureSetup('negative/09_catastrophic_regex.json', 'fail:budget_exceeded');
  const document = setup.response_body;
  const routePath = new URL(setup.request_uri).pathname;

  await withRoutes({ [routePath]: fixtureRoute('negative/09_catastrophic_regex.json', 'fail:budget_exceeded') }, async (baseUrl) => {
    const result = await localResolver().resolveFormatSchema({
      uri: `${baseUrl}${routePath}`,
      digest: digestForJson(document),
    });

    expectFailure(result, {
      status: 'invalid_schema',
      code: 'budget_exceeded',
    });
  });
});

test('negative schema-validity fixture rejects non-schema JSON bodies', async () => {
  const document = fixtureResponseBody('negative/10_invalid_schema.json', 'fail:schema_invalid');

  const routePath = fixtureRoutePath('negative/10_invalid_schema.json');
  await withRoutes({ [routePath]: fixtureRoute('negative/10_invalid_schema.json', 'fail:schema_invalid') }, async (baseUrl) => {
    const result = await localResolver().resolveFormatSchema({
      uri: `${baseUrl}${routePath}`,
      digest: digestForJson(document),
    });

    expectFailure(result, {
      status: 'invalid_schema',
      code: 'unsupported_schema_draft',
    });
  });
});

test('negative graceful-degradation fixture reports uncached 404 as unresolved', async () => {
  const setup = fixtureSetup('negative/11_persistent_404.json', 'fail:transport');
  assertFixtureField(setup.cache_state, 'no_prior_fetch', 'negative/11 cache_state');
  assertFixtureField(setup.response_status, 404, 'negative/11 response_status');

  await withRoutes({ [new URL(setup.request_uri).pathname]: textRoute('missing', 404) }, async (baseUrl) => {
    const result = await localResolver().resolveFormatSchema({
      uri: `${baseUrl}${new URL(setup.request_uri).pathname}`,
      digest: ZERO_DIGEST,
    });

    expectFailure(result, {
      status: 'unresolvable',
      code: 'http_error',
      httpStatus: 404,
    });
  });
});
