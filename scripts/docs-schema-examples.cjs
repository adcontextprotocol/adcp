#!/usr/bin/env node
/**
 * Render docs JSON payload blocks from the schema examples, and check them.
 *
 * A docs payload block names its schema with a `$schema` field. The block is
 * one of that schema's root `examples`, chosen by the marker comment directly
 * above the fence:
 *
 *   {/* schema-example: #/examples/2 *\/}
 *   ```json Request
 *   {
 *     "$schema": "https://adcontextprotocol.org/schemas/v3/media-buy/get-products-request.json",
 *     ...
 *   }
 *   ```
 *
 * The marker's pointer is relative to the `$schema` document. The renderer
 * writes the fence body as `$schema` followed by the example, so the example
 * lives in the schema, test:schemas validates it, and the docs cannot drift.
 *
 * Usage:
 *   node scripts/docs-schema-examples.cjs           # rewrite bound blocks
 *   node scripts/docs-schema-examples.cjs --check   # fail on any finding
 *
 * Options:
 *   --docs-dir <dir>     docs tree to scan (default: docs)
 *   --schemas-dir <dir>  source schema tree (default: static/schemas/source)
 *
 * A block that contains "..." is illustrative and is not checked, as in
 * test:json-schema.
 *
 * Findings (each fails --check; only a stale body is fixed by a rewrite):
 *   - a marker that is not directly above a json fence;
 *   - a bound block without a parseable `$schema` that names a schema file;
 *   - a pointer that does not name an example in that schema;
 *   - a bound block whose body differs from the rendered example (stale);
 *   - a block with an AdCP `$schema` and no marker (hand-copied payload);
 *   - an unbound block equal to a root example of some schema (copy of it).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= args.length) usage(`${name} requires a value`);
  return args[index + 1];
}

function usage(message) {
  console.error(message);
  console.error('Usage: node scripts/docs-schema-examples.cjs [--check] [--docs-dir <dir>] [--schemas-dir <dir>]');
  process.exit(2);
}

for (const arg of args) {
  if (arg.startsWith('--') && !['--check', '--docs-dir', '--schemas-dir'].includes(arg)) usage(`Unknown option: ${arg}`);
}

const CHECK = args.includes('--check');
const DOCS_DIR = path.resolve(readArg('--docs-dir', path.join(ROOT, 'docs')));
const SCHEMAS_DIR = path.resolve(readArg('--schemas-dir', path.join(ROOT, 'static', 'schemas', 'source')));
const DISPLAY_ROOT = DOCS_DIR.startsWith(`${ROOT}${path.sep}`) ? ROOT : path.dirname(DOCS_DIR);

const MARKER = /^([ \t]*)\{\/\*\s*schema-example:\s*(\S+)\s*\*\/\}[ \t]*$/;
const FENCE_OPEN = /^([ \t]*)```(\S*)(.*)$/;
const POINTER = /^#\/examples\/(0|[1-9]\d*)$/;
const ADCP_SCHEMA = /^(?:https?:\/\/[^/]+)?\/schemas\//;
const PLACEHOLDER = /\.\.\./;
const LINE_WIDTH = 100;

function walk(dir, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, predicate));
    else if (entry.isFile() && predicate(entry.name)) files.push(full);
  }
  return files.sort();
}

/** Key-order-independent text of a JSON value, for equality. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * JSON with two-space indentation; an array of scalars stays on one line
 * when that line fits, as in the schema sources.
 */
function formatJson(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => item === null || typeof item !== 'object')) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (indent.length + inline.length <= LINE_WIDTH) return inline;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${formatJson(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const inner = `${indent}  `;
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${formatJson(value[key], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** The source schema file a `$schema` URI names, or null. */
function schemaFile(uri) {
  if (typeof uri !== 'string' || !ADCP_SCHEMA.test(uri)) return null;
  const relative = uri
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/schemas\/(?:latest|v?\d+(?:\.\d+)*(?:-[^/]+)?)\//, '/schemas/')
    .replace(/^\/schemas\//, '')
    .split('#')[0];
  const file = path.resolve(SCHEMAS_DIR, relative);
  if (!file.startsWith(`${SCHEMAS_DIR}${path.sep}`) || !file.endsWith('.json') || !fs.existsSync(file)) return null;
  return file;
}

const schemaCache = new Map();
function loadSchema(file) {
  if (!schemaCache.has(file)) schemaCache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  return schemaCache.get(file);
}

/** canonical(example) -> "path#/examples/i" for every root example. */
function rootExampleIndex() {
  const index = new Map();
  for (const file of walk(SCHEMAS_DIR, (name) => name.endsWith('.json'))) {
    const schema = loadSchema(file);
    if (!Array.isArray(schema.examples)) continue;
    schema.examples.forEach((example, i) => {
      const key = canonical(example);
      if (!index.has(key)) index.set(key, `${path.relative(SCHEMAS_DIR, file)}#/examples/${i}`);
    });
  }
  return index;
}

/** Every fenced block in a docs file, with the marker above it if any. */
function scanFile(text) {
  const lines = text.split('\n');
  const blocks = [];
  const strayMarkers = [];
  let pendingMarker = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = MARKER.exec(lines[i]);
    if (marker) {
      if (pendingMarker) strayMarkers.push(pendingMarker);
      pendingMarker = { line: i, indent: marker[1], pointer: marker[2] };
      continue;
    }
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      if (pendingMarker && lines[i].trim() !== '') {
        strayMarkers.push(pendingMarker);
        pendingMarker = null;
      }
      continue;
    }
    const indent = open[1];
    let close = i + 1;
    while (close < lines.length && lines[close] !== `${indent}\`\`\`` && lines[close].trimEnd() !== `${indent}\`\`\``) close++;
    const body = lines.slice(i + 1, close).map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n');
    const block = { open: i, close, indent, lang: open[2], body, marker: null };
    if (pendingMarker) {
      if (/^json[c5]?$/.test(block.lang) && pendingMarker.indent === indent) block.marker = pendingMarker;
      else strayMarkers.push(pendingMarker);
      pendingMarker = null;
    }
    blocks.push(block);
    i = close;
  }
  if (pendingMarker) strayMarkers.push(pendingMarker);
  return { lines, blocks, strayMarkers };
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function render(block, findings, at) {
  const parsed = parseJson(block.body);
  const file = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? schemaFile(parsed.$schema) : null;
  if (!file) {
    findings.push(`${at}: a schema-example block needs a "$schema" that names a schema in ${path.relative(ROOT, SCHEMAS_DIR) || SCHEMAS_DIR}`);
    return null;
  }
  const pointer = POINTER.exec(block.marker.pointer);
  const examples = loadSchema(file).examples;
  if (!pointer || !Array.isArray(examples) || Number(pointer[1]) >= examples.length) {
    findings.push(`${at}: ${block.marker.pointer} is not an example of ${path.relative(SCHEMAS_DIR, file)}; use #/examples/<index> of its root "examples"`);
    return null;
  }
  const example = examples[Number(pointer[1])];
  if (!example || typeof example !== 'object' || Array.isArray(example) || '$schema' in example) {
    findings.push(`${at}: ${path.relative(SCHEMAS_DIR, file)}${block.marker.pointer} is not an object instance that a "$schema" field can label`);
    return null;
  }
  return formatJson({ $schema: parsed.$schema, ...example });
}

function main() {
  const examples = rootExampleIndex();
  const findings = [];
  let bound = 0;
  let rewritten = 0;

  for (const file of walk(DOCS_DIR, (name) => /\.mdx?$/.test(name))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('```')) continue;
    const relative = path.relative(DISPLAY_ROOT, file);
    const { lines, blocks, strayMarkers } = scanFile(text);
    for (const marker of strayMarkers) {
      findings.push(`${relative}:${marker.line + 1}: schema-example marker is not directly above a json fence at the same indentation`);
    }

    const replacements = [];
    for (const block of blocks) {
      const at = `${relative}:${block.open + 1}`;
      if (block.marker) {
        bound++;
        const rendered = render(block, findings, at);
        if (rendered === null || rendered === block.body) continue;
        if (CHECK) {
          findings.push(`${at}: stale; the block differs from ${block.marker.pointer} of its "$schema". Run npm run build:docs-examples`);
        } else {
          replacements.push({ block, rendered });
        }
        continue;
      }
      // A block with "..." is illustrative, as in test:json-schema.
      if (!/^json[c5]?$/.test(block.lang) || PLACEHOLDER.test(block.body)) continue;
      const parsed = parseJson(block.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (typeof parsed.$schema === 'string' && ADCP_SCHEMA.test(parsed.$schema)) {
        findings.push(`${at}: a payload block with a "$schema" must come from that schema's examples; add the instance to its "examples" and put {/* schema-example: #/examples/<index> */} above the fence`);
        continue;
      }
      const instance = { ...parsed };
      delete instance.$schema;
      const copy = examples.get(canonical(instance));
      if (copy) {
        findings.push(`${at}: the block copies ${copy}; add its "$schema" and bind it with {/* schema-example: ${copy.slice(copy.indexOf('#'))} */}`);
      }
    }

    if (replacements.length > 0) {
      for (const { block, rendered } of replacements.reverse()) {
        const body = rendered.split('\n').map((line) => `${block.indent}${line}`);
        lines.splice(block.open + 1, block.close - block.open - 1, ...body);
        rewritten++;
      }
      fs.writeFileSync(file, lines.join('\n'));
    }
  }

  for (const finding of findings) console.error(finding);
  const summary = `${bound} docs blocks render from schema examples`;
  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s); ${summary}.`);
    process.exit(1);
  }
  console.log(CHECK ? `OK: ${summary}.` : `${summary}; rewrote ${rewritten}.`);
}

main();
