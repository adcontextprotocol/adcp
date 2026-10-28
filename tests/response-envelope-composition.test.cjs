#!/usr/bin/env node
/**
 * Every task response and async status payload composes the protocol
 * envelope, and every response node accepts every envelope field.
 *
 * On MCP and REST, envelope fields (`status`, `task_id`, `context`,
 * `replayed`, `adcp_version`, ...) are siblings of body fields at the
 * response root. Response schemas compose `core/protocol-envelope.json`
 * through their root `allOf`, and the envelope declares those fields. A
 * draft-07 `additionalProperties: false` does not see `allOf`, so a closed
 * response root or status branch would reject them; DR-0019 keeps response
 * roots open, and so do these schemas. No build step adds the envelope:
 * source and published schemas agree.
 *
 * A response node is a root, an inline `allOf`/`anyOf`/`oneOf` member at any
 * depth, or a document such a member names by whole-document `$ref` (the
 * core/compact-task-* payloads, for example). The rules:
 *   1. every response schema composes the envelope through its root `allOf`;
 *   2. no response node is closed;
 *   3. a response node declares an envelope field only to narrow it (a
 *      `status` discriminator, a `const` pin, or `context` as a `$ref` to
 *      core/context.json), never bounds `message`, never pins `replayed`;
 *   4. acceptance vectors: per node, a control instance passes the node
 *      conjoined with the envelope, and so does the control plus each
 *      envelope field, including the edge values `replayed: false` and a
 *      2,500-character `message`. The node's body-field declarations are
 *      reduced to `{}` unless they pin a discriminator, so the vectors grade
 *      how the node treats envelope fields, not body-field contents.
 *   5. `task_id` has one definition, core/task-id.json, which is never empty:
 *      `task_id: ""` adds exactly its minLength error on every response node
 *      and every request that carries a task_id.
 *   6. Every submitted body and branch composes core/task-submitted.json,
 *      the one place a submitted response requires `task_id`; no schema keys
 *      task_id on status through `if`/`then`. Without `task_id` a submitted
 *      response fails on core/task-submitted.json's `required` alone.
 *
 * Requires the built tree (the npm script builds it) and Node 24, as
 * package.json does.
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

const { discoverTools } = require('../scripts/build-schemas.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const BUILT_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const BUILT_ORIGIN = 'https://adcontextprotocol.org/schemas/latest/';
const PROTOCOL_ENVELOPE_REF = '/schemas/core/protocol-envelope.json';
const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
// The envelope and the schemas that state envelope rules: core/task-submitted.json
// is the one place a submitted response requires task_id. They are not
// response nodes; the rules below grade the responses that compose them.
const ENVELOPE_DOCUMENTS = new Set(['core/protocol-envelope.json', 'core/version-envelope.json', 'core/task-submitted.json']);
// The envelope's `payload` groups the body fields in documentation only; it
// is never serialized on the wire.
const DOCUMENTARY_ENVELOPE_PROPERTIES = new Set(['payload']);

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

const has = (node, key) => Boolean(node) && Object.prototype.hasOwnProperty.call(node, key);

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

/**
 * The envelope's wire properties, in declaration order: its own properties,
 * then those of each schema it composes through its root `allOf`, each with
 * the `$ref` to its declaration.
 */
function envelopeWireProperties() {
  const properties = [];
  const seenNames = new Set();
  const seenRefs = new Set();
  (function collect(ref) {
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    const schema = readSource(ref.slice('/schemas/'.length));
    for (const name of Object.keys(schema.properties || {})) {
      if (DOCUMENTARY_ENVELOPE_PROPERTIES.has(name) || seenNames.has(name)) continue;
      seenNames.add(name);
      properties.push({ name, ref: `${ref}#/properties/${name}` });
    }
    for (const member of schema.allOf || []) {
      if (member && typeof member.$ref === 'string') collect(member.$ref);
    }
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

/** Every response node (see the header), from source. */
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
    if (node.properties || node.required || node.additionalProperties !== undefined) nodes.push({ rel, pointer, node });
    for (const keyword of COMPOSITION_KEYWORDS) {
      (node[keyword] || []).forEach((member, index) => visit(rel, member, `${pointer}/${keyword}/${index}`));
    }
  }
  rels.forEach(visitDocument);
  return nodes;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  loadSchema: async (uri) => {
    if (!uri.startsWith(BUILT_ORIGIN)) throw new Error(`unexpected schema URI ${uri}`);
    return readBuilt(uri.slice(BUILT_ORIGIN.length));
  },
});
addFormats(ajv);

const validators = new Map();
async function validatorFor(ref) {
  if (!validators.has(ref)) validators.set(ref, await ajv.compileAsync({ $ref: ref }));
  return validators.get(ref);
}

const ENVELOPE_PROPERTIES = envelopeWireProperties();
const ENVELOPE_NAMES = new Set(ENVELOPE_PROPERTIES.map(({ name }) => name));
const RESPONSES = responseSchemas();
const RESPONSE_NODES = responseNodes(RESPONSES.map(({ rel }) => rel));

/** A declaration that pins a value: a const or an enum. */
function pins(declaration) {
  return has(declaration, 'const') || Array.isArray(declaration?.enum);
}

/**
 * The published node conjoined with the envelope: the node's own keywords
 * (its composition members are nodes of their own), with each body-field
 * declaration reduced to `{}` unless it pins a discriminator.
 */
async function nodeWithEnvelopeValidator(rel, pointer) {
  const key = `${rel}#${pointer}`;
  if (!validators.has(key)) {
    const documentId = `${BUILT_ORIGIN}${rel}`;
    const own = structuredClone(pointerGet(readBuilt(rel), pointer));
    for (const keyword of [...COMPOSITION_KEYWORDS, 'discriminator', '$id', '$schema', '$ref']) delete own[keyword];
    for (const [name, declaration] of Object.entries(own.properties || {})) {
      if (!ENVELOPE_NAMES.has(name) && !pins(declaration)) own.properties[name] = {};
    }
    (function absolutize(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) node.$ref = `${documentId}${node.$ref}`;
      Object.values(node).forEach(absolutize);
    })(own);
    validators.set(key, await ajv.compileAsync({
      allOf: [{ $ref: `${BUILT_ORIGIN}core/protocol-envelope.json` }, own],
    }));
  }
  return validators.get(key);
}

/** Fit an envelope value to a local declaration that pins it (a branch's `status` const). */
function fitValue(value, declaration) {
  if (!declaration || typeof declaration !== 'object') return value;
  if (has(declaration, 'const')) return declaration.const;
  if (Array.isArray(declaration.enum)) return declaration.enum.includes(value) ? value : declaration.enum[0];
  if (value && typeof value === 'object' && !Array.isArray(value) && declaration.properties) {
    const fitted = { ...value };
    for (const [name, sub] of Object.entries(declaration.properties)) {
      if (has(fitted, name)) fitted[name] = fitValue(fitted[name], sub);
    }
    return fitted;
  }
  return value;
}

/**
 * Meets the node's conditional requirements (`if`/`then`/`else` on the
 * instance): adds each missing top-level field the validator names, and
 * takes the allowed value for a top-level field it pins. Stops when the
 * control passes or makes no progress.
 */
function completeControl(validate, control) {
  for (let round = 0; round < 8 && !validate(control); round += 1) {
    let changed = false;
    for (const error of validate.errors || []) {
      const field = error.instancePath.split('/')[1];
      if (error.instancePath === '' && error.keyword === 'required' && !has(control, error.params.missingProperty)) {
        const name = error.params.missingProperty;
        control[name] = name in ENVELOPE_VALUES ? ENVELOPE_VALUES[name] : 'x';
        changed = true;
      } else if (field && error.instancePath === `/${field}` && error.keyword === 'enum') {
        control[field] = error.params.allowedValues[0];
        changed = true;
      } else if (field && error.instancePath === `/${field}` && error.keyword === 'const') {
        control[field] = error.params.allowedValue;
        changed = true;
      }
    }
    if (!changed) return;
  }
}

/**
 * The control instance for a node: the node's and the envelope's required
 * fields, envelope values fitted to the node's pins, discriminator values for
 * pinned body fields, and a placeholder for other body fields, completed
 * against the node's conditions.
 */
function nodeControl(node, validate) {
  const control = {};
  for (const name of new Set([...(node.required || []), 'status'])) {
    const declaration = node.properties?.[name];
    if (ENVELOPE_NAMES.has(name)) control[name] = fitValue(ENVELOPE_VALUES[name], declaration);
    else if (pins(declaration)) control[name] = has(declaration, 'const') ? declaration.const : declaration.enum[0];
    else control[name] = 'x';
  }
  completeControl(validate, control);
  return control;
}

function errorKey(error) {
  return `${error.instancePath}|${error.schemaPath}|${error.keyword}|${JSON.stringify(error.params)}`;
}

/** Errors the vector raises that the control does not, as instancePath/keyword/params. */
function addedErrors(validate, control, vector) {
  validate(control);
  const controlKeys = new Set((validate.errors || []).map(errorKey));
  validate(vector);
  return (validate.errors || [])
    .filter((error) => !controlKeys.has(errorKey(error)))
    .map(({ instancePath, keyword, params }) => ({ instancePath, keyword, params }));
}

/** Whether a node's own `not` deliberately excludes a field (a completed branch's task_id). */
function excludes(node, name) {
  const forbidden = node.not;
  if (!forbidden) return false;
  const lists = [forbidden, ...(forbidden.anyOf || [])].map((member) => member?.required || []);
  return lists.some((required) => required.length === 1 && required[0] === name);
}

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
    const validate = await validatorFor(`${BUILT_ORIGIN}${ref.slice('/schemas/'.length)}`);
    for (const value of [ENVELOPE_VALUES[name], ...(name in BOUNDARY_VALUES ? [BOUNDARY_VALUES[name]] : [])]) {
      assert.equal(validate(value), true, `${name} value rejected by ${ref}: ${JSON.stringify(validate.errors)}`);
    }
  }
});

test('no response root or status branch is closed', () => {
  assert.ok(RESPONSE_NODES.length > 0, 'found no response nodes; the test would be vacuous');
  const closed = RESPONSE_NODES
    .filter(({ node }) => node.additionalProperties === false || node.unevaluatedProperties === false)
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(closed, [], 'DR-0019 keeps response roots open; a closed node rejects the envelope fields its allOf composes');
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
  if (name === 'status') return pins(declaration);
  if (name === 'context') return declaration.$ref === '/schemas/core/context.json';
  if (has(declaration, 'const')) return true;
  return Object.values(declaration.properties || {}).some((member) => has(member, 'const'));
}

test('response nodes declare only body fields and narrowing constraints', () => {
  const copied = [];
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    for (const name of ENVELOPE_NAMES) {
      const declaration = node.properties?.[name];
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
    const { message, replayed } = node.properties || {};
    if (message && !has(message, 'const') && LENGTH_KEYWORDS.some((keyword) => has(message, keyword))) {
      narrowed.push(`${rel}#${pointer}/properties/message`);
    }
    if (replayed && pins(replayed)) narrowed.push(`${rel}#${pointer}/properties/replayed`);
  }
  assert.deepEqual(narrowed, []);
});

test('every response node accepts every envelope field, acceptance vectors', async (t) => {
  const cases = [
    ...ENVELOPE_PROPERTIES.map(({ name }) => ({ name, value: ENVELOPE_VALUES[name], fit: true })),
    // Edge values honour only a local const, the deliberate pin of a branch
    // (the fixed message of an unavailable reporting lookup). A bound below
    // the envelope's is the defect these vectors catch.
    ...ENVELOPE_PROPERTIES
      .filter(({ name }) => name in BOUNDARY_VALUES)
      .map(({ name }) => ({ name, value: BOUNDARY_VALUES[name], fit: false })),
  ];
  const visited = new Set(RESPONSE_NODES.map(({ rel }) => rel));
  assert.deepEqual(COMPACT_TASK_DOCUMENTS.filter((rel) => !visited.has(rel)), [],
    'the response-node walk must reach the compact task payloads');

  let ran = 0;
  let excluded = 0;
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    await t.test(`${rel}#${pointer}`, async () => {
      const validate = await nodeWithEnvelopeValidator(rel, pointer);
      const control = nodeControl(node, validate);
      assert.equal(validate(control), true,
        `control does not pass ${rel}#${pointer}: ${JSON.stringify(validate.errors)} ${JSON.stringify(control)}`);

      for (const { name, value, fit } of cases) {
        if (excludes(node, name)) {
          // A branch that excludes the field on purpose, such as a completed
          // branch's `not: {required: ["task_id"]}`.
          excluded += 1;
          continue;
        }
        const declaration = node.properties?.[name];
        // A required envelope field is already in the control, with the value
        // the node's pins and conditions take; the vector keeps it.
        const fitted = fit && has(control, name) ? control[name]
          : fit || has(declaration, 'const') ? fitValue(value, declaration) : value;
        const vector = { ...control, [name]: fitted };
        assert.equal(validate(vector), true,
          `${rel}#${pointer} rejects envelope ${name} ${JSON.stringify(fitted).slice(0, 40)}: ${JSON.stringify(validate.errors)}`);
        ran += 1;
      }
    });
  }
  // A run that skips subtests (as Node 22's runner does here) must not pass.
  assert.equal(ran + excluded, RESPONSE_NODES.length * cases.length, 'not every acceptance vector ran');
});

test('an empty task_id is rejected on every response node, single fault', async () => {
  let ran = 0;
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    if (excludes(node, 'task_id')) continue;
    const validate = await nodeWithEnvelopeValidator(rel, pointer);
    const control = { ...nodeControl(node, validate), task_id: ENVELOPE_VALUES.task_id };
    assert.equal(validate(control), true, `control does not pass ${rel}#${pointer}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(addedErrors(validate, control, { ...control, task_id: '' }),
      [{ instancePath: '/task_id', keyword: 'minLength', params: { limit: 1 } }],
      `${rel}#${pointer}: an empty task_id must fail only on core/task-id.json's minLength`);
    ran += 1;
  }
  assert.ok(ran > 100, `expected the rule to run on every response node, ran ${ran}`);
});

const TASK_SUBMITTED_REF = '/schemas/core/task-submitted.json';

/** Whether a node composes core/task-submitted.json: through its allOf, or through a document it names that does. */
function composesTaskSubmitted(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return false;
  const members = [...(node.allOf || []), ...(typeof node.$ref === 'string' ? [{ $ref: node.$ref }] : [])];
  for (const member of members) {
    if (!member || typeof member.$ref !== 'string') continue;
    if (member.$ref === TASK_SUBMITTED_REF) return true;
    const target = documentOf(member.$ref);
    if (target && !seen.has(target)) {
      seen.add(target);
      if (composesTaskSubmitted(readSource(target), seen)) return true;
    }
  }
  return false;
}

/**
 * A submitted response body or branch: a `*-async-response-submitted.json`
 * document, core/compact-task-submitted.json, or a branch titled as the
 * submitted acknowledgement.
 */
function isSubmittedNode({ rel, pointer, node }) {
  if (pointer === '' && (/-async-response-submitted\.json$/.test(rel) || rel === 'core/compact-task-submitted.json')) return true;
  return typeof node.title === 'string' && /submitted$/i.test(node.title.replace(/\s+/g, ''));
}

const SUBMITTED_NODES = RESPONSE_NODES.filter(isSubmittedNode);

test('every submitted body and branch composes core/task-submitted.json', () => {
  assert.ok(SUBMITTED_NODES.length >= 19, `expected the submitted bodies and branches, found ${SUBMITTED_NODES.length}`);
  assert.deepEqual(SUBMITTED_NODES.filter((entry) => !composesTaskSubmitted(entry.node)).map(({ rel, pointer }) => `${rel}#${pointer}`), [],
    'a submitted body or branch must compose core/task-submitted.json');
  // The rule lives in one place: no node restates it with a required task_id,
  // and a status const only stays where an OpenAPI discriminator needs it.
  const restated = SUBMITTED_NODES.filter(({ node }) => (node.required || []).includes('task_id'))
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(restated, [], 'a submitted node restates core/task-submitted.json');
  const pinned = RESPONSE_NODES
    .filter(({ node }) => node.properties?.status?.const === 'submitted' && !composesTaskSubmitted(node))
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(pinned, [], 'a status: submitted branch must compose core/task-submitted.json');
});

test('no schema keys task_id on status through if/then', () => {
  const conditional = [];
  (function walkFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walkFiles(full);
      else if (entry.name.endsWith('.json')) {
        const rel = path.relative(SOURCE_DIR, full).split(path.sep).join('/');
        (function visit(node, pointer) {
          if (!node || typeof node !== 'object') return;
          const condition = node.if;
          const statusKeyed = condition && typeof condition === 'object' && condition.properties?.status;
          const submitted = statusKeyed && (condition.properties.status.const === 'submitted'
            || (condition.properties.status.enum || []).includes('submitted'));
          const requiresTaskId = [node.then, node.else].some((branch) => (branch?.required || []).includes('task_id'));
          if (submitted || (statusKeyed && requiresTaskId)) conditional.push(`${rel}#${pointer}`);
          for (const [key, value] of Object.entries(node)) visit(value, `${pointer}/${key}`);
        })(readJson(full), '');
      }
    }
  })(SOURCE_DIR);
  assert.deepEqual(conditional, [], 'core/task-submitted.json is the one place a submitted response requires task_id');
});

test('a submitted response without task_id fails through core/task-submitted.json', async () => {
  for (const { rel, pointer, node } of SUBMITTED_NODES) {
    const validate = await validatorFor(`${BUILT_ORIGIN}${rel}#${pointer}`);
    const control = nodeControl(node, validate);
    assert.equal(control.status, 'submitted', `${rel}#${pointer}: the control must take status submitted`);
    assert.equal(control.task_id, ENVELOPE_VALUES.task_id, `${rel}#${pointer}: core/task-submitted.json must add task_id to the control`);
    assert.equal(validate(control), true, `control does not pass ${rel}#${pointer}: ${JSON.stringify(validate.errors)}`);
    const { task_id: _removed, ...vector } = control;
    assert.deepEqual(addedErrors(validate, control, vector),
      [{ instancePath: '', keyword: 'required', params: { missingProperty: 'task_id' } }],
      `${rel}#${pointer}: a submitted response without task_id must fail on core/task-submitted.json's required only`);
  }
});

/** Instance paths at which a schema declares a task identifier through core/task-id.json. */
function taskIdPaths(node, here = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const refersToTaskId = node.$ref === '/schemas/core/task-id.json'
    || (node.allOf || []).some((member) => member && member.$ref === '/schemas/core/task-id.json');
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

// Controls for requests whose task_id sits under conditions that the
// top-level completion cannot meet: force_task_completion carries the task's
// result, a get_products response.
const REQUEST_CONTROL_SEEDS = {
  'compliance/comply-test-controller-request.json': {
    scenario: 'force_task_completion',
    account: { account_id: 'acc_envelope_0001', sandbox: true },
    params: { result: { status: 'completed', products: [], cache_scope: 'account' } },
  },
};

test('every request that carries a task_id rejects an empty one, single fault', async () => {
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
      const validate = await validatorFor(`${BUILT_ORIGIN}${rel}`);
      const control = structuredClone(REQUEST_CONTROL_SEEDS[rel] || {});
      setAt(control, segments, ENVELOPE_VALUES.task_id);
      completeControl(validate, control);
      assert.equal(validate(control), true, `control does not pass ${rel}: ${JSON.stringify(validate.errors)}`);
      const vector = structuredClone(control);
      setAt(vector, segments, '');
      const instancePath = `/${segments.join('/')}`;
      assert.deepEqual(addedErrors(validate, control, vector),
        [{ instancePath, keyword: 'minLength', params: { limit: 1 } }],
        `${rel} ${instancePath}: an empty task_id must fail on minLength`);
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
