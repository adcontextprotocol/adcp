'use strict';

/**
 * Every task response accepts the `adcp_version` echo (#8518).
 *
 * versioning.mdx requires a seller to echo `adcp_version` on every response,
 * requires the response to validate against the served release's schema, and
 * keeps the echo's shape stable across the major. A response schema that does
 * not declare the echo either rejects it (closed) or leaves it untyped (open),
 * so a conforming seller cannot satisfy both rules at once.
 *
 * The task set comes from the tool registry (`discoverTools`, the same source
 * as the published manifest): each tool's response schema plus its
 * `*-async-response-*` status payloads. A new task is covered automatically.
 *
 * For each schema this asserts that:
 *   1. a release-precision echo never trips `additionalProperties: false`;
 *   2. the echo is declared, not merely tolerated: a full-semver value fails
 *      the envelope's release-precision pattern;
 *   3. every declaration is exactly a `$ref` to
 *      core/version-envelope.json#/properties/adcp_version, or the envelope
 *      itself composed via `allOf`, so the shape is identical everywhere.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { discoverTools } = require('../scripts/build-schemas.cjs');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ENVELOPE_REF = '/schemas/core/version-envelope.json';
const ECHO_REF = `${ENVELOPE_REF}#/properties/adcp_version`;

function readSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, uri.slice('/schemas/'.length)), 'utf8'));
}

function taskResponseSchemas() {
  const uris = new Set();
  for (const tool of discoverTools(SOURCE_DIR)) {
    uris.add(`/schemas/${tool.response_schema}`);
    for (const variant of tool.async_response_schemas) uris.add(`/schemas/${variant}`);
  }
  return [...uris].sort();
}

// Walk the root-level object composition of a response (root, allOf/anyOf/
// oneOf/if-then-else arms, and $refs between them) without descending into
// property values, and collect every local `adcp_version` declaration.
function echoDeclarations(uri) {
  const found = [];
  const visited = new Set();
  const visit = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const [file, pointer] = node.$ref.split('#');
      if (file === ENVELOPE_REF && !pointer) {
        found.push({ where, declaration: 'envelope' });
        return;
      }
      if (file && !visited.has(file)) {
        visited.add(file);
        visit(readSchema(file), file);
      }
    }
    if (node.properties && Object.hasOwn(node.properties, 'adcp_version')) {
      found.push({ where, declaration: node.properties.adcp_version });
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      (node[keyword] || []).forEach((arm, index) => visit(arm, `${where}/${keyword}/${index}`));
    }
    for (const keyword of ['then', 'else']) visit(node[keyword], `${where}/${keyword}`);
  };
  visited.add(uri);
  visit(readSchema(uri), uri);
  return found;
}

const SCHEMAS = taskResponseSchemas();

test('the tool registry yields the task responses this guard is meant to cover', () => {
  assert.ok(SCHEMAS.length > 100, `expected the full task response set, saw ${SCHEMAS.length}`);
  for (const uri of [
    '/schemas/media-buy/list-products-response.json',
    '/schemas/media-buy/control-media-buy-response.json',
    '/schemas/media-buy/decline-proposals-response.json',
    '/schemas/media-buy/buy-products-response.json',
    '/schemas/media-buy/accept-proposal-response.json',
    '/schemas/media-buy/buy-products-async-response-submitted.json',
    '/schemas/media-buy/create-media-buy-async-response-working.json',
  ]) {
    assert.ok(SCHEMAS.includes(uri), `${uri} missing from the registry-derived set`);
  }
});

test('every task response accepts and declares the release-precision adcp_version echo', async () => {
  // No discriminator option: every oneOf arm is evaluated, so a closed arm
  // that rejects the echo is reported even when another arm would accept it.
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (uri) => readSchema(uri) });
  addFormats(ajv);
  const rejecting = [];
  const undeclared = [];
  for (const uri of SCHEMAS) {
    const validate = ajv.getSchema(uri) || await ajv.compileAsync(readSchema(uri));
    validate({ adcp_version: '3.3' });
    if ((validate.errors || []).some((error) => (
      error.keyword === 'additionalProperties' && error.params.additionalProperty === 'adcp_version'
    ))) {
      rejecting.push(uri);
    }
    validate({ adcp_version: '3.3.0' });
    if (!(validate.errors || []).some((error) => error.instancePath === '/adcp_version')) {
      undeclared.push(uri);
    }
  }
  assert.deepEqual(rejecting, [], 'closed response schemas reject the adcp_version echo');
  assert.deepEqual(undeclared, [], 'response schemas tolerate adcp_version without declaring its release-precision shape');
});

test('every adcp_version echo declaration has the envelope shape', () => {
  const drift = [];
  for (const uri of SCHEMAS) {
    const declarations = echoDeclarations(uri);
    assert.ok(declarations.length > 0, `${uri} declares no adcp_version echo`);
    for (const { where, declaration } of declarations) {
      if (declaration === 'envelope') continue;
      try {
        assert.deepEqual(declaration, { $ref: ECHO_REF });
      } catch {
        drift.push(`${where}: ${JSON.stringify(declaration)}`);
      }
    }
  }
  assert.deepEqual([...new Set(drift)], [], `adcp_version must be { "$ref": "${ECHO_REF}" }`);
});

test('compact purchase responses accept the echo on every arm (#8518 symptom)', async () => {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => readSchema(uri),
  });
  addFormats(ajv);
  const compile = async (tool) => ajv.compileAsync(readSchema(`/schemas/media-buy/${tool}-response.json`));
  const failed = { status: 'failed', errors: [{ code: 'INVALID_REQUEST', message: 'Rejected' }] };
  const submitted = { status: 'submitted', task_id: 'task-1' };
  const cases = {
    'list-products': [
      { outcome: 'listed', products: [], feed_version: 'feed-1', cache_scope: 'public' },
      { outcome: 'unchanged', feed_version: 'feed-1', cache_scope: 'public' },
    ],
    'control-media-buy': [
      { status: 'completed', media_buy_id: 'media-buy-1', revision: 2 },
      failed,
      submitted,
    ],
    'decline-proposals': [
      { results: [{ proposal_id: 'proposal-1', outcome: 'declined' }] },
      submitted,
    ],
    'buy-products': [failed, submitted],
    'accept-proposal': [failed, submitted],
  };
  for (const [tool, responses] of Object.entries(cases)) {
    const validate = await compile(tool);
    for (const response of responses) {
      assert.equal(validate(response), true, `${tool} baseline: ${JSON.stringify(validate.errors)}`);
      assert.equal(validate({ ...response, adcp_version: '3.3' }), true,
        `${tool} rejected the echo: ${JSON.stringify(validate.errors)}`);
      assert.equal(validate({ ...response, adcp_version: '3.3.0' }), false,
        `${tool} accepted a patch-precision echo`);
    }
  }
});
