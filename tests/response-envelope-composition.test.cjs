#!/usr/bin/env node
/**
 * Every task response and async status payload composes the protocol
 * envelope, and no response root or status branch is closed.
 *
 * On MCP and REST, envelope fields (`status`, `task_id`, `context`,
 * `replayed`, `adcp_version`, ...) are siblings of body fields at the
 * response root. Response schemas compose `core/protocol-envelope.json`
 * through their root `allOf`, and the envelope declares those fields. A
 * draft-07 `additionalProperties: false` does not see `allOf`, so a closed
 * response root or branch would reject every envelope field: response roots
 * and status branches stay open (DR-0019).
 *
 * Single-fault vectors. Every response node (roots and every inline
 * `allOf`/`anyOf`/`oneOf` member, and the documents those members name) is
 * compiled on its own by JSON Pointer, so every branch is evaluated, not only
 * the one a discriminator selects. For each envelope property the control
 * instance omits the property and the vector adds it, so a vector can only
 * fail on the one property it adds; the vector must add no error. A vector
 * is also shown to raise exactly one error against a closed node.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { discoverTools } = require('../scripts/build-schemas.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const PROTOCOL_ENVELOPE_REF = '/schemas/core/protocol-envelope.json';
const VERSION_ENVELOPE_REF = '/schemas/core/version-envelope.json';
const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
const ENVELOPE_DOCUMENTS = new Set(['core/protocol-envelope.json', 'core/version-envelope.json']);
const CONTEXT_REF = '/schemas/core/context.json';

// One valid value per envelope wire property. A property added to the
// envelope fails the value-table test below until it gets a value here.
const ENVELOPE_VALUES = {
  context_id: 'ctx_envelope_0001',
  context: { trace_id: 'trace-0001' },
  task_id: 'task_envelope_0001',
  status: 'completed',
  message: 'Task completed.',
  timestamp: '2026-10-28T12:00:00Z',
  replayed: true,
  adcp_error: { code: 'INVALID_REQUEST', message: 'The request is invalid.' },
  push_notification_config: { url: 'https://buyer.example.com/webhooks/adcp' },
  // Opaque printable ASCII; the schema does not parse the compact JWS.
  governance_context: 'governance-header.governance-payload.governance-signature',
  adcp_version: '3.3',
  adcp_major_version: 3,
};

const COMPACT_TASK_DOCUMENTS = fs.readdirSync(path.join(SOURCE_DIR, 'core'))
  .filter((file) => /^compact-task-.*\.json$/.test(file))
  .map((file) => `core/${file}`)
  .sort();

function readSource(rel) {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, rel), 'utf8'));
}

/** The source-relative path a whole-document `/schemas/` `$ref` names, or null. */
function documentOf(ref) {
  if (typeof ref !== 'string' || ref.includes('#') || !ref.startsWith('/schemas/')) return null;
  return ref.slice('/schemas/'.length);
}

/**
 * The envelope wire properties, in declaration order: the protocol
 * envelope's own properties, then those of each schema it composes through
 * its root `allOf`. `payload` is a documentary grouping of the body fields
 * that is never serialized, so it is left out.
 */
function envelopeWireProperties() {
  const properties = [];
  const seen = new Set();
  (function collect(ref) {
    const schema = readSource(documentOf(ref));
    for (const name of Object.keys(schema.properties || {})) {
      if (name === 'payload' || seen.has(name)) continue;
      seen.add(name);
      properties.push({ name, ref: `${ref}#/properties/${name}` });
    }
    for (const member of schema.allOf || []) if (typeof member?.$ref === 'string') collect(member.$ref);
  })(PROTOCOL_ENVELOPE_REF);
  return properties;
}

function responseSchemas() {
  const out = [];
  for (const tool of discoverTools(SOURCE_DIR)) {
    out.push({ tool: tool.name, rel: tool.response_schema });
    for (const rel of tool.async_response_schemas) out.push({ tool: tool.name, rel });
  }
  return out;
}

/**
 * True when the document composes the protocol envelope through its root
 * `allOf`: directly, or through a root `allOf` member that is itself a
 * document composing it.
 */
function composesEnvelopeThroughRootAllOf(rel, seen = new Set()) {
  if (seen.has(rel)) return false;
  seen.add(rel);
  for (const member of readSource(rel).allOf || []) {
    if (!member || typeof member.$ref !== 'string') continue;
    if (member.$ref === PROTOCOL_ENVELOPE_REF) return true;
    const target = documentOf(member.$ref);
    if (target && composesEnvelopeThroughRootAllOf(target, seen)) return true;
  }
  return false;
}

/**
 * Every response node: the roots, inline `allOf`/`anyOf`/`oneOf` members at
 * any depth, and the documents those members name by whole-document `$ref`.
 */
function responseNodes(rels) {
  const nodes = new Map();
  const visitedDocuments = new Set();
  function visitDocument(rel) {
    if (visitedDocuments.has(rel) || ENVELOPE_DOCUMENTS.has(rel)) return;
    visitedDocuments.add(rel);
    visit(rel, readSource(rel), '');
  }
  function visit(rel, node, pointer) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const target = documentOf(node.$ref);
    if (target) visitDocument(target);
    nodes.set(`${rel}#${pointer}`, { rel, pointer, node });
    for (const keyword of COMPOSITION_KEYWORDS) {
      (node[keyword] || []).forEach((member, index) => visit(rel, member, `${pointer}/${keyword}/${index}`));
    }
  }
  rels.forEach(visitDocument);
  return [...nodes.values()].sort((a, b) => `${a.rel}#${a.pointer}`.localeCompare(`${b.rel}#${b.pointer}`));
}

/** Why a local declaration of an envelope field is allowed, or null. */
function allowedDeclaration(name, declaration) {
  if (!declaration || typeof declaration !== 'object') return null;
  if (name === 'status' && (Object.prototype.hasOwnProperty.call(declaration, 'const') || Array.isArray(declaration.enum))) {
    return 'status discriminator';
  }
  if (name === 'context' && declaration.$ref === CONTEXT_REF && Object.keys(declaration).length === 1) {
    return 'context mirror';
  }
  // A fixed value, such as the message of an unavailable reporting lookup.
  // replayed reports how this response was produced, so it is never pinned.
  if (name !== 'replayed' && JSON.stringify(declaration).includes('"const"')) return 'const pin';
  return null;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  loadSchema: async (uri) => {
    const rel = documentOf(uri.split('#', 1)[0]);
    if (!rel) throw new Error(`unexpected schema URI ${uri}`);
    return readSource(rel);
  },
});
addFormats(ajv);

const validators = new Map();
async function validatorFor(ref) {
  if (!validators.has(ref)) validators.set(ref, await ajv.compileAsync({ $ref: ref }));
  return validators.get(ref);
}

/**
 * The node on its own: its keywords without its `allOf`/`anyOf`/`oneOf`
 * members, with local `#/...` refs made absolute against the document. Each
 * member is a node of its own and gets its own vectors.
 */
function ownSchema(node, rel) {
  const own = structuredClone(node);
  for (const keyword of [...COMPOSITION_KEYWORDS, 'discriminator', '$id', '$schema']) delete own[keyword];
  (function absolutize(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#')) value.$ref = `/schemas/${rel}${value.$ref}`;
    Object.values(value).forEach(absolutize);
  })(own);
  return own;
}

function errorKey(error) {
  return `${error.instancePath}|${error.schemaPath}|${error.keyword}|${JSON.stringify(error.params)}`;
}

/** Errors the vector raises that the control does not. */
function addedErrors(validate, control, vector) {
  validate(control);
  const controlKeys = new Set((validate.errors || []).map(errorKey));
  validate(vector);
  return (validate.errors || []).filter((error) => !controlKeys.has(errorKey(error)));
}

/**
 * True when the node itself forbids the property: `not: {required: [name]}`,
 * or a `not` of `anyOf`/`oneOf` with a bare `{required: [name]}` member. A
 * branch excludes an envelope field to discriminate itself, as a completed
 * branch excludes `task_id` and a success branch excludes `adcp_error`.
 */
function excludes(node, name) {
  const forbidden = node.not;
  if (!forbidden || typeof forbidden !== 'object') return false;
  const bare = (schema) => Array.isArray(schema?.required) && schema.required.includes(name)
    && Object.keys(schema).every((key) => key === 'required');
  if (bare(forbidden)) return true;
  return ['anyOf', 'oneOf'].some((keyword) => (forbidden[keyword] || []).some(bare));
}

/** Fit a value to a local discriminator or pin (`const`, or `enum`). */
function fitValue(value, declaration) {
  if (!declaration || typeof declaration !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(declaration, 'const')) return declaration.const;
  if (Array.isArray(declaration.enum)) return declaration.enum.includes(value) ? value : declaration.enum[0];
  if (value && typeof value === 'object' && !Array.isArray(value) && declaration.properties) {
    const fitted = { ...value };
    for (const [name, sub] of Object.entries(declaration.properties)) {
      if (Object.prototype.hasOwnProperty.call(fitted, name)) fitted[name] = fitValue(fitted[name], sub);
    }
    return fitted;
  }
  return value;
}

const ENVELOPE_PROPERTIES = envelopeWireProperties();
const ENVELOPE_NAMES = new Set(ENVELOPE_PROPERTIES.map(({ name }) => name));
const RESPONSES = responseSchemas();
const RESPONSE_NODES = responseNodes(RESPONSES.map(({ rel }) => rel));

test('every tool response and async status schema composes protocol-envelope through its root allOf', () => {
  assert.ok(RESPONSES.length > 0, 'discoverTools found no response schemas');
  const missing = RESPONSES
    .filter(({ rel }) => !composesEnvelopeThroughRootAllOf(rel))
    .map(({ tool, rel }) => `${tool}: ${rel}`);
  assert.deepEqual(missing, [], `Response schemas must list ${PROTOCOL_ENVELOPE_REF} in their root allOf`);
});

test('response schemas get the version envelope through the protocol envelope only', () => {
  const direct = RESPONSES
    .filter(({ rel }) => (readSource(rel).allOf || []).some((m) => m && m.$ref === VERSION_ENVELOPE_REF))
    .map(({ rel }) => rel);
  assert.deepEqual(direct, []);
  assert.ok(
    ENVELOPE_NAMES.has('adcp_version') && ENVELOPE_NAMES.has('adcp_major_version'),
    'protocol-envelope must compose core/version-envelope.json',
  );
});

test('every envelope wire property has a value that its envelope declaration accepts', async () => {
  assert.deepEqual(
    [...ENVELOPE_NAMES].filter((name) => !(name in ENVELOPE_VALUES)),
    [],
    'add a valid value for each new envelope property to ENVELOPE_VALUES',
  );
  for (const { name, ref } of ENVELOPE_PROPERTIES) {
    const validate = await validatorFor(ref);
    assert.equal(validate(ENVELOPE_VALUES[name]), true,
      `${name} value rejected by ${ref}: ${JSON.stringify(validate.errors)}`);
  }
});

test('response nodes reach every compact task payload', () => {
  assert.ok(COMPACT_TASK_DOCUMENTS.length > 0, 'found no core/compact-task-*.json; the test would be vacuous');
  const documents = new Set(RESPONSE_NODES.map(({ rel }) => rel));
  for (const rel of COMPACT_TASK_DOCUMENTS) assert.ok(documents.has(rel), `${rel} is not reachable from a tool response`);
});

test('no response root or status branch is closed', () => {
  const closed = RESPONSE_NODES
    .filter(({ node }) => node.additionalProperties === false)
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(closed, [], 'response roots and status branches stay open (DR-0019); a closed node rejects envelope fields');
});

test('a vector fails a closed node on exactly one error', async () => {
  const defects = [
    { name: 'task_id', value: ENVELOPE_VALUES.task_id, schema: { type: 'object', additionalProperties: false }, keyword: 'additionalProperties', instancePath: '' },
  ];
  for (const { name, value, schema, keyword, instancePath } of defects) {
    const validate = await ajv.compileAsync(schema);
    assert.deepEqual(
      addedErrors(validate, {}, { [name]: value }).map((error) => ({ instancePath: error.instancePath, keyword: error.keyword })),
      [{ instancePath, keyword }],
      name,
    );
  }
});

test('every response root and branch accepts every envelope property, single-fault vectors', async (t) => {
  // A member that is only a `$ref` names a document, which is a node of its own.
  const ownNodes = RESPONSE_NODES.filter(({ node }) => !(typeof node.$ref === 'string' && Object.keys(node).length === 1));
  assert.ok(ownNodes.length > RESPONSES.length, 'expected the roots and their branches');
  for (const { rel, pointer, node } of ownNodes) {
    await t.test(`${rel}#${pointer}`, async () => {
      const validate = await ajv.compileAsync(ownSchema(node, rel));
      for (const { name } of ENVELOPE_PROPERTIES) {
        if (excludes(node, name)) continue;
        // A value is fitted to a status discriminator or a deliberate pin.
        const local = node.properties?.[name];
        const value = allowedDeclaration(name, local) ? fitValue(ENVELOPE_VALUES[name], local) : ENVELOPE_VALUES[name];
        assert.deepEqual(addedErrors(validate, {}, { [name]: value }), [],
          `${rel}#${pointer} rejects envelope ${name} ${JSON.stringify(value).slice(0, 40)}`);
      }
    });
  }
});

