#!/usr/bin/env node
/**
 * Every task response and async status payload composes the protocol
 * envelope, no response root or status branch is closed, and response
 * schemas declare only body fields.
 *
 * On MCP and REST, envelope fields (`status`, `task_id`, `context`,
 * `replayed`, `adcp_version`, ...) are siblings of body fields at the
 * response root. Response schemas compose `core/protocol-envelope.json`
 * through their root `allOf`, and the envelope declares those fields. A
 * draft-07 `additionalProperties: false` does not see `allOf`, so a closed
 * response root or branch would reject every envelope field: response roots
 * and status branches stay open (DR-0019).
 *
 * A response node may declare an envelope field only to discriminate a
 * branch (`status` with `const` or `enum`), to mirror `context` with the
 * identical `$ref`, or to pin a fixed value with `const` (the fixed message
 * of an unavailable reporting lookup). Any other declaration is an inline
 * copy of the envelope, which drifts from it.
 *
 * Single-fault vectors. Every response node (roots and every inline
 * `allOf`/`anyOf`/`oneOf` member, and the documents those members name) is
 * compiled on its own by JSON Pointer, so every branch is evaluated, not only
 * the one a discriminator selects. For each envelope property the control
 * instance omits the property and the vector adds it, so a vector can only
 * fail on the one property it adds; the vector must add no error. Each
 * vector is also shown to raise exactly one error against the defect it
 * guards against.
 *
 * task_id has one definition, core/task-id.json (a non-empty string). A
 * submitted response requires it through core/task-submitted.json, which
 * every submitted body and branch composes; no schema states the rule as an
 * if/then, which code generators ignore. Rejection vectors: an empty task_id
 * fails on its length only on every response document, and a submitted
 * response without task_id fails on task_id only on every document that has
 * a submitted body or branch.
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
// The envelope documents, and core/task-submitted.json, the definition of the
// submitted acknowledgement that declares status and task_id on purpose.
const ENVELOPE_DOCUMENTS = new Set([
  'core/protocol-envelope.json',
  'core/version-envelope.json',
  'core/task-submitted.json',
  'core/task-working.json',
  'core/task-input-required.json',
]);
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

// Values at the edge of an envelope declaration that a response node must
// not narrow away. The envelope's `replayed` is a boolean that defaults to
// false, so a seller that always sends `replayed: false` conforms. The
// envelope's `message` is core/task-message.json, bounded at 2,000
// characters, so a 2,000-character message conforms on every node and no
// node may bound it lower.
const MESSAGE_MAX = 2000;
const BOUNDARY_VALUES = {
  replayed: false,
  message: 'm'.repeat(MESSAGE_MAX),
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
    if (name in BOUNDARY_VALUES) {
      assert.equal(validate(BOUNDARY_VALUES[name]), true, `${name} edge value rejected by ${ref}`);
    }
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

test('response nodes declare no inline copy of an envelope field', () => {
  const copies = [];
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    for (const [name, declaration] of Object.entries(node.properties || {})) {
      if (!ENVELOPE_NAMES.has(name) || allowedDeclaration(name, declaration)) continue;
      copies.push(`${rel}#${pointer}/properties/${name}`);
    }
  }
  assert.deepEqual(copies, [], 'the protocol envelope declares these fields; remove the inline copy');
});

test('each vector fails the defect it guards against on exactly one error', async () => {
  // A closed node, a replayed pin and a message bound below the envelope's.
  const defects = [
    { name: 'task_id', value: ENVELOPE_VALUES.task_id, schema: { type: 'object', additionalProperties: false }, keyword: 'additionalProperties', instancePath: '' },
    { name: 'replayed', value: BOUNDARY_VALUES.replayed, schema: { type: 'object', properties: { replayed: { type: 'boolean', const: true } } }, keyword: 'const', instancePath: '/replayed' },
    { name: 'message', value: BOUNDARY_VALUES.message, schema: { type: 'object', properties: { message: { type: 'string', maxLength: MESSAGE_MAX - 1 } } }, keyword: 'maxLength', instancePath: '/message' },
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

test('every response root and branch accepts every envelope property and edge value, single-fault vectors', async (t) => {
  // A member that is only a `$ref` names a document, which is a node of its own.
  const ownNodes = RESPONSE_NODES.filter(({ node }) => !(typeof node.$ref === 'string' && Object.keys(node).length === 1));
  assert.ok(ownNodes.length > RESPONSES.length, 'expected the roots and their branches');
  for (const { rel, pointer, node } of ownNodes) {
    await t.test(`${rel}#${pointer}`, async () => {
      const validate = await ajv.compileAsync(ownSchema(node, rel));
      const cases = [
        ...ENVELOPE_PROPERTIES.map(({ name }) => ({ name, value: ENVELOPE_VALUES[name], edge: false })),
        ...Object.entries(BOUNDARY_VALUES).map(([name, value]) => ({ name, value, edge: true })),
      ];
      for (const { name, value: envelopeValue, edge } of cases) {
        if (excludes(node, name)) continue;
        // A value is fitted to a status discriminator or a deliberate pin;
        // an edge value is fitted only to a pin.
        const local = node.properties?.[name];
        const allowed = allowedDeclaration(name, local);
        const fit = allowed && (!edge || allowed === 'const pin');
        const value = fit ? fitValue(envelopeValue, local) : envelopeValue;
        assert.deepEqual(addedErrors(validate, {}, { [name]: value }), [],
          `${rel}#${pointer} rejects envelope ${name} ${JSON.stringify(value).slice(0, 40)}`);
      }
    });
  }
});

const TASK_ID_REF = '/schemas/core/task-id.json';

/** Every `task_id` property declaration in the source tree. */
function taskIdDeclarations() {
  const found = [];
  (function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(file); continue; }
      if (!entry.name.endsWith('.json')) continue;
      const rel = path.relative(SOURCE_DIR, file);
      (function walk(node, pointer) {
        if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${pointer}/${index}`)); return; }
        if (!node || typeof node !== 'object') return;
        const declaration = node.properties && typeof node.properties === 'object' ? node.properties.task_id : undefined;
        if (declaration && typeof declaration === 'object') found.push({ at: `${rel}#${pointer}/properties/task_id`, declaration });
        for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
      })(readSource(rel), '');
    }
  })(SOURCE_DIR);
  return found;
}

test('task_id has one definition, which every task_id declaration refers to', () => {
  const definition = readSource('core/task-id.json');
  assert.equal(definition.type, 'string');
  assert.equal(definition.minLength, 1);
  assert.equal(definition['x-entity'], 'task');
  assert.equal(definition['x-max-length-4.0'], 128);
  const declarations = taskIdDeclarations();
  assert.ok(declarations.some(({ at }) => at === 'core/protocol-envelope.json#/properties/task_id'));
  const local = declarations
    .filter(({ declaration }) => declaration.$ref !== TASK_ID_REF
      && !(declaration.allOf || []).some((member) => member && member.$ref === TASK_ID_REF))
    .map(({ at }) => at);
  assert.deepEqual(local, [], `declare task_id as a $ref to ${TASK_ID_REF}`);
});

const TASK_SUBMITTED_REF = '/schemas/core/task-submitted.json';

function composesTaskSubmitted(node) {
  return (node.allOf || []).some((member) => member && member.$ref === TASK_SUBMITTED_REF);
}

/**
 * Submitted response nodes: the *-submitted.json bodies, the compact
 * submitted payload, every node that keeps a local status const submitted
 * (an OpenAPI discriminator needs it), and every node that composes
 * core/task-submitted.json.
 */
const SUBMITTED_NODES = RESPONSE_NODES.filter(({ rel, pointer, node }) => (
  (pointer === '' && /-submitted\.json$/.test(rel))
  || node.properties?.status?.const === 'submitted'
  || composesTaskSubmitted(node)
));

test('every submitted body and branch composes core/task-submitted.json, which requires task_id', () => {
  const definition = readSource('core/task-submitted.json');
  assert.deepEqual(definition.properties.status, { const: 'submitted' });
  assert.deepEqual(definition.properties.task_id, { $ref: TASK_ID_REF });
  assert.deepEqual(definition.required, ['status', 'task_id']);
  assert.ok(SUBMITTED_NODES.length >= 19, `expected the submitted nodes, found ${SUBMITTED_NODES.length}`);
  const missing = SUBMITTED_NODES
    .filter(({ rel, pointer, node }) => !composesTaskSubmitted(node)
      // A submitted body that composes a document which composes it, such as
      // an async payload built on core/compact-task-submitted.json.
      && !(node.allOf || []).some((member) => member && typeof member.$ref === 'string'
        && member.$ref !== PROTOCOL_ENVELOPE_REF && composesTaskSubmitted(readSource(documentOf(member.$ref)) || {})))
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(missing, [], `submitted bodies and branches compose ${TASK_SUBMITTED_REF}`);
  const restated = SUBMITTED_NODES
    .filter(({ node }) => (node.required || []).includes('task_id'))
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(restated, [], 'core/task-submitted.json requires task_id; no submitted node restates it');
});

const STATUS_SCHEMAS = {
  working: '/schemas/core/task-working.json',
  'input-required': '/schemas/core/task-input-required.json',
};

/** The status a body or branch describes, from its file name or its local status const. */
function bodyStatus(rel, pointer, node) {
  if (pointer === '') {
    const match = rel.match(/-(working|input-required)\.json$/);
    if (match) return match[1];
  }
  const local = node.properties?.status?.const;
  return local === 'working' || local === 'input-required' ? local : undefined;
}

test('every working and input-required body composes its core/task-<status>.json', () => {
  for (const [status, ref] of Object.entries(STATUS_SCHEMAS)) {
    const definition = readSource(documentOf(ref));
    assert.deepEqual(definition.properties.status, { const: status });
    assert.deepEqual(definition.required, ['status']);
  }
  const bodies = RESPONSE_NODES.filter(({ rel, pointer, node }) => bodyStatus(rel, pointer, node));
  assert.ok(bodies.length >= 27, `expected the working and input-required bodies, found ${bodies.length}`);
  const missing = bodies
    .filter(({ rel, pointer, node }) => {
      const ref = STATUS_SCHEMAS[bodyStatus(rel, pointer, node)];
      const composes = (schema) => (schema.allOf || []).some((member) => member && member.$ref === ref);
      return !composes(node) && !(node.allOf || []).some((member) => member && typeof member.$ref === 'string'
        && member.$ref !== PROTOCOL_ENVELOPE_REF && documentOf(member.$ref) && composes(readSource(documentOf(member.$ref))));
    })
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(missing, [], 'a status body composes the schema that pins its status');
});

test('no response schema keys a task_id requirement on status through if/then', () => {
  const documents = new Set([...RESPONSE_NODES.map(({ rel }) => rel), 'core/protocol-envelope.json']);
  const conditional = [];
  for (const rel of documents) {
    (function walk(node, pointer) {
      if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${pointer}/${index}`)); return; }
      if (!node || typeof node !== 'object') return;
      if (node.if && node.then) {
        const condition = JSON.stringify(node.if);
        const keyed = condition.includes('"submitted"') || condition.includes('"status"');
        if (keyed && JSON.stringify(node.then).includes('"task_id"')) conditional.push(`${rel}#${pointer}`);
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
    })(readSource(rel), '');
  }
  assert.deepEqual(conditional, [], `code generators ignore if/then; compose ${TASK_SUBMITTED_REF} instead`);
});

test('every response rejects an empty task_id and a submitted response without task_id, single-fault vectors', async (t) => {
  const documents = [...new Set(RESPONSES.map(({ rel }) => rel))];
  const withSubmitted = new Set(SUBMITTED_NODES.map(({ rel }) => rel));
  const reachesSubmitted = (rel, seen = new Set()) => {
    if (withSubmitted.has(rel)) return true;
    if (seen.has(rel)) return false;
    seen.add(rel);
    return RESPONSE_NODES.some(({ rel: at, node }) => at === rel && typeof node.$ref === 'string'
      && documentOf(node.$ref) && reachesSubmitted(documentOf(node.$ref), seen));
  };
  let submittedRuns = 0;
  for (const rel of documents) {
    await t.test(rel, async () => {
      const validate = await validatorFor(`/schemas/${rel}`);

      const empty = addedErrors(validate, { task_id: ENVELOPE_VALUES.task_id }, { task_id: '' });
      assert.ok(empty.length > 0, 'an empty task_id is accepted');
      assert.deepEqual(
        [...new Set(empty.map((error) => `${error.instancePath} ${error.keyword}`))],
        ['/task_id minLength'],
        'an empty task_id must fail on its length only',
      );

      if (!reachesSubmitted(rel)) return;
      submittedRuns += 1;
      const submitted = { status: 'submitted', task_id: ENVELOPE_VALUES.task_id };
      const { task_id: _taskId, ...withoutTaskId } = submitted;
      const controlValid = validate(submitted);
      const missing = addedErrors(validate, submitted, withoutTaskId);
      assert.ok(
        missing.some((error) => error.keyword === 'required' && error.params.missingProperty === 'task_id'),
        'a submitted response without task_id is accepted',
      );
      if (controlValid) {
        // The document accepts a submitted response with task_id, so removing
        // task_id is the one fault; the other errors are the branches an
        // anyOf/oneOf reports once no branch matches.
        assert.equal(validate(withoutTaskId), false);
      } else {
        assert.deepEqual(
          missing.filter((error) => !(
            error.keyword === 'required' && error.params.missingProperty === 'task_id'
          )),
          [],
          'a submitted response without task_id must fail on task_id only',
        );
      }
    });
  }
  assert.ok(submittedRuns >= 28, `expected every document with a submitted shape to run, ran ${submittedRuns}`);
});

/** Instance paths at which a schema declares a task identifier through core/task-id.json. */
function taskIdPaths(node, here = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const refersToTaskId = node.$ref === TASK_ID_REF
    || (node.allOf || []).some((member) => member && member.$ref === TASK_ID_REF);
  if (refersToTaskId) return [here];
  const out = [];
  for (const [name, child] of Object.entries(node.properties || {})) out.push(...taskIdPaths(child, [...here, name]));
  if (node.items) out.push(...taskIdPaths(node.items, [...here, 0]));
  return out;
}

function setAt(target, segments, value) {
  let cursor = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    if (cursor[segment] === undefined) cursor[segment] = typeof segments[index + 1] === 'number' ? [] : {};
    cursor = cursor[segment];
  });
}

test('every request that carries a task_id rejects an empty one, single-fault vectors', async () => {
  const requests = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('-request.json')) requests.push(path.relative(SOURCE_DIR, full).split(path.sep).join('/'));
    }
  })(SOURCE_DIR);
  const ran = [];
  for (const rel of requests.sort()) {
    for (const segments of taskIdPaths(readSource(rel))) {
      const validate = await validatorFor(`/schemas/${rel}`);
      const control = {};
      setAt(control, segments, ENVELOPE_VALUES.task_id);
      const vector = structuredClone(control);
      setAt(vector, segments, '');
      const instancePath = `/${segments.join('/')}`;
      assert.deepEqual(
        addedErrors(validate, control, vector).map(({ instancePath: at, keyword, params }) => ({ instancePath: at, keyword, params })),
        [{ instancePath, keyword: 'minLength', params: { limit: 1 } }],
        `${rel} ${instancePath}: an empty task_id must fail on its length only`,
      );
      ran.push(`${rel} ${instancePath}`);
    }
  }
  assert.deepEqual(ran, [
    'compliance/comply-test-controller-request.json /params/task_id',
    'core/tasks-get-request.json /task_id',
    'core/tasks-list-request.json /filters/task_ids/0',
    'protocol/get-task-status-request.json /task_id',
    'protocol/list-tasks-request.json /filters/task_ids/0',
  ], 'every request task_id carrier must run');
});

const MESSAGE_REF = '/schemas/core/task-message.json';

test('a task-level message has one definition, bounded at 2,000, on every carrier', () => {
  const definition = readSource('core/task-message.json');
  assert.equal(definition.type, 'string');
  assert.equal(definition.maxLength, MESSAGE_MAX);
  // No annotation below the enforced bound.
  assert.equal(definition['x-max-length-4.0'], undefined);
  assert.match(definition.description, /MUST truncate/);
  assert.match(definition.description, /untrusted input/);
  for (const rel of ['core/protocol-envelope.json', 'core/mcp-webhook-payload.json', 'core/response.json']) {
    assert.equal(readSource(rel).properties.message.$ref, MESSAGE_REF, `${rel} message refers to ${MESSAGE_REF}`);
  }
});

test('every response and message carrier accepts 2,000 characters and rejects 2,001 on maxLength only, single-fault vectors', async (t) => {
  const documents = [...new Set(RESPONSES.map(({ rel }) => rel)), 'core/mcp-webhook-payload.json', 'core/response.json'];
  for (const rel of documents) {
    await t.test(rel, async () => {
      const validate = await validatorFor(`/schemas/${rel}`);
      const atBound = { message: 'm'.repeat(MESSAGE_MAX) };
      const overBound = { message: 'm'.repeat(MESSAGE_MAX + 1) };
      const fromEmpty = addedErrors(validate, {}, atBound);
      assert.deepEqual(
        // A branch that pins a fixed message (an unavailable reporting
        // lookup) rejects other text on const; that is the pin, not a bound.
        fromEmpty.filter((error) => error.instancePath === '/message' && error.keyword !== 'const'),
        [],
        `${rel}: a ${MESSAGE_MAX}-character message must be accepted`,
      );
      const added = addedErrors(validate, atBound, overBound);
      assert.ok(added.length > 0, `${rel}: a ${MESSAGE_MAX + 1}-character message is accepted`);
      assert.deepEqual(
        [...new Set(added.map((error) => `${error.instancePath} ${error.keyword}`))],
        ['/message maxLength'],
        `${rel}: a ${MESSAGE_MAX + 1}-character message must fail on maxLength only`,
      );
    });
  }
});
