#!/usr/bin/env node
/**
 * Every task response and async status payload composes the protocol
 * envelope, and the published schemas accept every envelope field on every
 * closed root and branch.
 *
 * On MCP and REST, envelope fields (`status`, `task_id`, `context`,
 * `replayed`, `adcp_version`, ...) are siblings of body fields at the
 * response root. Source response schemas compose
 * `core/protocol-envelope.json` through their root `allOf`, and the schema
 * build (scripts/compose-response-envelope.cjs) declares each envelope
 * property on every closed root and closed `oneOf`/`anyOf` branch, because a
 * draft-07 `additionalProperties: false` does not see `allOf`.
 *
 * Single-fault vectors. Each closed node is compiled on its own by JSON
 * Pointer, so every `oneOf`/`anyOf` branch is evaluated, with its body-field
 * declarations reduced to `{}`: the vectors grade how the node treats
 * envelope fields, not body-field contents. The control carries the node's
 * required fields and passes the built node. Each vector differs from it by
 * one envelope field:
 *   - an addition vector (a field the control lacks): the built node accepts
 *     it, and the source node adds exactly one error, `additionalProperties`
 *     on that field, unless the source declares the field itself;
 *   - a removal vector (a required field, such as a branch's `status` or
 *     `task_id`): the built node adds exactly one error, `required` on that
 *     field, and the source node loses exactly the `additionalProperties`
 *     error the field raised there, unless the source declares it.
 * Edge values (`replayed: false`, a 2,500-character `message`) run as
 * further addition vectors on every closed node, and on every response node
 * against the built schema.
 *
 * Requires the built tree: run `npm run build:schemas` first (the npm script
 * does). Requires Node 24, as package.json does.
 */

'use strict';

// package.json requires Node 24. Node 22's runner stops scheduling the
// subtests below after the first few and still reports a pass, so refuse to
// run there rather than pass on a partial run.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 24) {
  throw new Error(`tests/response-envelope-composition.test.cjs needs Node 24 or later (package.json engines); this is ${process.version}`);
}

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { discoverTools, canonicalizePublishedSchemaUris } = require('../scripts/build-schemas.cjs');
const {
  PROTOCOL_ENVELOPE_REF,
  envelopeWireProperties,
} = require('../scripts/compose-response-envelope.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const BUILT_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const BUILT_ORIGIN = 'https://adcontextprotocol.org/schemas/latest/';
const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
const ENVELOPE_DOCUMENTS = new Set(['core/protocol-envelope.json', 'core/version-envelope.json']);

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

// Values at the edge of an envelope declaration that a response node must
// not narrow away. The envelope's `replayed` is a boolean that defaults to
// false, so a seller that always sends `replayed: false` conforms. The
// envelope's `message` has no bound in 3.x (`x-max-length-4.0` is 1024 from
// 4.0), so a 2,500-character message conforms; response nodes used to cap
// it at 2,000.
const BOUNDARY_VALUES = {
  replayed: false,
  message: 'm'.repeat(2500),
};
const COMPACT_TASK_DOCUMENTS = fs.readdirSync(path.join(SOURCE_DIR, 'core'))
  .filter((file) => /^compact-task-.*\.json$/.test(file))
  .map((file) => `core/${file}`)
  .sort();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readSource(rel) {
  return readJson(path.join(SOURCE_DIR, rel));
}

function readBuilt(rel) {
  return readJson(path.join(BUILT_DIR, rel));
}

/** The source-relative path a whole-document `$ref` names, or null. */
function documentOf(ref) {
  if (typeof ref !== 'string' || ref.includes('#')) return null;
  if (ref.startsWith('/schemas/')) return ref.slice('/schemas/'.length);
  if (ref.startsWith(BUILT_ORIGIN)) return ref.slice(BUILT_ORIGIN.length);
  return null;
}

function pointerGet(root, pointer) {
  if (!pointer) return root;
  return pointer.slice(1).split('/').reduce((node, segment) => node?.[segment], root);
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
 * True when the source document composes the protocol envelope through its
 * root `allOf`: directly, or through a root `allOf` member that is itself a
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
 * Every closed schema object reachable from the response documents in the
 * built tree: roots, inline `allOf`/`anyOf`/`oneOf` members at any depth,
 * and the documents those members name by whole-document `$ref`.
 */
function closedNodes(rels) {
  const nodes = new Map();
  const visitedDocuments = new Set();
  function visitDocument(rel) {
    if (visitedDocuments.has(rel) || ENVELOPE_DOCUMENTS.has(rel)) return;
    visitedDocuments.add(rel);
    visit(rel, readBuilt(rel), '');
  }
  function visit(rel, node, pointer) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const target = documentOf(node.$ref);
    if (target) visitDocument(target);
    if (node.additionalProperties === false) nodes.set(`${rel}#${pointer}`, { rel, pointer });
    for (const keyword of COMPOSITION_KEYWORDS) {
      (node[keyword] || []).forEach((member, index) => visit(rel, member, `${pointer}/${keyword}/${index}`));
    }
  }
  rels.forEach(visitDocument);
  return [...nodes.values()].sort((a, b) => `${a.rel}#${a.pointer}`.localeCompare(`${b.rel}#${b.pointer}`));
}

function createAjv(loadSchema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv;
}

const builtAjv = createAjv(async (uri) => {
  if (!uri.startsWith(BUILT_ORIGIN)) throw new Error(`unexpected schema URI ${uri}`);
  return readBuilt(uri.slice(BUILT_ORIGIN.length));
});
const sourceAjv = createAjv(async (uri) => {
  if (!uri.startsWith('/schemas/')) throw new Error(`unexpected schema URI ${uri}`);
  return readSource(uri.slice('/schemas/'.length));
});

const validators = new Map();
async function validatorFor(ajv, ref) {
  const key = `${ajv === builtAjv ? 'built' : 'source'} ${ref}`;
  if (!validators.has(key)) validators.set(key, await ajv.compileAsync({ $ref: ref }));
  return validators.get(key);
}

/**
 * The closed node on its own: its keywords without its `allOf`/`anyOf`/
 * `oneOf` members, with local `#/...` refs made absolute against the
 * document. The members are evaluated separately: a closed member is a
 * closed node of its own and gets its own vectors, and an open member's
 * other constraints (for example a completed branch's
 * `not: {required: ["task_id"]}`) are deliberate narrowing, not closedness.
 */
function ownSchema(document, pointer, documentId) {
  const own = structuredClone(pointerGet(document, pointer));
  for (const keyword of [...COMPOSITION_KEYWORDS, 'discriminator', '$id', '$schema']) delete own[keyword];
  (function absolutize(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) node.$ref = `${documentId}${node.$ref}`;
    Object.values(node).forEach(absolutize);
  })(own);
  return own;
}

/**
 * The closed node's own keywords with every body-field declaration replaced
 * by `{}`. The vectors grade how the node treats envelope fields: its
 * closedness, its required list and its envelope-field declarations. Body
 * fields keep their names, so `additionalProperties` still sees them, but not
 * their nested constraints, which are not under test here.
 */
async function envelopeValidatorFor(ajv, document, pointer, documentId) {
  const key = `${ajv === builtAjv ? 'built' : 'source'} envelope ${documentId}#${pointer}`;
  if (!validators.has(key)) {
    const own = ownSchema(document, pointer, documentId);
    const envelopeNames = new Set(ENVELOPE_PROPERTIES.map(({ name }) => name));
    for (const name of Object.keys(own.properties || {})) {
      if (!envelopeNames.has(name)) own.properties[name] = {};
    }
    validators.set(key, await ajv.compileAsync(own));
  }
  return validators.get(key);
}

async function ownValidatorFor(ajv, document, pointer, documentId) {
  const key = `${ajv === builtAjv ? 'built' : 'source'} own ${documentId}#${pointer}`;
  if (!validators.has(key)) validators.set(key, await ajv.compileAsync(ownSchema(document, pointer, documentId)));
  return validators.get(key);
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
 * Fit the envelope value to a local declaration that narrows the field, such
 * as a `status` const on a compact branch or a const `adcp_error.code`.
 */
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

const ENVELOPE_PROPERTIES = envelopeWireProperties(SOURCE_DIR);
const RESPONSES = responseSchemas();
const CLOSED_NODES = closedNodes(RESPONSES.map(({ rel }) => rel));

/**
 * Every object node of the response documents where envelope fields sit:
 * roots, inline `allOf`/`anyOf`/`oneOf` members at any depth, and the
 * documents those members name by whole-document `$ref`, open or closed.
 * Nested body objects are not envelope positions and are not visited.
 */
function responseNodes(rels) {
  const nodes = [];
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
    if (node.properties && typeof node.properties === 'object') nodes.push({ rel, pointer, node });
    for (const keyword of COMPOSITION_KEYWORDS) {
      (node[keyword] || []).forEach((member, index) => visit(rel, member, `${pointer}/${keyword}/${index}`));
    }
  }
  rels.forEach(visitDocument);
  return nodes;
}
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
    .filter(({ rel }) => (readSource(rel).allOf || []).some((m) => m && m.$ref === '/schemas/core/version-envelope.json'))
    .map(({ rel }) => rel);
  assert.deepEqual(direct, []);
  assert.ok(
    ENVELOPE_PROPERTIES.some(({ name }) => name === 'adcp_version')
      && ENVELOPE_PROPERTIES.some(({ name }) => name === 'adcp_major_version'),
    'protocol-envelope must compose core/version-envelope.json',
  );
});

test('every envelope wire property has a value that its envelope declaration accepts', async () => {
  assert.deepEqual(
    ENVELOPE_PROPERTIES.map(({ name }) => name).filter((name) => !(name in ENVELOPE_VALUES)),
    [],
    'add a valid value for each new envelope property to ENVELOPE_VALUES',
  );
  for (const { name, ref } of ENVELOPE_PROPERTIES) {
    const validate = await validatorFor(sourceAjv, ref);
    assert.equal(validate(ENVELOPE_VALUES[name]), true,
      `${name} value rejected by ${ref}: ${JSON.stringify(validate.errors)}`);
  }
});

/**
 * A local declaration of an envelope field that a response node may keep:
 * - a `status` const or enum, the discriminator of a branch;
 * - `context` as a `$ref` to core/context.json, which mirrors the envelope;
 * - a value pin: a `const`, or an object whose properties pin values with
 *   `const` (the fixed message and error of an unavailable reporting lookup).
 * Anything else restates the envelope, so the envelope's declaration governs.
 */
function permittedLocalDeclaration(name, declaration) {
  if (!declaration || typeof declaration !== 'object') return false;
  const has = (node, key) => Object.prototype.hasOwnProperty.call(node, key);
  if (name === 'status') return has(declaration, 'const') || Array.isArray(declaration.enum);
  if (name === 'context') return declaration.$ref === '/schemas/core/context.json';
  if (has(declaration, 'const')) return true;
  return Object.values(declaration.properties || {}).some((member) => member && has(member, 'const'));
}

test('response nodes declare only body fields and narrowing constraints', () => {
  const copied = [];
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    for (const { name } of ENVELOPE_PROPERTIES) {
      const declaration = node.properties[name];
      if (declaration && !permittedLocalDeclaration(name, declaration)) {
        copied.push(`${rel}#${pointer}/properties/${name}`);
      }
    }
  }
  assert.deepEqual(copied, [], 'the envelope declares these fields; remove the local redeclarations');
});

test('no response node narrows message length or pins replayed', () => {
  // The envelope defines message once, with no bound in 3.x, and replayed as
  // a boolean that reports how the response was produced. A response node
  // may pin message to fixed text with const (the unavailable reporting
  // lookup does), but no bound or replayed value of its own.
  const LENGTH_KEYWORDS = ['maxLength', 'minLength', 'pattern'];
  const narrowed = [];
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    const { message, replayed } = node.properties;
    if (message && !Object.prototype.hasOwnProperty.call(message, 'const')
      && LENGTH_KEYWORDS.some((keyword) => Object.prototype.hasOwnProperty.call(message, keyword))) {
      narrowed.push(`${rel}#${pointer}/properties/message`);
    }
    if (replayed && (Object.prototype.hasOwnProperty.call(replayed, 'const') || Array.isArray(replayed.enum))) {
      narrowed.push(`${rel}#${pointer}/properties/replayed`);
    }
  }
  assert.deepEqual(narrowed, []);
});

test('the build keeps every local declaration that narrows an envelope field', () => {
  assert.ok(CLOSED_NODES.length > 0, 'found no closed response nodes; the test would be vacuous');
  for (const { rel, pointer } of CLOSED_NODES) {
    const source = pointerGet(readSource(rel), pointer);
    const built = pointerGet(readBuilt(rel), pointer);
    for (const { name } of ENVELOPE_PROPERTIES) {
      if (!source.properties || !Object.prototype.hasOwnProperty.call(source.properties, name)) continue;
      const expected = canonicalizePublishedSchemaUris(structuredClone(source.properties[name]), 'latest');
      assert.deepEqual(built.properties[name], expected, `${rel}#${pointer}: local ${name} declaration changed`);
    }
  }
});

function errorShape({ instancePath, keyword, params }) {
  return { instancePath, keyword, params };
}

test('built closed roots and branches accept every envelope property, single-fault vectors', async (t) => {
  let vectorCount = 0;
  for (const { rel, pointer } of CLOSED_NODES) {
    await t.test(`${rel}#${pointer}`, async () => {
      const sourceDocument = readSource(rel);
      const sourceNode = pointerGet(sourceDocument, pointer);
      const builtDocument = readBuilt(rel);
      const builtValidate = await envelopeValidatorFor(builtAjv, builtDocument, pointer, `${BUILT_ORIGIN}${rel}`);
      const sourceValidate = await envelopeValidatorFor(sourceAjv, sourceDocument, pointer, `/schemas/${rel}`);

      // The control: the node's required fields, envelope fields with values
      // their declarations accept, so it passes the built node and each
      // vector differs from it by one field.
      const builtNode = pointerGet(builtDocument, pointer);
      const control = {};
      for (const name of builtNode.required || []) {
        control[name] = name in ENVELOPE_VALUES ? fitValue(ENVELOPE_VALUES[name], sourceNode.properties?.[name]) : 'x';
      }
      assert.equal(builtValidate(control), true,
        `control does not pass built ${rel}#${pointer}: ${JSON.stringify(builtValidate.errors)} ${JSON.stringify(control)}`);

      const cases = [
        ...ENVELOPE_PROPERTIES.map(({ name, ref }) => ({ name, ref, value: ENVELOPE_VALUES[name], fit: true })),
        // Edge values honour only a local const, the deliberate pin of a
        // branch (the fixed message of an unavailable reporting lookup). A
        // bound below the envelope's is the defect these vectors catch.
        ...ENVELOPE_PROPERTIES
          .filter(({ name }) => name in BOUNDARY_VALUES)
          .map(({ name, ref }) => ({ name, ref, value: BOUNDARY_VALUES[name], fit: false })),
      ];
      for (const { name, ref, value: envelopeValue, fit } of cases) {
        const localDeclaration = sourceNode.properties?.[name];
        const additional = [{ instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: name } }];

        if (Object.prototype.hasOwnProperty.call(control, name)) {
          // A required envelope field: the removal vector drops it. Built,
          // it adds exactly the missing-required error. Source, it removes
          // the closed node's additionalProperties error for that field
          // unless the node declares the field itself.
          const { [name]: _removed, ...vector } = control;
          assert.deepEqual(addedErrors(builtValidate, control, vector).map(errorShape),
            [{ instancePath: '', keyword: 'required', params: { missingProperty: name } }],
            `built ${rel}#${pointer}: removing ${name} must fail only on required`);
          assert.deepEqual(addedErrors(sourceValidate, vector, control).map(errorShape),
            localDeclaration ? [] : additional,
            `source ${rel}#${pointer}: removing ${name} must remove exactly its additionalProperties error`);
          vectorCount += 1;
          continue;
        }

        const pinned = localDeclaration && Object.prototype.hasOwnProperty.call(localDeclaration, 'const');
        const value = fit || pinned ? fitValue(envelopeValue, localDeclaration) : envelopeValue;
        const envelopeValidate = await validatorFor(sourceAjv, ref);
        assert.equal(envelopeValidate(value), true, `${name}: vector value is not valid against ${ref}`);
        const vector = { ...control, [name]: value };
        assert.equal(builtValidate(vector), true,
          `built ${rel}#${pointer} rejects envelope property ${name}: ${JSON.stringify(builtValidate.errors)}`);
        assert.deepEqual(addedErrors(sourceValidate, control, vector).map(errorShape),
          localDeclaration ? [] : additional,
          `${name}: the source vector must fail only on the closed node's additionalProperties`);
        vectorCount += 1;
      }
    });
  }
  // A run that skips subtests (as Node 22's runner does here) must not pass.
  assert.equal(vectorCount, CLOSED_NODES.length * (ENVELOPE_PROPERTIES.length + Object.keys(BOUNDARY_VALUES).length),
    'not every single-fault vector ran');
});

test('every response node accepts the envelope edge values, single-fault vectors', async () => {
  const visited = new Set(RESPONSE_NODES.map(({ rel }) => rel));
  assert.deepEqual(COMPACT_TASK_DOCUMENTS.filter((rel) => !visited.has(rel)), [],
    'the response-node walk must reach the compact task payloads');
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    const builtValidate = await ownValidatorFor(builtAjv, readBuilt(rel), pointer, `${BUILT_ORIGIN}${rel}`);
    for (const { name, ref } of ENVELOPE_PROPERTIES.filter(({ name }) => name in BOUNDARY_VALUES)) {
      const localDeclaration = node.properties[name];
      // A const pin is a deliberate fixed value, so the vector takes it.
      const pinned = localDeclaration && Object.prototype.hasOwnProperty.call(localDeclaration, 'const');
      const value = pinned ? localDeclaration.const : BOUNDARY_VALUES[name];
      const envelopeValidate = await validatorFor(sourceAjv, ref);
      assert.equal(envelopeValidate(value), true, `${name}: edge value is not valid against ${ref}`);
      assert.deepEqual(addedErrors(builtValidate, {}, { [name]: value }), [],
        `${rel}#${pointer} rejects envelope ${name} ${JSON.stringify(value).slice(0, 40)}`);
    }
  }
});
