#!/usr/bin/env node
/**
 * Schema-path lint: one schema, one path, one name (#8903).
 *
 * Rules (each finding carries one rule code):
 *
 *   id-not-path                 root $id is not /schemas/<path relative to the source root>
 *   path-not-kebab              a path segment is not kebab-case
 *   version-in-path             a directory segment is a version (vN); versions live in the
 *                               published URL prefix, not in the source path
 *   name-in-two-directories     the same file name is used in two directories
 *   title-not-name              the root title and the file name do not say the same words
 *                               (case and punctuation ignored)
 *   index-section-not-directory an index.json entry lives outside the directory named by its
 *                               section
 *   task-file-name              an index.json task's request/response file is not
 *                               <task>-request.json / <task>-response.json
 *   task-in-two-directories     two directories both hold <task>-request.json
 *   task-directory-not-a-protocol
 *                               a registered task lives outside core/ and outside the directory
 *                               of a protocol named in enums/adcp-protocol.json
 *   message-file-not-registered a *-request.json / *-response.json file is not the request or
 *                               response of a task registered in index.json
 *   same-schema-two-paths       two whole files define the same schema (equal once annotations
 *                               are removed; x- keywords such as x-entity are kept). A task's
 *                               registered messages are its own schemas and are not compared
 *                               with each other.
 *   ref-relative                a $ref is a relative path
 *   ref-absolute-url            a $ref is an absolute URL (source refs are /schemas/<path>)
 *   ref-into-other-file         a $ref points inside another file (/schemas/<path>#/...);
 *                               a schema used from another file gets its own path
 *   ref-local-not-defs          a local $ref is not #/$defs/<name>
 *   definitions-keyword         a "definitions" block (4.0 uses the "$defs" keyword)
 *
 * id-not-path has no finding on main, so it holds for every schema from now on.
 *
 * A moved file leaves an alias at its old path: a root schema whose only keywords, apart
 * from $id, $schema, title, description and $comment, are `allOf: [{ "$ref": "<new path>" }]`
 * (one /schemas/<path> ref to a file in the tree), `deprecated: true`, `x-deprecated-in` and
 * `x-removed-in`. An alias is checked by id-not-path and the $ref rules only, so the old URL
 * keeps resolving without a finding at the old path.
 *
 * Existing findings are in lint-schema-paths-baseline.json. A new finding fails.
 */

'use strict';

const path = require('node:path');
const { escapePointerToken, isSchema, loadSchemaTree, runCli, walkSchema } = require('./schema-convention-lint.cjs');

const DEFAULT_BASELINE_PATH = path.join(__dirname, 'lint-schema-paths-baseline.json');
const PROTOCOL_ENUM_PATH = 'enums/adcp-protocol.json';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_SEGMENT = /^v\d+$/;
const MESSAGE_FILE = /-(request|response)\.json$/;
const ASYNC_MESSAGE_FILE = /^(.+)-async-response-[a-z0-9-]+\.json$/;
const ANNOTATIONS = new Set(['$id', '$schema', 'title', 'description', '$comment', 'examples', 'x-tool-summary']);
const ALIAS_ANNOTATIONS = new Set(['$id', '$schema', 'title', 'description', '$comment']);

function visitSchemas(node, pointer, visit) {
  for (const entry of walkSchema(node, pointer)) visit(entry.node, entry.pointer);
}

function canonicalSchema(value) {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (isSchema(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!ANNOTATIONS.has(key)) out[key] = canonicalSchema(value[key]);
    }
    return out;
  }
  return value;
}

/** True when `schema` is an alias left at a moved file's old path (see the header). */
function isAlias(schema, documents) {
  if (!isSchema(schema)) return false;
  const keys = Object.keys(schema).filter((key) => !ALIAS_ANNOTATIONS.has(key)).sort();
  if (keys.join(' ') !== 'allOf deprecated x-deprecated-in x-removed-in') return false;
  if (schema.deprecated !== true) return false;
  if (typeof schema['x-deprecated-in'] !== 'string' || typeof schema['x-removed-in'] !== 'string') return false;
  if (!Array.isArray(schema.allOf) || schema.allOf.length !== 1) return false;
  const [branch] = schema.allOf;
  if (!isSchema(branch) || Object.keys(branch).join(' ') !== '$ref' || typeof branch.$ref !== 'string') return false;
  const match = branch.$ref.match(/^\/schemas\/([^#]+)$/);
  return Boolean(match) && documents.has(match[1]);
}

function nameWords(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** index.json tasks/operations: [{section, key, request, response, pointer}] */
function registeredTasks(index) {
  const tasks = [];
  if (!isSchema(index) || !isSchema(index.schemas)) return tasks;
  for (const [section, body] of Object.entries(index.schemas)) {
    for (const kind of ['tasks', 'operations']) {
      if (!isSchema(body[kind])) continue;
      for (const [key, entry] of Object.entries(body[kind])) {
        const strip = (ref) => (typeof ref === 'string' ? ref.replace(/^\/schemas\//, '') : null);
        tasks.push({
          section,
          key,
          pointer: `/schemas/${escapePointerToken(section)}/${kind}/${escapePointerToken(key)}`,
          request: strip(entry && entry.request && entry.request.$ref),
          response: strip(entry && entry.response && entry.response.$ref),
        });
      }
    }
  }
  return tasks;
}

// ------------------------------------------------------------------ rules

function collectFindings(registry) {
  const findings = [];
  const add = (rule, file, pointer, message) => {
    findings.push({ rule, path: `${file}#${pointer || ''}`, file, pointer: pointer || '', message });
  };
  const { documents } = registry;
  const files = [...documents.keys()];
  const index = documents.get('index.json');
  const tasks = registeredTasks(index);
  const aliases = new Set(files.filter((rel) => isAlias(documents.get(rel), documents)));

  // Identity and naming.
  const byName = new Map();
  for (const [rel, schema] of documents) {
    if (!isSchema(schema)) continue;
    if (schema.$id !== `/schemas/${rel}`) {
      add('id-not-path', rel, '/$id', `$id is ${JSON.stringify(schema.$id)}, expected "/schemas/${rel}"`);
    }
    if (aliases.has(rel)) continue;
    const segments = rel.replace(/\.json$/, '').split('/');
    const notKebab = segments.filter((s) => !KEBAB.test(s));
    if (notKebab.length) add('path-not-kebab', rel, '', `segment(s) ${notKebab.join(', ')} are not kebab-case`);
    if (segments.slice(0, -1).some((s) => VERSION_SEGMENT.test(s))) {
      add('version-in-path', rel, '', 'a version directory in the source path');
    }
    const base = path.posix.basename(rel);
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(rel);
    const stem = base.replace(/\.json$/, '');
    if (typeof schema.title === 'string' && nameWords(schema.title) !== nameWords(stem)) {
      add('title-not-name', rel, '/title', `title "${schema.title}" vs file name "${stem}"`);
    }
  }
  for (const [base, rels] of byName) {
    if (rels.length < 2) continue;
    for (const rel of rels) {
      add('name-in-two-directories', rel, '', `${base} is also ${rels.filter((r) => r !== rel).join(', ')}`);
    }
  }

  // Registry placement: every index.json $ref lives in its section's directory.
  if (isSchema(index) && isSchema(index.schemas)) {
    for (const [section, body] of Object.entries(index.schemas)) {
      const visit = (node, pointer) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.$ref === 'string' && node.$ref.startsWith('/schemas/')) {
          const rel = node.$ref.slice('/schemas/'.length);
          const dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
          if (dir !== section) {
            add('index-section-not-directory', 'index.json', `${pointer}/$ref`,
              `section "${section}" lists ${rel}`);
          }
        }
        for (const [k, v] of Object.entries(node)) {
          if (v && typeof v === 'object') visit(v, `${pointer}/${escapePointerToken(k)}`);
        }
      };
      visit(body, `/schemas/${escapePointerToken(section)}`);
    }
  }

  // Tasks: the file name is the task name; one directory per task; every
  // request/response file is a registered task message.
  const messageFiles = new Set();
  const taskDirs = new Map();
  for (const t of tasks) {
    for (const [role, rel] of [['request', t.request], ['response', t.response]]) {
      if (!rel) {
        add('task-file-name', 'index.json', t.pointer, `${t.key} has no ${role} $ref`);
        continue;
      }
      messageFiles.add(rel);
      if (path.posix.basename(rel) !== `${t.key}-${role}.json`) {
        add('task-file-name', 'index.json', `${t.pointer}/${role}/$ref`, `${t.key} ${role} is ${rel}`);
      }
    }
    if (t.request) {
      if (!taskDirs.has(t.key)) taskDirs.set(t.key, new Set());
      taskDirs.get(t.key).add(path.posix.dirname(t.request));
    }
  }
  for (const rel of files) {
    if (aliases.has(rel)) continue;
    const base = path.posix.basename(rel);
    if (!base.endsWith('-request.json')) continue;
    const key = base.replace(/-request\.json$/, '');
    if (!taskDirs.has(key)) continue;
    taskDirs.get(key).add(path.posix.dirname(rel));
  }
  for (const [key, dirs] of taskDirs) {
    if (dirs.size < 2) continue;
    for (const dir of dirs) {
      add('task-in-two-directories', `${dir}/${key}-request.json`, '',
        `${key} also has request files in ${[...dirs].filter((d) => d !== dir).join(', ')}`);
    }
  }
  for (const rel of files) {
    if (MESSAGE_FILE.test(rel) && !messageFiles.has(rel) && !aliases.has(rel)) {
      add('message-file-not-registered', rel, '', 'request/response file that is not a registered task message');
    }
  }
  // A task lives in the directory of the protocol that owns it, or in core
  // when every protocol shares it. The protocols are the values of
  // enums/adcp-protocol.json.
  const protocolSchema = documents.get(PROTOCOL_ENUM_PATH);
  const owners = new Set(['core'].concat(protocolSchema && Array.isArray(protocolSchema.enum) ? protocolSchema.enum : []));
  for (const t of tasks) {
    if (!t.request || !documents.has(t.request)) continue;
    const dir = t.request.split('/')[0];
    if (!owners.has(dir)) {
      add('task-directory-not-a-protocol', t.request, '',
        `${dir}/ is not a value of ${PROTOCOL_ENUM_PATH} and is not core`);
    }
  }

  // Same schema at two paths.
  const taskOf = (rel) => {
    if (messageFiles.has(rel)) return rel.replace(MESSAGE_FILE, '');
    const m = path.posix.basename(rel).match(ASYNC_MESSAGE_FILE);
    if (m) {
      const owner = `${path.posix.dirname(rel)}/${m[1]}`;
      if (messageFiles.has(`${owner}-request.json`)) return owner;
    }
    return null;
  };
  const groups = new Map();
  for (const [rel, schema] of documents) {
    if (rel === 'index.json' || aliases.has(rel)) continue;
    const key = JSON.stringify(canonicalSchema(schema));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rel);
  }
  for (const rels of groups.values()) {
    if (rels.length < 2) continue;
    const owned = rels.filter((r) => taskOf(r));
    const notOwned = rels.filter((r) => !taskOf(r));
    if (notOwned.length === 0) continue; // every copy is some task's own message
    for (const rel of notOwned.concat(owned)) {
      add('same-schema-two-paths', rel, '', `same schema as ${rels.filter((r) => r !== rel).join(', ')}`);
    }
  }

  // $ref form and the definitions keyword.
  for (const [rel, schema] of documents) {
    if (rel === 'index.json') continue;
    visitSchemas(schema, '', (node, pointer) => {
      if (isSchema(node.definitions)) {
        add('definitions-keyword', rel, `${pointer}/definitions`, 'use "$defs"');
      }
      if (typeof node.$ref !== 'string') return;
      const ref = node.$ref;
      const at = `${pointer}/$ref`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
        add('ref-absolute-url', rel, at, `${ref}: source refs are /schemas/<path>`);
      } else if (ref.startsWith('/schemas/')) {
        if (ref.includes('#') && ref.slice(ref.indexOf('#')) !== '#') {
          add('ref-into-other-file', rel, at, `${ref}: reference the file root; give the target its own file`);
        }
      } else if (ref.startsWith('#')) {
        if (!/^#\/(\$defs|definitions)\/[^/]+$/.test(ref)) {
          add('ref-local-not-defs', rel, at, `${ref}: local refs are #/$defs/<name>`);
        }
      } else {
        add('ref-relative', rel, at, `${ref}: use /schemas/<path>`);
      }
    });
  }

  const seen = new Set();
  return findings
    .filter((f) => {
      const k = `${f.rule} ${f.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => `${a.rule} ${a.path}`.localeCompare(`${b.rule} ${b.path}`));
}


function lintSchemaPaths({ schemasDir } = {}) {
  const tree = loadSchemaTree(schemasDir);
  const registry = { documents: new Map(tree.documents.map((document) => [document.relativePath, document.schema])) };
  const findings = collectFindings(registry).map((finding) => ({
    rule: finding.rule,
    site: finding.path,
    message: finding.message,
  }));
  return {
    findings,
    errors: tree.parseErrors.map((error) => `schema parse error: ${error}`),
    report: [`${tree.documents.length} schema files`],
  };
}

module.exports = { DEFAULT_BASELINE_PATH, canonicalSchema, collectFindings, isAlias, lintSchemaPaths, registeredTasks };

if (require.main === module) {
  process.exitCode = runCli({
    name: 'schema-path lint',
    defaultBaselinePath: DEFAULT_BASELINE_PATH,
    baselineComment: 'Schemas whose path, name or $ref form breaks the one-path rule (scripts/lint-schema-paths.cjs, #8903). A new finding fails. Fixes that move no file land in 4.0.0; moves land in 4.x with an alias at the old path.',
    lint: lintSchemaPaths,
  });
}
