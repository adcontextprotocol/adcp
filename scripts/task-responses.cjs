'use strict';

/**
 * Generate each task's response from its status bodies.
 *
 * A task response is the protocol envelope plus one body. Every body composes
 * `core/protocol-envelope.json` through its root `allOf` and declares no
 * envelope field; the envelope declares them all, `status` included. The
 * file name says which status a body serves:
 *
 *   <task>-completed.json                      completed
 *   <task>-async-response-<status>.json        submitted, working, input-required
 *   <task>-<status>.json                       rejected, failed, ...
 *
 * The build generates `<protocol>/<task>-response.json` for every task: a
 * `oneOf` discriminated by `status`, with one branch per status that has a
 * body and one per status the task's response admitted before the bodies
 * were split (scripts/task-response-statuses.json, derived from that tree by
 * scripts/derive-task-response-statuses.cjs). Like every task response before
 * the split, the response composes the protocol envelope at its root. Each
 * branch requires `status` and pins it to the branch's own value, so the
 * branches are disjoint, and requires what its status's own body requires at
 * its root (a failed response carries the failed body's `errors`). A
 * status the response admitted only through a branch or a condition that
 * named it composes its body. A status the response admitted openly, through
 * its open root or a branch that left `status` open, keeps that rule: its
 * branch composes any of its own body and the body that holds that content
 * now, the completed body for the response's success content and the
 * `<task>-failed.json` body for an error branch's. A status with a body that
 * the response did not admit (a working payload on the async channel, say)
 * composes its body. A status with neither has no branch. The status consts appear only in this
 * generated output.
 *
 * A failed response is the task's error schema (DR-0038). `core/task-error.json`
 * states the rule once: it requires `errors`, the task-level error list the
 * protocol envelope defines. A body built on it (the shared schema itself, or
 * a body that composes it through its root `allOf`) is an error body, and its
 * branch requires what the shared schema requires. A task's failed body is its
 * `<task>-failed.json`, which composes the shared schema and adds only what
 * is specific to the task's errors. In 3.x the rule covers experimental task
 * responses (the completed body's `x-status: experimental`): such a task
 * without a failed body of its own takes the shared schema as its failed body,
 * and an error body's branch composes that body alone, whatever content the
 * status admitted before. A stable task keeps what its response admitted
 * until 4.0 applies the rule to every task. `<task>-response.json` is
 * the task's response for every outcome, the schema `index.json` and the
 * manifest name for the task.
 *
 * Bodies that two tasks share follow the same naming
 * (`media-buy/media-buy-commitment-completed.json`, `-failed.json`, ...), and
 * the build generates their response (`media-buy-commitment-response.json`)
 * the same way: every `<name>-completed.json` in the tree gets a
 * `<name>-response.json`.
 *
 * Generated documents are read like source documents: `readSourceSchemaDocument`
 * returns the file on disk, or the generated document at that path. The flat
 * tree, the bundled tree and the MCP projection publish them.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SOURCE_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');
const PROTOCOL_ENVELOPE_REF = '/schemas/core/protocol-envelope.json';
const COMPLETED_STATUS = 'completed';
const FAILED_STATUS = 'failed';
// The error schema every failed response composes (DR-0038).
const TASK_ERROR_REL = 'core/task-error.json';
const COMPLETED_BODY_SUFFIX = '-completed.json';
const TASK_RESPONSE_SUFFIX = '-response.json';
// Root annotations of the completed body that describe the task response as
// a whole, so the generated response carries them too.
const TASK_ANNOTATIONS = ['deprecated', 'x-status', 'x-added-in', 'x-deprecated-in'];
// The statuses each task's response admitted before the bodies were split.
const ADMITTED_STATUSES = readJson(path.join(__dirname, 'task-response-statuses.json'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The task statuses, or null for a tree without the task-status enum (a test fixture, say). */
function taskStatuses(sourceDir) {
  const file = path.join(sourceDir, 'enums', 'task-status.json');
  return fs.existsSync(file) ? readJson(file).enum : null;
}

/**
 * True when the shared error schema covers the task in 3.x: its completed
 * body is experimental. 4.0 applies the rule to every task.
 */
function errorSchemaCovers(sourceDir, protocol, toolBase) {
  const file = path.join(sourceDir, protocol, `${toolBase}${COMPLETED_BODY_SUFFIX}`);
  return fs.existsSync(path.join(sourceDir, TASK_ERROR_REL))
    && fs.existsSync(file)
    && readJson(file)['x-status'] === 'experimental';
}

/**
 * True when a body is an error body: the shared error schema, or a document
 * that composes it through its root `allOf`, directly or through a document
 * that does.
 */
function isErrorBody(sourceDir, rel, seen = new Set()) {
  if (rel === TASK_ERROR_REL) return true;
  if (seen.has(rel)) return false;
  seen.add(rel);
  const file = path.join(sourceDir, ...rel.split('/'));
  if (!fs.existsSync(file)) return false;
  return (readJson(file).allOf || []).some((member) => member && typeof member.$ref === 'string'
    && member.$ref.startsWith('/schemas/') && !member.$ref.includes('#')
    && isErrorBody(sourceDir, member.$ref.slice('/schemas/'.length), seen));
}

/** Source-relative path of a task's completed body (`media-buy/create-media-buy-completed.json`). */
function completedBodyRel(protocol, toolBase) {
  return `${protocol}/${toolBase}${COMPLETED_BODY_SUFFIX}`;
}

/** Source-relative path of a task's generated response (`media-buy/create-media-buy-response.json`). */
function taskResponseRel(protocol, toolBase) {
  return `${protocol}/${toolBase}${TASK_RESPONSE_SUFFIX}`;
}

/**
 * The status bodies of a task, in task-status enum order: each entry names a
 * status and, in `schema`, the source-relative path of its body. A status
 * without a body is left out, and a tree without the task-status enum has
 * none. A task the shared error schema covers and that has no failed body of
 * its own takes `core/task-error.json` as its failed body. `toolBase` is the
 * kebab-case task name (`create-media-buy`).
 */
function taskStatusSchemas(sourceDir, protocol, toolBase) {
  const statuses = taskStatuses(sourceDir);
  if (!statuses) return [];
  const out = [];
  for (const status of statuses) {
    const names = status === COMPLETED_STATUS
      ? [`${toolBase}${COMPLETED_BODY_SUFFIX}`]
      : [`${toolBase}-async-response-${status}.json`, `${toolBase}-${status}.json`];
    const found = names.filter((name) => fs.existsSync(path.join(sourceDir, protocol, name)));
    if (found.length > 1) {
      throw new Error(`${protocol}/${toolBase}: status ${status} has more than one body: ${found.join(', ')}`);
    }
    if (status === COMPLETED_STATUS && !found.length) {
      throw new Error(`${protocol}/${toolBase}: no completed body (${toolBase}${COMPLETED_BODY_SUFFIX})`);
    }
    if (found.length) out.push({ status, schema: `${protocol}/${found[0]}` });
    else if (status === FAILED_STATUS && errorSchemaCovers(sourceDir, protocol, toolBase)) out.push({ status, schema: TASK_ERROR_REL });
  }
  return out;
}

function titleCase(toolBase) {
  return toolBase.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** The generated response of one task, or of a body family that tasks share. */
function buildTaskResponseSchema(sourceDir, protocol, toolBase) {
  const toolName = toolBase.replace(/-/g, '_');
  const isTask = fs.existsSync(path.join(sourceDir, protocol, `${toolBase}-request.json`));
  const subject = isTask ? `${toolName} response` : `response composed from the shared ${toolBase} bodies`;
  const statuses = taskStatusSchemas(sourceDir, protocol, toolBase);
  const withBody = new Set(statuses.map(({ status }) => status));
  const before = ADMITTED_STATUSES[`${protocol}/${toolBase}`] || { admitted: [], open: {} };
  const admittedBefore = new Set(before.admitted);
  const openBefore = new Map(Object.entries(before.open));
  const branchStatuses = taskStatuses(sourceDir).filter((status) => withBody.has(status) || admittedBefore.has(status));
  // What a status's own body requires at its root, and, for an error body,
  // what the shared error schema requires.
  const rootRequired = (rel) => {
    const body = readJson(path.join(sourceDir, ...rel.split('/')));
    return (Array.isArray(body.required) ? body.required : []).filter((name) => name !== 'status');
  };
  const ownRequired = (rel) => [...new Set([
    ...rootRequired(rel),
    ...(isErrorBody(sourceDir, rel) ? rootRequired(TASK_ERROR_REL) : []),
  ])];
  // In 3.x an error body of a task the shared error schema covers is its
  // status's whole response: the branch composes that body alone.
  const covered = errorSchemaCovers(sourceDir, protocol, toolBase);
  const closes = (own) => Boolean(own) && covered && isErrorBody(sourceDir, own.schema);
  // The statuses whose branch keeps the content the response admitted openly.
  const openStatuses = branchStatuses.filter((status) => openBefore.has(status)
    && !closes(statuses.find((entry) => entry.status === status)));
  // The body that holds each kind of content the response admitted openly:
  // its success content is the completed body, an error branch's content the
  // failed body (or the completed body, for a task without one).
  const bodyOf = (status) => statuses.find((entry) => entry.status === status)?.schema;
  const contentBody = { completed: bodyOf('completed'), failed: bodyOf('failed') || bodyOf('completed') };
  const completed = readJson(path.join(sourceDir, ...completedBodyRel(protocol, toolBase).split('/')));
  // The completed body is titled `<Task> - Completed`; the task response
  // takes the task's response title, `<Task> Response`.
  const branchTitle = titleCase(toolBase);
  const title = typeof completed.title === 'string' && completed.title.includes(' - Completed')
    ? completed.title.replace(' - Completed', ' Response')
    : `${branchTitle} Response`;
  const annotations = Object.fromEntries(TASK_ANNOTATIONS.filter((key) => key in completed).map((key) => [key, completed[key]]));
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `/schemas/${taskResponseRel(protocol, toolBase)}`,
    title,
    description: `Every ${subject}, discriminated by the envelope \`status\`. `
      + 'Generated by the schema build from the status bodies: one branch per status that has a body or that the '
      + 'response admitted before the bodies were split, with `status` set to the branch\'s value. '
      + `A status without a branch is not valid here. Status bodies, each composing the protocol envelope: `
      + `${statuses.map(({ status, schema }) => `${status} (${schema})`).join(', ')}.`
      + (openStatuses.length
        ? ` A status the response admitted without pinning it (${openStatuses.join(', ')}) `
          + 'also composes the body that holds the content it admitted then.'
        : ''),
    ...annotations,
    type: 'object',
    // Like every task response before the bodies were split, the response
    // composes the protocol envelope at its root; each body composes it too.
    allOf: [{ $ref: PROTOCOL_ENVELOPE_REF }],
    discriminator: { propertyName: 'status' },
    oneOf: branchStatuses.map((status) => {
      const own = statuses.find((entry) => entry.status === status);
      const kinds = closes(own) ? [] : openBefore.get(status) || (own ? [] : ['completed']);
      const members = [...new Set([...(own ? [own.schema] : []), ...kinds.map((kind) => contentBody[kind])])];
      return {
        title: `${branchTitle} ${status}`,
        ...(own && members.length === 1
          ? { allOf: [{ $ref: `/schemas/${own.schema}` }] }
          : { anyOf: members.map((schema) => ({ $ref: `/schemas/${schema}` })) }),
        properties: { status: { type: 'string', const: status } },
        // The names the status's own body requires at its root, and the
        // shared error schema's for an error body (a failed response's
        // errors), hold for every response with that status.
        required: ['status', ...(own ? ownRequired(own.schema) : [])],
      };
    }),
    'x-generated': {
      by: 'scripts/task-responses.cjs',
      status_schemas: Object.fromEntries(statuses.map(({ status, schema }) => [status, schema])),
      ...(openStatuses.length ? { open_statuses: Object.fromEntries(openStatuses.map((status) => [status, openBefore.get(status).map((kind) => contentBody[kind])])) } : {}),
    },
  };
}

const generatedBySourceDir = new Map();

/**
 * The documents the build generates for a source tree, keyed by
 * source-relative path: one response per completed body, so one per task
 * and one per body family that tasks share. Empty for a tree without the
 * protocol envelope or the task-status enum, such as a test fixture.
 */
function generatedSchemaDocuments(sourceDir) {
  const key = path.resolve(sourceDir);
  if (!generatedBySourceDir.has(key)) {
    const documents = new Map();
    generatedBySourceDir.set(key, documents);
    const usable = [PROTOCOL_ENVELOPE_REF, '/schemas/enums/task-status.json']
      .every((ref) => fs.existsSync(path.join(key, ref.slice('/schemas/'.length))));
    if (usable) {
      for (const entry of fs.readdirSync(key, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const names = fs.readdirSync(path.join(key, entry.name)).filter((name) => name.endsWith(COMPLETED_BODY_SUFFIX)).sort();
        for (const name of names) {
          const toolBase = name.slice(0, -COMPLETED_BODY_SUFFIX.length);
          const rel = taskResponseRel(entry.name, toolBase);
          if (fs.existsSync(path.join(key, rel))) {
            throw new Error(`${rel} is generated from ${entry.name}/${name}; remove the file on disk`);
          }
          documents.set(rel, buildTaskResponseSchema(key, entry.name, toolBase));
        }
      }
    }
  }
  return generatedBySourceDir.get(key);
}

/**
 * The generated response for one source-relative path (`<protocol>/<task>-response.json`),
 * built from the task's status bodies, or undefined when the path names no
 * task's generated response (a response document on disk, for example).
 * Needs only the source tree, not the tool manifest, so a reader that cannot
 * load the build (no installed dependencies) uses it.
 */
function taskResponseSchemaFor(sourceDir, rel) {
  const match = /^([^/]+)\/(.+)-response\.json$/.exec(rel);
  if (!match) return undefined;
  const [, protocol, toolBase] = match;
  if (fs.existsSync(path.join(sourceDir, rel))) return undefined;
  if (!fs.existsSync(path.join(sourceDir, protocol, `${toolBase}${COMPLETED_BODY_SUFFIX}`))) return undefined;
  if (!taskStatuses(sourceDir)) return undefined;
  return buildTaskResponseSchema(sourceDir, protocol, toolBase);
}

/** The generated document at an absolute path in a source tree, or undefined. */
function generatedSchemaAt(filePath, sourceDir) {
  const rel = path.relative(path.resolve(sourceDir), path.resolve(filePath)).split(path.sep).join('/');
  if (!rel.endsWith(TASK_RESPONSE_SUFFIX)) return undefined;
  return generatedSchemaDocuments(sourceDir).get(rel);
}

/** A source document as written, or the generated document at that path. */
function readSourceSchemaDocument(filePath, sourceDir) {
  if (!fs.existsSync(filePath)) {
    const generated = generatedSchemaAt(filePath, sourceDir);
    if (generated) return structuredClone(generated);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * A JSON file as written, or, for a path in the repository's source tree that
 * the build generates, the generated document: a drop-in for
 * `JSON.parse(fs.readFileSync(file, 'utf8'))` that also serves every task's
 * `<task>-response.json`.
 */
function readSchemaFile(filePath) {
  return readSourceSchemaDocument(filePath, DEFAULT_SOURCE_DIR);
}

/** True when a source document exists on disk or is generated by the build. */
function sourceSchemaExists(filePath, sourceDir) {
  return fs.existsSync(filePath) || generatedSchemaAt(filePath, sourceDir) !== undefined;
}

module.exports = {
  COMPLETED_BODY_SUFFIX,
  TASK_RESPONSE_SUFFIX,
  buildTaskResponseSchema,
  TASK_ERROR_REL,
  completedBodyRel,
  errorSchemaCovers,
  generatedSchemaDocuments,
  isErrorBody,
  readSchemaFile,
  readSourceSchemaDocument,
  sourceSchemaExists,
  taskResponseRel,
  taskResponseSchemaFor,
  taskStatusSchemas,
};
