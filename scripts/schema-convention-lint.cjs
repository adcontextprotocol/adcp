'use strict';

/**
 * Shared loader, schema walker and baseline ratchet for the schema convention
 * lints:
 *
 *   lint-enum-values.cjs          enum values usable as identifiers (#8901)
 *   lint-property-names.cjs       one naming convention for properties (#8902)
 *   lint-schema-paths.cjs         one rule for a schema's path, name and $id (#8903)
 *   lint-value-lists.cjs          one form for value lists (#9002)
 *   lint-x-adcp-validation.cjs    the x-adcp-validation vocabulary (#8472)
 *
 * Each lint reports every finding and fails only on a finding that its
 * committed baseline doesn't list, or on a baseline entry that no longer
 * occurs. So the baseline only shrinks unless a reviewer accepts a new entry,
 * and no schema changes for a lint to land.
 *
 * Baseline file shape:
 *
 *   { "$comment": "...", "entries": [ { "rule": "...", "site": "...", ... } ] }
 *
 * `rule` and `site` identify an entry. Other fields (a rationale, a value) are
 * kept when the baseline is rewritten with --update-baseline.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const SCHEMA_ORIGIN = 'https://adcontextprotocol.org';

// Keywords whose values are subschemas. Everything else (enum, const,
// default, examples, x-*) is data and is never walked as a schema.
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
const SCHEMA_SINGLE_KEYS = [
  'additionalProperties',
  'additionalItems',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function escapePointerToken(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerToken(value) {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function isSchema(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walkJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath);
  }
  return files.sort();
}

/** Loads every JSON file under `schemasDir`, keyed by its path relative to it. */
function loadSchemaTree(schemasDir = DEFAULT_SCHEMAS_DIR) {
  const documents = [];
  const byPath = new Map();
  const parseErrors = [];
  for (const file of walkJsonFiles(schemasDir)) {
    const relativePath = toPosix(path.relative(schemasDir, file));
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      parseErrors.push(`${relativePath}: ${error.message}`);
      continue;
    }
    const document = { relativePath, schema };
    documents.push(document);
    byPath.set(relativePath, document);
  }
  return { schemasDir, documents, byPath, parseErrors };
}

function resolvePointer(root, fragment) {
  if (!fragment || fragment === '#') return root;
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!body.startsWith('/')) return undefined;
  let current = root;
  for (const token of body.slice(1).split('/')) {
    const key = unescapePointerToken(token);
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Resolves a `$ref` from `fromDocument`: `/schemas/<path>`, `/schemas/latest/`
 * and `https://adcontextprotocol.org/schemas/<path>` refs, relative refs and
 * local `#/...` refs. A ref pinned to a release (`/schemas/3.2.1/...`) or to
 * another origin resolves to null.
 */
function resolveRef(ref, fromDocument, tree) {
  if (typeof ref !== 'string') return null;
  const hashIndex = ref.indexOf('#');
  const base = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex);
  let document = fromDocument;
  if (base) {
    // Match the origin with its path slash, so a host that only starts with it stays foreign.
    let key = base.startsWith(`${SCHEMA_ORIGIN}/`) ? base.slice(SCHEMA_ORIGIN.length) : base;
    if (/^[a-z][a-z0-9+.-]*:/i.test(key)) return null;
    if (key.startsWith('/schemas/')) {
      key = key.replace(/^\/schemas\/(?:latest\/)?/, '');
    } else if (!key.startsWith('/')) {
      key = path.posix.normalize(path.posix.join(path.posix.dirname(fromDocument.relativePath), key));
    } else {
      return null;
    }
    document = tree.byPath.get(key);
  }
  if (!document) return null;
  const node = resolvePointer(document.schema, fragment);
  return node === undefined ? null : { document, node, fragment };
}

/**
 * Yields every subschema of `node`, depth first, as { node, pointer, ancestors }.
 * `pointer` is a JSON Pointer from the document root ('' for the root);
 * `ancestors` lists the enclosing subschemas, outermost first.
 */
function* walkSchema(node, pointer = '', ancestors = []) {
  if (!isSchema(node)) return;
  yield { node, pointer, ancestors };
  const next = ancestors.concat([{ node, pointer }]);
  for (const key of SCHEMA_MAP_KEYS) {
    if (!isSchema(node[key])) continue;
    for (const [name, child] of Object.entries(node[key])) {
      yield* walkSchema(child, `${pointer}/${key}/${escapePointerToken(name)}`, next);
    }
  }
  for (const key of SCHEMA_SINGLE_KEYS) {
    if (isSchema(node[key])) {
      yield* walkSchema(node[key], `${pointer}/${key}`, next);
    } else if (Array.isArray(node[key])) {
      for (let i = 0; i < node[key].length; i += 1) yield* walkSchema(node[key][i], `${pointer}/${key}/${i}`, next);
    }
  }
  for (const key of SCHEMA_ARRAY_KEYS) {
    if (!Array.isArray(node[key])) continue;
    for (let i = 0; i < node[key].length; i += 1) yield* walkSchema(node[key][i], `${pointer}/${key}/${i}`, next);
  }
}

// ---------------------------------------------------------------------------
// Baseline ratchet

const entryKey = (entry) => `${entry.rule} ${entry.site}`;

function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return { comment: undefined, entries: [], errors: [`missing baseline: ${baselinePath}`] };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    return { comment: undefined, entries: [], errors: [`invalid baseline JSON in ${baselinePath}: ${error.message}`] };
  }
  if (!isSchema(value) || !Array.isArray(value.entries)) {
    return { comment: undefined, entries: [], errors: [`${baselinePath} must be an object with an entries array`] };
  }
  const errors = [];
  const seen = new Set();
  value.entries.forEach((entry, index) => {
    if (!isSchema(entry) || typeof entry.rule !== 'string' || typeof entry.site !== 'string') {
      errors.push(`baseline entries[${index}] needs a string rule and site`);
      return;
    }
    if (seen.has(entryKey(entry))) errors.push(`baseline entries[${index}] duplicates ${entryKey(entry)}`);
    seen.add(entryKey(entry));
  });
  return { comment: value.$comment, entries: value.entries, errors };
}

/**
 * Splits findings into those the baseline records and those it doesn't, and
 * lists baseline entries that no finding matches any more.
 */
function ratchet(findings, entries) {
  const recordedKeys = new Set(entries.map(entryKey));
  const foundKeys = new Set(findings.map(entryKey));
  return {
    recorded: findings.filter((finding) => recordedKeys.has(entryKey(finding))),
    added: findings.filter((finding) => !recordedKeys.has(entryKey(finding))),
    stale: entries.filter((entry) => !foundKeys.has(entryKey(entry))),
  };
}

/** One entry per line, so a baseline diff shows exactly the entries that changed. */
function formatBaseline(comment, entries) {
  const lines = entries.map((entry) => `    ${JSON.stringify(entry)}`);
  return `{\n  "$comment": ${JSON.stringify(comment)},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

function writeBaseline(baselinePath, comment, findings, previous = []) {
  const kept = new Map(previous.map((entry) => [entryKey(entry), entry]));
  const entries = findings
    .map((finding) => {
      const entry = { rule: finding.rule, site: finding.site };
      for (const [key, value] of Object.entries(kept.get(entryKey(finding)) || {})) {
        if (!(key in entry)) entry[key] = value;
      }
      return entry;
    })
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b), 'en'));
  fs.writeFileSync(baselinePath, formatBaseline(comment, entries));
  return entries.length;
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}

/**
 * Runs a lint from the command line.
 *
 *   --schemas-dir <dir>   the schema tree (default static/schemas/source)
 *   --baseline <file>     the baseline (default: the lint's own)
 *   --update-baseline     rewrite the baseline to the current findings
 *   --all                 print every finding, not only the unrecorded ones
 *
 * `lint({ schemasDir, args })` returns { findings, errors?, report? }: findings
 * are { rule, site, message }; errors fail the run regardless of the baseline;
 * report lines are printed as information.
 */
function runCli({ name, defaultBaselinePath, baselineComment, lint, argv = process.argv.slice(2) }) {
  const started = process.hrtime.bigint();
  const schemasDir = path.resolve(readArg(argv, '--schemas-dir', DEFAULT_SCHEMAS_DIR));
  const baselinePath = path.resolve(readArg(argv, '--baseline', defaultBaselinePath));
  const result = lint({ schemasDir, args: argv });
  const findings = result.findings;
  const errors = [...(result.errors || [])];
  const elapsed = () => `${Number((process.hrtime.bigint() - started) / 1000000n)} ms`;

  if (argv.includes('--update-baseline')) {
    const previous = fs.existsSync(baselinePath) ? readBaseline(baselinePath).entries : [];
    const count = writeBaseline(baselinePath, baselineComment, findings, previous);
    console.log(`${name}: wrote ${count} baseline entries to ${toPosix(path.relative(process.cwd(), baselinePath))}. Review each new entry.`);
    return 0;
  }

  const baseline = readBaseline(baselinePath);
  errors.push(...baseline.errors);
  const { recorded, added, stale } = ratchet(findings, baseline.entries);
  const summary = `${findings.length} findings (${recorded.length} in the baseline, ${added.length} new), ` +
    `${stale.length} stale baseline entries, ${elapsed()}`;
  for (const line of result.report || []) console.log(`  ${line}`);
  if (argv.includes('--all')) for (const finding of findings) console.log(`  [${finding.rule}] ${finding.site}: ${finding.message}`);
  if (added.length === 0 && stale.length === 0 && errors.length === 0) {
    console.log(`✓ ${name}: ${summary}`);
    if (recorded.length) console.log(`  in the baseline, by rule: ${JSON.stringify(countBy(recorded, 'rule'))}`);
    return 0;
  }
  console.error(`✗ ${name}: ${summary}`);
  for (const error of errors) console.error(`  - ${error}`);
  for (const finding of added) console.error(`  - new [${finding.rule}] ${finding.site}: ${finding.message}`);
  for (const entry of stale) console.error(`  - stale baseline entry, remove it: [${entry.rule}] ${entry.site}`);
  if (added.length) {
    console.error(`  Fix the new findings. If one is a reviewed exception, record it with --update-baseline.`);
  }
  return 1;
}

module.exports = {
  DEFAULT_SCHEMAS_DIR,
  REPO_ROOT,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_ORIGIN,
  SCHEMA_SINGLE_KEYS,
  countBy,
  escapePointerToken,
  isSchema,
  loadSchemaTree,
  ratchet,
  readArg,
  readBaseline,
  resolvePointer,
  resolveRef,
  runCli,
  toPosix,
  unescapePointerToken,
  walkJsonFiles,
  walkSchema,
};
