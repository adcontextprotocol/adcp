#!/usr/bin/env node
/**
 * Task responses: the protocol envelope owns every envelope field, the source
 * schemas declare only bodies, and the build generates each task's wire
 * response from them.
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
 * A task declares one body per envelope status: <task>-response.json
 * (completed), <task>-async-response-<status>.json (submitted, working,
 * input-required), <task>-rejected.json and <task>-failed.json. Each body
 * serves only the status its file name carries and never tests `status`. The
 * build (scripts/wire-responses.cjs) generates
 * <protocol>/<task>-wire-response.json: a disjoint `oneOf`, discriminated by
 * `status`, with one branch per status that has a body.
 *
 * A response node is a root, an inline `allOf`/`anyOf`/`oneOf` member at any
 * depth, or a document such a member names by whole-document `$ref` (the
 * core/compact-task-* payloads, for example). The rules:
 *   1. every status body composes the envelope through its root `allOf`;
 *   2. no response node is closed;
 *   3. a source response node declares no envelope field: no `status`
 *      discriminator (those appear only in the generated wire responses), no
 *      `context` mirror, no bound on `message`, no `replayed` value. The one
 *      exception is a `const` pin of a value for one task (the fixed message
 *      and error of an unavailable reporting lookup);
 *   4. acceptance vectors: per node, a control instance passes the node
 *      conjoined with the envelope, and so does the control plus each
 *      envelope field, including the edge values `replayed: false` and a
 *      2,000-character `message`. The node's body-field declarations are
 *      reduced to `{}` unless they pin a discriminator, so the vectors grade
 *      how the node treats envelope fields, not body-field contents;
 *   5. `task_id` has one definition, core/task-id.json, which is never empty:
 *      `task_id: ""` adds exactly its minLength error on every response node
 *      and every request that carries a task_id.
 *   6. Every status body composes its core/task-<status>.json: submitted
 *      bodies core/task-submitted.json, the one place a submitted response
 *      requires `task_id`, and the working and input-required payloads
 *      core/task-working.json and core/task-input-required.json. No schema
 *      keys task_id on status through `if`/`then`. Without `task_id` a
 *      submitted response fails on core/task-submitted.json's `required`
 *      alone.
 *   7. A task-level `message` has one definition, core/task-message.json
 *      (`maxLength: 2000`), which the envelope, the MCP webhook payload and
 *      the response wrapper refer to: a 2,001-character `message` adds
 *      exactly its maxLength error on every response node and on both other
 *      carriers, so the bound does not depend on the delivery path.
 *   8. every tool's wire response is a disjoint `oneOf` discriminated by
 *      `status`, with exactly one branch per status that has a body, each
 *      requiring `status`, pinning it and composing that body; no body tests
 *      `status` itself (the core/task-<status>.json schemas the bodies
 *      compose are the core schemas that pin it);
 *   9. differential validation against the base build (the envelope
 *      composition before the bodies were split), scored per surface. On the
 *      tool surface (base `<task>-response.json`, this build's wire response)
 *      only the listed differences of status dispatch occur, by tool and
 *      status; on the async surface (base status file, the status body at its
 *      path) only the listed contradictions resolved toward the tool response
 *      do; the document surface has none. The instances are every response instance in the
 *      repository, a generated matrix of a minimal instance per tool, status
 *      and base branch (with and without an empty errors array), and every
 *      repository tool response under every status; changing one envelope
 *      field of a valid instance changes no verdict.
 *
 * Requires the built tree (the npm script builds it) and Node 24, as
 * package.json does. The differential check builds the base commit into a
 * temporary directory; set RESPONSE_DIFF_BASE_DIR to a built
 * dist/schemas/latest tree to reuse one, or RESPONSE_DIFF_BASE_REF to pick
 * another commit.
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
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { discoverTools } = require('../scripts/build-schemas.cjs');
const { taskStatusSchemas } = require('../scripts/wire-responses.cjs');
const { collectResponseInstances } = require('./helpers/response-instance-corpus.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const BUILT_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const BUILT_ORIGIN = 'https://adcontextprotocol.org/schemas/latest/';
const PROTOCOL_ENVELOPE_REF = '/schemas/core/protocol-envelope.json';
const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
// The envelope and the schemas that state envelope rules: core/task-submitted.json
// is the one place a submitted response requires task_id. They are not
// response nodes; the rules below grade the responses that compose them.
const STATUS_BODY_STATUSES = ['submitted', 'working', 'input-required'];
const ENVELOPE_DOCUMENTS = new Set([
  'core/protocol-envelope.json',
  'core/version-envelope.json',
  ...STATUS_BODY_STATUSES.map((status) => `core/task-${status}.json`),
]);
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
// envelope's `message` is core/task-message.json, at most 2,000 characters
// in 3.x, so a 2,000-character message
// conforms on every response node.
const MESSAGE_MAX_LENGTH = 2000;
const TASK_MESSAGE_REF = '/schemas/core/task-message.json';
const BOUNDARY_VALUES = {
  replayed: false,
  message: 'm'.repeat(MESSAGE_MAX_LENGTH),
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

const TOOLS = discoverTools(SOURCE_DIR);
const TASK_STATUSES = readSource('enums/task-status.json').enum;

/** The status a body's file name carries. */
function bodyStatus(rel) {
  if (rel.endsWith('-wire-response.json')) throw new Error(`${rel} is generated, not a body`);
  for (const status of TASK_STATUSES) {
    if (rel.endsWith(`-async-response-${status}.json`) || rel.endsWith(`-${status}.json`)) return status;
  }
  if (rel.endsWith('-response.json')) return 'completed';
  throw new Error(`${rel}: no status in its name`);
}

/** Every status body of every tool, once each: `{ tool, status, rel }`. */
function responseSchemas() {
  const out = [];
  const seen = new Set();
  for (const tool of TOOLS) {
    for (const { schema: rel } of tool.status_schemas) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push({ tool: tool.name, status: bodyStatus(rel), rel });
    }
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
 * A local declaration of an envelope field that a source response node may
 * keep: a value pin for one task, a `const` or an object whose properties pin
 * values with `const` (the fixed message and error of an unavailable
 * reporting lookup). A `status` discriminator appears only in the generated
 * wire responses, and `context` only on the envelope; anything else restates
 * the envelope, so the envelope's declaration governs.
 */
function permittedLocalDeclaration(name, declaration) {
  if (!declaration || typeof declaration !== 'object') return false;
  if (name === 'status' || name === 'context') return false;
  if (has(declaration, 'const')) return true;
  return Object.values(declaration.properties || {}).some((member) => has(member, 'const'));
}

test('source response nodes declare no envelope field', () => {
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

test('status discriminators appear only in the generated wire responses', () => {
  for (const tool of TOOLS) {
    const wire = readBuilt(tool.response_schema);
    for (const branch of wire.oneOf) {
      assert.ok(pins(branch.properties?.status), `${tool.response_schema}: a branch without a status const`);
    }
  }
  const declared = RESPONSE_NODES
    .filter(({ node }) => has(node.properties, 'status'))
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(declared, [], 'a source body declares status; the generated wire response pins it');
});

test('no response node narrows message length or pins replayed', () => {
  // The envelope defines message once, through core/task-message.json, and replayed as
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

test('every task-level message refers to core/task-message.json', () => {
  const carriers = ['core/protocol-envelope.json', 'core/mcp-webhook-payload.json', 'core/response.json'];
  const own = carriers.filter((rel) => readSource(rel).properties?.message?.$ref !== TASK_MESSAGE_REF);
  assert.deepEqual(own, [], 'a task-level message refers to the one definition, so its bound does not depend on the delivery path');
  const definition = readSource('core/task-message.json');
  assert.equal(definition.maxLength, MESSAGE_MAX_LENGTH);
});

const OVERLONG_MESSAGE = 'm'.repeat(MESSAGE_MAX_LENGTH + 1);
const MESSAGE_FAULT = [{ instancePath: '/message', keyword: 'maxLength', params: { limit: MESSAGE_MAX_LENGTH } }];

test('a 2,001-character message is rejected on every response node, single fault', async () => {
  let ran = 0;
  let pinned = 0;
  for (const { rel, pointer, node } of RESPONSE_NODES) {
    if (has(node.properties?.message, 'const')) {
      // The fixed text of an unavailable reporting lookup: its const rejects
      // any other message on its own.
      pinned += 1;
      continue;
    }
    const validate = await nodeWithEnvelopeValidator(rel, pointer);
    const control = { ...nodeControl(node, validate), message: BOUNDARY_VALUES.message };
    assert.equal(validate(control), true, `control does not pass ${rel}#${pointer}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(addedErrors(validate, control, { ...control, message: OVERLONG_MESSAGE }), MESSAGE_FAULT,
      `${rel}#${pointer}: a 2,001-character message must fail only on core/task-message.json's maxLength`);
    ran += 1;
  }
  assert.ok(ran > 100, `expected the rule to run on every response node, ran ${ran}`);
  assert.equal(ran + pinned, RESPONSE_NODES.length, 'not every response node ran');
});

// Controls for the other task-level message carriers.
const MESSAGE_CARRIER_CONTROLS = {
  'core/mcp-webhook-payload.json': {
    idempotency_key: 'whk_envelope_000000000001',
    operation_id: 'op_envelope_0001',
    task_id: ENVELOPE_VALUES.task_id,
    task_type: 'get_products',
    status: 'working',
    timestamp: ENVELOPE_VALUES.timestamp,
  },
  'core/response.json': {},
};

test('the webhook payload and response wrapper bound message the same way, single fault', async () => {
  for (const [rel, seed] of Object.entries(MESSAGE_CARRIER_CONTROLS)) {
    const validate = await validatorFor(`${BUILT_ORIGIN}${rel}`);
    const control = { ...seed, message: BOUNDARY_VALUES.message };
    assert.equal(validate(control), true, `control does not pass ${rel}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(addedErrors(validate, control, { ...control, message: OVERLONG_MESSAGE }), MESSAGE_FAULT,
      `${rel}: a 2,001-character message must fail only on core/task-message.json's maxLength`);
  }
});

const TASK_SUBMITTED_REF = '/schemas/core/task-submitted.json';

/** Whether a node composes `ref`: through its allOf, or through a document it names that does. */
function composesStatusSchema(node, ref, seen = new Set()) {
  if (!node || typeof node !== 'object') return false;
  const members = [...(node.allOf || []), ...(typeof node.$ref === 'string' ? [{ $ref: node.$ref }] : [])];
  for (const member of members) {
    if (!member || typeof member.$ref !== 'string') continue;
    if (member.$ref === ref) return true;
    const target = documentOf(member.$ref);
    if (target && !seen.has(target)) {
      seen.add(target);
      if (composesStatusSchema(readSource(target), ref, seen)) return true;
    }
  }
  return false;
}

function composesTaskSubmitted(node) {
  return composesStatusSchema(node, TASK_SUBMITTED_REF);
}

/**
 * The body for one task status: a `*-async-response-<status>.json`
 * document, core/compact-task-<status>.json, or a branch titled for that
 * status (`...Submitted`).
 */
function statusOfBody({ rel, pointer, node }) {
  for (const status of STATUS_BODY_STATUSES) {
    if (pointer === '' && (rel.endsWith(`-async-response-${status}.json`) || rel === `core/compact-task-${status}.json`)) return status;
    const word = status.replace(/-/g, '');
    if (typeof node.title === 'string' && node.title.replace(/[\s-]+/g, '').toLowerCase().endsWith(word)) return status;
  }
  return undefined;
}

function isSubmittedNode(entry) {
  return statusOfBody(entry) === 'submitted';
}

const SUBMITTED_NODES = RESPONSE_NODES.filter(isSubmittedNode);

test('every status body composes its core/task-<status>.json', () => {
  const bodies = RESPONSE_NODES.map((entry) => ({ ...entry, status: statusOfBody(entry) })).filter(({ status }) => status);
  for (const status of STATUS_BODY_STATUSES) {
    assert.ok(bodies.some((body) => body.status === status), `found no ${status} bodies; the rule would be vacuous`);
  }
  assert.deepEqual(
    bodies.filter(({ node, status }) => !composesStatusSchema(node, `/schemas/core/task-${status}.json`))
      .map(({ rel, pointer, status }) => `${rel}#${pointer} (${status})`),
    [], 'a status body must compose its core/task-<status>.json');
  // A node that pins one of these statuses composes that status's schema.
  const pinned = RESPONSE_NODES.filter(({ node }) => STATUS_BODY_STATUSES.includes(node.properties?.status?.const)
    && !composesStatusSchema(node, `/schemas/core/task-${node.properties.status.const}.json`))
    .map(({ rel, pointer }) => `${rel}#${pointer}`);
  assert.deepEqual(pinned, [], 'a status-pinned node must compose its core/task-<status>.json');
});

test('every submitted body and branch composes core/task-submitted.json', () => {
  assert.ok(SUBMITTED_NODES.length >= 16, `expected the submitted bodies, found ${SUBMITTED_NODES.length}`);
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

test('every tool wire response has one branch per status that has a body', () => {
  const statuses = readSource('enums/task-status.json').enum;
  for (const tool of TOOLS) {
    const toolBase = tool.name.replace(/_/g, '-');
    const protoDir = path.join(SOURCE_DIR, tool.protocol);
    // Status bodies on disk, by the naming convention, independent of the build.
    const expected = new Map([['completed', `${tool.protocol}/${toolBase}-response.json`]]);
    for (const name of fs.readdirSync(protoDir)) {
      const match = name.match(new RegExp(`^${toolBase}-(?:async-response-)?([a-z-]+)\\.json$`));
      if (match && statuses.includes(match[1]) && match[1] !== 'completed') {
        assert.ok(!expected.has(match[1]), `${tool.name}: two bodies for ${match[1]}`);
        expected.set(match[1], `${tool.protocol}/${name}`);
      }
    }

    assert.equal(tool.response_schema, `${tool.protocol}/${toolBase}-wire-response.json`, `${tool.name}: manifest response_schema`);
    for (const rel of tool.async_response_schemas) {
      assert.ok([...expected.values()].includes(rel), `${tool.name}: async schema ${rel} is not a status body`);
    }

    const wire = readBuilt(tool.response_schema);
    assert.equal(wire.$id, `${BUILT_ORIGIN}${tool.response_schema}`, `${tool.name}: wire response $id`);
    const branches = wire.oneOf.map((branch) => {
      assert.equal(branch.allOf.length, 1, `${tool.name}: a branch composes one body`);
      const rel = documentOf(branch.allOf[0].$ref);
      assert.ok(rel && fs.existsSync(path.join(BUILT_DIR, rel)), `${tool.name}: branch body ${branch.allOf[0].$ref} is published`);
      return [branch.properties.status.const, rel];
    });
    const ordered = statuses.filter((status) => expected.has(status));
    assert.deepEqual(branches.map(([status]) => status), ordered, `${tool.name}: one branch per status body, in task-status order`);
    assert.deepEqual(Object.fromEntries(branches), Object.fromEntries(expected), `${tool.name}: branches`);
    assert.deepEqual(
      taskStatusSchemas(SOURCE_DIR, tool.protocol, toolBase).map(({ status, schema }) => [status, schema]),
      branches,
      `${tool.name}: generator`,
    );
  }
});

test('a schema tree without the task-status enum has no status bodies', () => {
  // Test fixtures build small trees of a few schemas; discovering tools in
  // them must not require the protocol's enums.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-no-status-enum-'));
  try {
    fs.mkdirSync(path.join(fixture, 'media-buy'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'media-buy', 'demo-task-response.json'), '{}\n');
    assert.deepEqual(taskStatusSchemas(fixture, 'media-buy', 'demo-task'), []);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('every wire response is a disjoint oneOf discriminated by status', () => {
  const ALLOWED_UNION_KEYS = ['$schema', '$id', 'title', 'description', 'type', 'discriminator', 'oneOf', 'x-generated'];
  const ALLOWED_BRANCH_KEYS = ['title', 'allOf', 'properties', 'required'];
  for (const tool of TOOLS) {
    const wire = readBuilt(tool.response_schema);
    assert.deepEqual(Object.keys(wire).filter((key) => !ALLOWED_UNION_KEYS.includes(key)), [], `${tool.name}: the union carries only its oneOf`);
    assert.deepEqual(wire.discriminator, { propertyName: 'status' }, `${tool.name}: discriminator`);
    assert.ok(Array.isArray(wire.oneOf) && wire.oneOf.length > 0, `${tool.name}: oneOf`);
    const consts = [];
    for (const branch of wire.oneOf) {
      assert.deepEqual(Object.keys(branch).filter((key) => !ALLOWED_BRANCH_KEYS.includes(key)), [], `${tool.name}: a branch carries no other keyword`);
      assert.deepEqual(Object.keys(branch.properties), ['status'], `${tool.name}: a branch declares only status`);
      assert.ok(pins(branch.properties.status), `${tool.name}: a branch pins status`);
      assert.deepEqual(branch.required, ['status'], `${tool.name}: a branch requires status`);
      assert.deepEqual(Object.keys(branch.allOf[0]), ['$ref'], `${tool.name}: a branch composes its body by reference only`);
      consts.push(branch.properties.status.const);
    }
    assert.equal(new Set(consts).size, consts.length, `${tool.name}: distinct status consts`);
  }
});

test('no status body dispatches on status', () => {
  // A body never tests `status`: the wire response selects the body by its
  // status, so a body has no status-level branch, condition or exclusion.
  // core/task-submitted.json, core/task-working.json and
  // core/task-input-required.json pin `status`; they are envelope rules the
  // status bodies compose by reference, not bodies, so the walk does not
  // enter them.
  // Walk the subschemas that apply to the response object itself; a nested
  // field named status belongs to the body.
  const ROOT_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'];
  const offenders = [];
  for (const { rel } of RESPONSES) {
    (function scan(node, pointer) {
      if (Array.isArray(node)) return node.forEach((item, index) => scan(item, `${pointer}/${index}`));
      if (!node || typeof node !== 'object') return;
      if (node.properties && has(node.properties, 'status')) offenders.push(`${rel}#${pointer}/properties/status`);
      if (Array.isArray(node.required) && node.required.includes('status')) offenders.push(`${rel}#${pointer}/required`);
      for (const key of ROOT_KEYWORDS) if (has(node, key)) scan(node[key], `${pointer}/${key}`);
    })(readSource(rel), '');
  }
  assert.deepEqual(offenders, [], 'a status body tests status');
});

// Differential validation against the base build: main with the envelope
// composition (#8547) before the response schemas were reduced to bodies. The
// commit where this change leaves origin/main when that is fetched, so later
// main commits do not count as this change's differences; else the main
// commit this change was last rebased onto.
const BASE_BRANCH = 'origin/main';
const PINNED_BASE_REF = '023bbd26e7c230dcc74bea4087336ea6bc8d0f6a';

// Verdicts are scored per surface:
//   - tool: a tool response, base `<task>-response.json` against this build's
//     `<task>-wire-response.json`;
//   - async: an async status payload, base `<task>-async-response-<status>.json`
//     (or `<task>-<status>.json`) against the status body at the same path,
//     for an instance that carries that status;
//   - document: any other schema, against itself.
// Where the base's tool response and its status file disagreed about the same
// status, the status body takes the tool response's rules: a field the tool
// response excluded (`excluded`), or declared where the file left it open
// (`declared`). Each async-surface difference that follows is listed below.
// Its vector, the minimal valid instance of the status plus `field: 1`, fails
// the status body and passed the base file, and keeps its verdict on the
// tool surface.
//
// The wire response is a disjoint oneOf that selects one body by status. The
// base's tool response did not dispatch on status for most tasks, so three
// kinds of tool-surface difference follow, each listed by tool and status:
//   - OPEN_ROOT: a status with no body, which the base accepted through its
//     open root (`canceled` with completed-body fields, for example) and the
//     union rejects;
//   - OTHER_BODY: a status with its own body, where the base accepted an
//     instance only because the completed body did not restrict status, and
//     the status's own body rejects it (a failed response with success
//     fields, for example);
//   - STATUS_FILE: a status whose body is a status file that the base's tool
//     response did not compose (a working payload, for example), which the
//     union now accepts;
//   - OVERLAP: an instance that matched two of the base's oneOf members (the
//     completed body and the failed body), which the base therefore rejected
//     and the status's own body accepts.
// No other tool-surface verdict changes, and the document surface has none.
const CONTRADICTION = 'contradiction resolved toward the tool-response definition';
const OPEN_ROOT = 'status with no defined body; base accepted it only through the open root';
const OTHER_BODY = 'status with its own body; base accepted it only through the completed body';
const STATUS_FILE = 'status defined by a status file the base tool response did not compose';
const OVERLAP = 'instance matching two bodies; the base oneOf rejected it, its status body accepts it';
const TOOL_SURFACE_DIFFERENCES = {
  [OPEN_ROOT]: { verdict: { base: true, built: false }, statuses: {
    acquire_rights: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    activate_signal: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    build_creative: ['canceled', 'rejected', 'auth-required', 'unknown'],
    calibrate_content: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    check_governance: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    comply_test_controller: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    create_collection_list: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    create_content_standards: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    delete_collection_list: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    delete_property_list: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_account_financials: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    get_adcp_capabilities: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_collection_list: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_content_standards: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_creative_features: ['working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    get_media_buy_artifacts: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_media_buy_delivery: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_media_buys: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_plan_audit_logs: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    get_principal: ['submitted', 'working', 'input-required', 'canceled', 'auth-required', 'unknown'],
    get_products: ['canceled', 'auth-required', 'unknown'],
    get_rights: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    get_signals: ['input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    list_accounts: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_collection_lists: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_collections: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_content_standards: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_creative_formats: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_creatives: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_products: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_property_lists: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_proposals: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    list_transformers: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    log_event: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    provide_performance_feedback: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    report_media_buy_issue: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    report_plan_outcome: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    report_usage: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    search_brands: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    si_get_offering: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    si_initiate_session: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    si_terminate_session: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    sync_accounts: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    sync_agent_notification_configs: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    sync_audiences: ['working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    sync_creatives: ['canceled', 'rejected', 'auth-required', 'unknown'],
    sync_event_sources: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    sync_governance: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    sync_plans: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    sync_principal: ['submitted', 'working', 'input-required', 'canceled', 'auth-required', 'unknown'],
    update_content_standards: ['submitted', 'working', 'input-required', 'canceled', 'rejected', 'auth-required', 'unknown'],
    update_media_buy: ['canceled', 'rejected', 'auth-required', 'unknown'],
    validate_content_delivery: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    validate_input: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
    validate_property_delivery: ['submitted', 'working', 'input-required', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'],
  } },
  [OTHER_BODY]: { verdict: { base: true, built: false }, statuses: {
    acquire_rights: ['failed'],
    activate_signal: ['failed'],
    build_creative: ['submitted', 'failed'],
    create_content_standards: ['failed'],
    get_account_financials: ['failed'],
    get_creative_features: ['failed'],
    get_products: ['submitted'],
    get_rights: ['failed'],
    get_signals: ['submitted'],
    log_event: ['failed'],
    provide_performance_feedback: ['failed'],
    report_media_buy_issue: ['failed'],
    search_brands: ['failed'],
    sync_accounts: ['failed'],
    sync_audiences: ['failed'],
    sync_creatives: ['failed'],
    sync_event_sources: ['failed'],
    sync_governance: ['failed'],
    update_content_standards: ['failed'],
    update_media_buy: ['submitted', 'failed'],
  } },
  [STATUS_FILE]: { verdict: { base: false, built: true }, statuses: {
    accept_proposal: ['working', 'input-required'],
    build_creative: ['working', 'input-required'],
    buy_products: ['working', 'input-required'],
    control_media_buy: ['working', 'input-required'],
    create_media_buy: ['working', 'input-required'],
    decline_proposals: ['working', 'input-required'],
    get_products: ['submitted', 'working', 'input-required'],
    get_signals: ['submitted', 'working'],
    refine_proposals: ['working', 'input-required'],
    request_proposals: ['working', 'input-required'],
    sync_catalogs: ['working', 'input-required'],
    sync_creatives: ['working', 'input-required'],
    update_media_buy: ['working', 'input-required'],
  } },
  [OVERLAP]: { verdict: { base: false, built: true }, statuses: {
    create_content_standards: ['failed'],
  } },
};
const SUBMITTED_CONTRADICTIONS = {
  build_creative: { excluded: ['creative_manifest', 'creative_manifests', 'creatives', 'estimate'] },
  control_media_buy: { excluded: ['media_buy_id', 'warnings'] },
  create_media_buy: { excluded: ['media_buy_id', 'packages', 'warnings'] },
  update_media_buy: { excluded: ['media_buy_id', 'warnings'] },
  buy_products: { excluded: ['media_buy_id', 'warnings'], declared: ['expected_confirmation_at'] },
  accept_proposal: { excluded: ['media_buy_id', 'warnings'], declared: ['expected_confirmation_at'] },
  sync_catalogs: { excluded: ['catalogs', 'item_availability_updates', 'item_availability_states'] },
  sync_creatives: { excluded: ['creatives', 'merges', 'warnings'] },
  refine_proposals: {
    excluded: ['proposals', 'refinement_applied', 'pagination'],
    declared: ['results', 'products', 'collections'],
  },
  request_proposals: {
    excluded: ['refinement_applied', 'pagination', 'unchanged', 'wholesale_feed_version', 'feed_version', 'pricing_version'],
    declared: ['outcome', 'reason', 'suggestions', 'proposals', 'products', 'collections', 'incomplete', 'purchase_continuation', 'targeting_resolution', 'later_proposals'],
  },
  decline_proposals: { declared: ['results'] },
};
const EXPECTED_DIFFERENCES = {
  tool: Object.entries(TOOL_SURFACE_DIFFERENCES).flatMap(([reason, { verdict, statuses: byTool }]) =>
    Object.entries(byTool).flatMap(([tool, statuses]) => statuses.map((status) => ({ tool, status, verdict, reason })))),
  document: [],
  async: Object.entries(SUBMITTED_CONTRADICTIONS).flatMap(([tool, kinds]) => {
    const { protocol } = TOOLS.find((candidate) => candidate.name === tool);
    const schema = `${protocol}/${tool.replace(/_/g, '-')}-async-response-submitted.json`;
    return Object.entries(kinds).flatMap(([kind, fields]) => fields.map((field) => ({
      tool,
      schema,
      field,
      kind,
      value: 1,
      verdict: { base: true, built: false },
      reason: CONTRADICTION,
    })));
  }),
};

// One envelope field changed on a valid instance: its value at the edge of
// the envelope's declaration. Neither build may change its verdict on it.
const ENVELOPE_PERTURBATIONS = {
  replayed: (instance) => ({ ...instance, replayed: false }),
  message: (instance) => ({ ...instance, message: 'm'.repeat(MESSAGE_MAX_LENGTH) }),
  task_id: (instance) => ({ ...instance, task_id: '' }),
  context: (instance) => ({ ...instance, context: { trace_id: 'trace-0001' } }),
};

function baseTree() {
  if (process.env.RESPONSE_DIFF_BASE_DIR) return { dir: process.env.RESPONSE_DIFF_BASE_DIR };
  const exists = (candidate) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${candidate}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const mergeBase = () => {
    try {
      return execFileSync('git', ['merge-base', 'HEAD', BASE_BRANCH], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return null;
    }
  };
  const ref = process.env.RESPONSE_DIFF_BASE_REF || [mergeBase(), PINNED_BASE_REF].find((candidate) => candidate && exists(candidate));
  if (!ref || !exists(ref)) {
    return { skip: `base commit ${ref || PINNED_BASE_REF} is not available; fetch it or set RESPONSE_DIFF_BASE_DIR` };
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-response-base-'));
  const archive = path.join(work, 'base.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', archive, ref, 'scripts', 'static/schemas', 'static/compliance/source', 'package.json'], { cwd: REPO_ROOT });
  execFileSync('tar', ['-xf', archive, '-C', work]);
  fs.mkdirSync(path.join(work, 'dist', 'schemas'), { recursive: true });
  execFileSync(process.execPath, [path.join(work, 'scripts', 'build-schemas.cjs')], {
    cwd: work,
    env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, 'node_modules') },
    stdio: 'ignore',
  });
  return { ref, dir: path.join(work, 'dist', 'schemas', 'latest'), cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

/** The base's status files of a tool that this build also publishes, by status. */
function statusFiles(tool, baseDir, statuses) {
  const toolBase = tool.name.replace(/_/g, '-');
  const files = new Map();
  for (const status of statuses) {
    if (status === 'completed') continue;
    for (const name of [`${toolBase}-async-response-${status}.json`, `${toolBase}-${status}.json`]) {
      const rel = `${tool.protocol}/${name}`;
      if (fs.existsSync(path.join(baseDir, rel)) && fs.existsSync(path.join(BUILT_DIR, rel))) files.set(status, rel);
    }
  }
  return files;
}

/**
 * The surfaces an instance is scored on, each a pair of schemas. A tool
 * response is scored on the tool surface and, when the base had a status file
 * for its status, on the async surface too. An instance of a status file is
 * scored on the async surface when it carries that file's status.
 */
function surfacesOf(instance, context) {
  const { baseDir, statuses, files } = context;
  const status = instance.data && typeof instance.data === 'object' ? instance.data.status : undefined;
  const tool = TOOLS.find((t) => instance.schema === t.response_schema || instance.schema === t.completed_response_schema);
  if (tool) {
    const surfaces = [{ surface: 'tool', tool: tool.name, base: tool.completed_response_schema, built: tool.response_schema }];
    const rel = files.get(tool.name)?.get(status);
    if (rel) surfaces.push({ surface: 'async', base: rel, built: rel });
    return surfaces;
  }
  for (const [, byStatus] of files) {
    for (const [fileStatus, rel] of byStatus) {
      if (rel !== instance.schema) continue;
      return fileStatus === status ? [{ surface: 'async', base: rel, built: rel }] : [];
    }
  }
  if (!fs.existsSync(path.join(baseDir, instance.schema))) return [];
  return [{ surface: 'document', base: instance.schema, built: instance.schema }];
}

/** A placeholder value for a required body field: its pinned value, or one of its type. */
function matrixValue(name, declaration) {
  if (name in ENVELOPE_VALUES) return ENVELOPE_VALUES[name];
  if (declaration && has(declaration, 'const')) return declaration.const;
  if (declaration && Array.isArray(declaration.enum)) return declaration.enum[0];
  const type = Array.isArray(declaration?.type) ? declaration.type[0] : declaration?.type;
  if (type === 'array') return [];
  if (type === 'object') return {};
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  return 'x';
}

/** A task response: a tool's response, or a document that composes the envelope. */
function isResponseInstance(instance) {
  if (TOOLS.some((t) => instance.schema === t.response_schema || instance.schema === t.completed_response_schema)) return true;
  return fs.existsSync(path.join(SOURCE_DIR, instance.schema)) && composesEnvelopeThroughRootAllOf(instance.schema);
}

test('differential validation: every response instance keeps its verdict on each surface', { timeout: 900000 }, async (t) => {
  const base = baseTree();
  if (base.skip) {
    t.skip(base.skip);
    return;
  }
  try {
    const ajvFor = (read) => {
      const ajv = new Ajv({
        allErrors: true,
        strict: false,
        discriminator: true,
        loadSchema: async (uri) => {
          if (!uri.startsWith(BUILT_ORIGIN)) throw new Error(`unexpected schema URI ${uri}`);
          return read(uri.slice(BUILT_ORIGIN.length));
        },
      });
      addFormats(ajv);
      return ajv;
    };
    const ajvs = { base: ajvFor((rel) => readJson(path.join(base.dir, rel))), built: ajvFor(readBuilt) };
    const compiled = new Map();
    async function validate(side, rel, data) {
      const key = `${side} ${rel}`;
      if (!compiled.has(key)) compiled.set(key, await ajvs[side].compileAsync({ $ref: `${BUILT_ORIGIN}${rel}` }));
      return compiled.get(key)(structuredClone(data));
    }
    const score = async (pair, data) => ({ baseValid: await validate('base', pair.base, data), builtValid: await validate('built', pair.built, data) });

    const statuses = readSource('enums/task-status.json').enum;
    const files = new Map(TOOLS.map((tool) => [tool.name, statusFiles(tool, base.dir, statuses)]));
    const context = { baseDir: base.dir, statuses, files };
    const expectedAsync = EXPECTED_DIFFERENCES.async;
    if (base.ref) t.diagnostic(`base: ${base.ref}`);

    // A difference on the async surface is expected when it runs the way a
    // listed entry for that schema does and dropping every listed field of
    // the schema restores equal verdicts.
    const expectedTool = EXPECTED_DIFFERENCES.tool;
    const branchStatuses = new Map(TOOLS.map((tool) => [tool.name, new Set(readBuilt(tool.response_schema).oneOf.map((b) => b.properties.status.const))]));
    const observedTool = new Set();
    // Tasks with no submitted body whose base accepted a submitted response
    // without task_id: the base no longer states that requirement outside
    // core/task-submitted.json, which only submitted bodies compose.
    const submittedWithoutTaskId = new Set();
    async function explained(pair, data, result) {
      if (pair.surface === 'tool') {
        const tool = TOOLS.find((candidate) => candidate.name === pair.tool);
        const branch = tool.status_schemas.find(({ status }) => status === data.status);
        const candidates = expectedTool.filter((e) => e.tool === pair.tool && e.status === data.status
          && e.verdict.base === result.baseValid && e.verdict.built === result.builtValid);
        for (const entry of candidates) {
          // OPEN_ROOT: the status has no branch.
          if (entry.reason === OPEN_ROOT && branch) continue;
          if (entry.reason !== OPEN_ROOT && (!branch || data.status === 'completed')) continue;
          // OTHER_BODY: the completed body accepts the instance.
          if (entry.reason === OTHER_BODY && !(await validate('built', tool.completed_response_schema, data))) continue;
          // STATUS_FILE: the base's tool response never referenced the status's body.
          if (entry.reason === STATUS_FILE
            && fs.readFileSync(path.join(base.dir, tool.completed_response_schema), 'utf8').includes(branch.schema)) continue;
          // OVERLAP: the completed body, which composes the status body, rejects it.
          if (entry.reason === OVERLAP && await validate('built', tool.completed_response_schema, data)) continue;
          observedTool.add(`${entry.reason}|${entry.tool} ${entry.status}`);
          if (entry.reason === OPEN_ROOT && data.status === 'submitted' && !has(data, 'task_id')) submittedWithoutTaskId.add(entry.tool);
          return true;
        }
        return false;
      }
      if (pair.surface !== 'async') return false;
      const entries = expectedAsync.filter((entry) => entry.schema === pair.base);
      if (!entries.some((entry) => entry.verdict.base === result.baseValid && entry.verdict.built === result.builtValid)) return false;
      const reduced = { ...data };
      for (const { field } of entries) delete reduced[field];
      const after = await score(pair, reduced);
      return after.baseValid === after.builtValid;
    }
    const tally = { tool: 0, async: 0, document: 0 };
    const unexpected = { tool: [], async: [], document: [] };
    const observed = { async: 0 };
    async function check(label, instance, data) {
      for (const pair of surfacesOf({ ...instance, data }, context)) {
        const result = await score(pair, data);
        tally[pair.surface] += 1;
        if (result.baseValid === result.builtValid) continue;
        if (await explained(pair, data, result)) {
          if (pair.surface === 'async') observed.async += 1;
          continue;
        }
        unexpected[pair.surface].push(`${label} [${pair.base} -> ${pair.built}] base ${result.baseValid}, built ${result.builtValid}: ${JSON.stringify(data).slice(0, 160)}`);
      }
    }
    const assertNoUnexpected = (what) => {
      for (const surface of Object.keys(unexpected)) {
        assert.deepEqual(unexpected[surface], [], `${what}: unexpected ${surface}-surface verdict changes`);
      }
    };

    // Each listed async difference, shown by its own vector: the minimal
    // valid instance of the status passes on both builds, and adding the one
    // field gives the listed verdicts.
    for (const entry of expectedAsync) {
      assert.equal(entry.reason, CONTRADICTION, `${entry.schema} ${entry.field}: reason`);
      const status = [...files.get(entry.tool).entries()].find(([, rel]) => rel === entry.schema)?.[0];
      assert.ok(status, `${entry.tool}: ${entry.schema} is a status file on both builds`);
      const pair = { surface: 'async', base: entry.schema, built: entry.schema };
      const control = { status, ...(status === 'submitted' ? { task_id: ENVELOPE_VALUES.task_id } : {}) };
      assert.deepEqual(await score(pair, control), { baseValid: true, builtValid: true }, `${entry.schema}: control`);
      const vector = { ...control, [entry.field]: entry.value };
      assert.deepEqual(
        await score(pair, vector),
        { baseValid: entry.verdict.base, builtValid: entry.verdict.built },
        `${entry.tool} ${entry.field}: ${entry.reason}`,
      );
      const tool = TOOLS.find((candidate) => candidate.name === entry.tool);
      const onTool = await score({ surface: 'tool', base: tool.completed_response_schema, built: tool.response_schema }, vector);
      assert.equal(onTool.baseValid, onTool.builtValid, `${entry.tool} ${entry.field}: the tool surface keeps its verdict`);
      assert.deepEqual(await score({ surface: 'tool', base: tool.completed_response_schema, built: tool.response_schema }, control), { baseValid: true, builtValid: true }, `${entry.tool}: tool-surface control`);
    }
    t.diagnostic(`${expectedAsync.length} listed async-surface differences, each shown by its vector`);

    // The repository corpus.
    const instances = collectResponseInstances(REPO_ROOT);
    assert.ok(instances.length > 500, `collected only ${instances.length} response instances`);
    for (const instance of instances) await check(instance.id, instance, instance.data);
    t.diagnostic(`corpus: ${instances.length} instances; scored ${tally.tool} tool, ${tally.async} async, ${tally.document} document`);
    assertNoUnexpected('corpus');

    // Single-fault vectors: a repository response instance valid on both
    // sides of a surface, with one envelope field changed. The vector
    // differs from its control in that field alone, so equal verdicts show
    // that neither build constrains the field differently.
    let vectors = 0;
    const changed = [];
    for (const instance of instances) {
      if (!instance.data || typeof instance.data !== 'object' || Array.isArray(instance.data)) continue;
      if (!isResponseInstance(instance)) continue;
      for (const pair of surfacesOf(instance, context)) {
        const control = await score(pair, instance.data);
        if (!control.baseValid || !control.builtValid) continue;
        for (const [field, perturb] of Object.entries(ENVELOPE_PERTURBATIONS)) {
          const result = await score(pair, perturb(instance.data));
          vectors += 1;
          if (result.baseValid !== result.builtValid) changed.push(`${instance.id} ${pair.surface} ${field}: base ${result.baseValid}, built ${result.builtValid}`);
        }
      }
    }
    t.diagnostic(`${vectors} single-fault envelope vectors`);
    assert.ok(vectors > 100, `only ${vectors} envelope vectors ran`);
    assert.deepEqual(changed, [], 'an envelope field is constrained differently');

    // The status matrix: for every tool and every task status, a minimal
    // instance (the status; a submitted one with and without task_id) and,
    // for each branch of the base's tool response and of its status files,
    // an instance with the fields that branch requires; each also with an
    // empty errors array. Every instance is scored on the tool surface, and
    // on the async surface when the base had a file for its status.
    let matrixRuns = 0;
    for (const tool of TOOLS) {
      const baseDocuments = [tool.completed_response_schema, ...files.get(tool.name).values()];
      const requiredSets = [{}];
      for (const rel of baseDocuments) {
        const document = readJson(path.join(base.dir, rel));
        const nodes = [document, ...['oneOf', 'anyOf'].flatMap((keyword) => document[keyword] || [])];
        for (const node of nodes) {
          if (!node || typeof node !== 'object' || node.$ref) continue;
          const fields = {};
          for (const name of node.required || []) {
            if (name === 'status') continue;
            const declaration = node.properties?.[name] ?? document.properties?.[name];
            fields[name] = matrixValue(name, declaration);
          }
          requiredSets.push(fields);
        }
      }
      for (const status of statuses) {
        for (const fields of requiredSets) {
          for (const errors of [undefined, []]) {
            // A submitted instance runs with task_id and without it: the base
            // tool response of a task with no submitted body accepts either.
            for (const taskId of status === 'submitted' ? [ENVELOPE_VALUES.task_id, undefined] : [undefined]) {
              const data = { ...fields, status, ...(taskId ? { task_id: taskId } : {}) };
              if (errors) data.errors = errors;
              await check(`matrix:${tool.name}:${status}`, { schema: tool.response_schema }, data);
              matrixRuns += 1;
            }
          }
        }
      }
    }
    // Status transplants: every repository tool response, with its status
    // replaced by each task status (a submitted one with and without
    // task_id), so real bodies run under every status.
    for (const instance of instances) {
      const tool = TOOLS.find((t) => instance.schema === t.response_schema || instance.schema === t.completed_response_schema);
      if (!tool || !instance.data || typeof instance.data !== 'object' || Array.isArray(instance.data)) continue;
      for (const status of statuses) {
        const data = { ...instance.data, status };
        await check(`transplant:${instance.id}:${status}`, { schema: tool.response_schema }, data);
        matrixRuns += 1;
        if (status === 'submitted' && !data.task_id) {
          await check(`transplant:${instance.id}:${status}`, { schema: tool.response_schema }, { ...data, task_id: ENVELOPE_VALUES.task_id });
          matrixRuns += 1;
        }
      }
    }
    t.diagnostic(`${matrixRuns} status-matrix instances; ${observed.async} async-surface differences matched a listed entry`);
    assert.ok(matrixRuns > TOOLS.length * statuses.length * 2, `only ${matrixRuns} matrix instances ran`);
    assertNoUnexpected('matrix');
    // Every listed tool-surface difference occurred.
    assert.deepEqual(
      expectedTool.map((e) => `${e.reason}|${e.tool} ${e.status}`).filter((key) => !observedTool.has(key)),
      [],
      'listed tool-surface differences that no instance showed',
    );
    t.diagnostic(`${expectedTool.length} listed tool-surface differences, each observed`);
    t.diagnostic(`${submittedWithoutTaskId.size} tasks with no submitted body whose base accepted a submitted response without task_id`);
  } finally {
    base.cleanup?.();
  }
});
