#!/usr/bin/env node
/**
 * Structural bounds on the `get_adcp_capabilities` response (#8198).
 *
 * The response is bounded by structure only; AdCP sets no byte limit on it.
 * This module checks that bound: it walks the response schema and every schema it reaches through `$ref`, reports the
 * arrays, strings, and maps that carry no bound, and computes the worst-case
 * serialized size of a schema-valid document.
 *
 * A bound is one of:
 *   - an enforced keyword (`maxItems`, `maxLength`, `maxProperties`), which
 *     the schema validates today. Used on surfaces new in 3.3 or experimental.
 *   - a 4.0 annotation (`x-max-items-4.0`, `x-max-length-4.0`,
 *     `x-max-properties-4.0`), used on a field that was stable before 3.3.
 *     Adding a bound there is a tightening, which a minor release may not
 *     make, so 3.x states it as a SHOULD and 4.0 enforces it.
 *
 * Exempt from a keyword, because the schema already bounds them:
 *   - a string with `enum`, `const`, or `format` (a format is priced with the
 *     table below);
 *   - a string whose anchored `pattern` admits only values of bounded length
 *     (a fixed-length pattern such as `^[A-Z]{2}$`; an anchored pattern with an
 *     unbounded quantifier is not exempt);
 *   - an array with `uniqueItems` whose items are a closed `enum` or a `const`
 *     (its length cannot exceed the number of values).
 * The worst-case calculation prices each exempt position from the schema.
 *
 * Usage: node scripts/capabilities-structural-bounds.cjs [--json]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'static', 'schemas', 'source');
const ROOT_FILE = 'protocol/get-adcp-capabilities-response.json';

const ANNOTATION = {
  maxItems: 'x-max-items-4.0',
  maxLength: 'x-max-length-4.0',
  maxProperties: 'x-max-properties-4.0',
};

// Worst-case pricing assumptions, documented in security.mdx.
const BYTES_PER_CHAR_TEXT = 4; // free text: UTF-8, one to four bytes per code point
const BYTES_PER_CHAR_PATTERN = 1; // pattern- and format-constrained strings are ASCII in AdCP
const INTEGER_BYTES = 21; // 64-bit integer, sign included
const NUMBER_BYTES = 25; // IEEE 754 double in shortest round-trip form with exponent
const FORMAT_MAX_LENGTH = {
  uri: 2048,
  'uri-reference': 2048,
  'date-time': 40,
  date: 10,
  time: 20,
  email: 254,
  uuid: 36,
  hostname: 253,
  ipv4: 15,
  ipv6: 45,
};
const DEFAULT_KEY_BYTES = 64; // map keys with no propertyNames bound


/**
 * Longest string an anchored regular expression can match, or Infinity.
 * Handles the subset AdCP patterns use: anchors, literals, escapes, classes,
 * groups (including non-capturing and lookahead), alternation, and the
 * quantifiers `?`, `*`, `+`, `{n}`, `{n,}`, `{n,m}`. Anything else is
 * Infinity, so an unrecognized pattern never counts as a bound.
 */
function patternMaxLength(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) return Infinity;
  const src = pattern.slice(1, -1);
  let i = 0;
  function parseAlt() {
    let best = parseSeq();
    while (src[i] === '|') {
      i++;
      best = Math.max(best, parseSeq());
    }
    return best;
  }
  function parseSeq() {
    let total = 0;
    while (i < src.length && src[i] !== '|' && src[i] !== ')') total += parseQuantified();
    return total;
  }
  function parseQuantified() {
    let width;
    const c = src[i];
    if (c === '(') {
      i++;
      let zeroWidth = false;
      if (src[i] === '?') {
        if (src[i + 1] === ':') i += 2;
        else if (src[i + 1] === '=' || src[i + 1] === '!') {
          zeroWidth = true;
          i += 2;
        } else return Infinity;
      }
      const inner = parseAlt();
      if (src[i] !== ')') return Infinity;
      i++;
      width = zeroWidth ? 0 : inner;
    } else if (c === '[') {
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      width = 1;
    } else if (c === '\\') {
      i += 2;
      width = 1;
    } else if (c === '^' || c === '$') {
      i++;
      width = 0;
    } else if (c === '*' || c === '+' || c === '?' || c === '{') {
      return Infinity;
    } else {
      i++;
      width = 1;
    }
    const q = src[i];
    if (q === '*' || q === '+') {
      i++;
      return width === 0 ? 0 : Infinity;
    }
    if (q === '?') {
      i++;
      return width;
    }
    if (q === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return Infinity;
      i += m[0].length;
      if (m[2] !== undefined && m[3] === '') return width === 0 ? 0 : Infinity;
      return width * Number(m[3] !== undefined ? m[3] : m[1]);
    }
    return width;
  }
  const max = parseAlt();
  return i === src.length ? max : Infinity;
}

const docCache = new Map();
function load(file) {
  if (!docCache.has(file)) docCache.set(file, JSON.parse(fs.readFileSync(path.join(SOURCE, file), 'utf8')));
  return docCache.get(file);
}

const unescapeSegment = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');

function resolvePointer(doc, fragment) {
  let node = doc;
  for (const seg of fragment.replace(/^#\/?/, '').split('/').filter(Boolean)) node = node?.[unescapeSegment(seg)];
  return node;
}

function resolveRef(ref, currentFile) {
  const [rawFile, fragment] = ref.split('#');
  const file = rawFile
    ? rawFile
        .replace(/^https:\/\/adcontextprotocol\.org\/schemas\/(v?[0-9.]+\/|latest\/)?/, '')
        .replace(/^\/schemas\/(v?[0-9.]+\/|latest\/)?/, '')
    : currentFile;
  return { file, pointer: fragment ? `#${fragment}` : '#', node: resolvePointer(load(file), fragment ? `#${fragment}` : '#') };
}

const typesOf = (node) => [].concat(node.type || []);
const isArraySchema = (node) => typesOf(node).includes('array') || node.items !== undefined;
const isStringSchema = (node) => typesOf(node).includes('string') && !typesOf(node).includes('object');
const isMapSchema = (node) =>
  (node.additionalProperties && typeof node.additionalProperties === 'object') || node.patternProperties !== undefined;

/** Why a position needs no keyword, or null when it does. */
function exemption(node, file) {
  if (isStringSchema(node)) {
    if (node.enum !== undefined || node.const !== undefined || node.format !== undefined) return 'closed';
    if (Number.isFinite(patternMaxLength(node.pattern))) return 'pattern';
  }
  if (isArraySchema(node) && node.uniqueItems && node.items && typeof node.items === 'object') {
    const items = node.items.$ref ? resolveRef(node.items.$ref, file).node : node.items;
    if (items && (items.enum !== undefined || items.const !== undefined)) return 'closed-enum';
  }
  return null;
}

/**
 * Visit every data position reachable from the response schema. Conditional
 * subschemas (`if`, `then`, `else`, `not`, `contains`) only test a document;
 * they do not describe a position that carries data, so they are not walked.
 * Each `file#pointer` is visited once.
 */
function walk(visitor, rootFile = ROOT_FILE) {
  const seen = new Set();
  function visit(file, pointer, node, trail) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const target = resolveRef(node.$ref, file);
      visit(target.file, target.pointer, target.node, trail);
    }
    const key = `${file}${pointer}`;
    if (seen.has(key)) return;
    seen.add(key);
    visitor({ file, pointer, node, key, trail });
    const child = (segment, sub, subTrail) =>
      visit(file, pointer === '#' ? `#/${segment}` : `${pointer}/${segment}`, sub, subTrail);
    for (const k of ['allOf', 'oneOf', 'anyOf']) (node[k] || []).forEach((sub, i) => child(`${k}/${i}`, sub, trail));
    for (const [name, sub] of Object.entries(node.properties || {})) {
      child(`properties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, sub, `${trail}.${name}`);
    }
    for (const [name, sub] of Object.entries(node.patternProperties || {})) {
      child(`patternProperties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, sub, `${trail}.{${name}}`);
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      child('additionalProperties', node.additionalProperties, `${trail}.{*}`);
    }
    if (Array.isArray(node.items)) node.items.forEach((sub, i) => child(`items/${i}`, sub, `${trail}[]`));
    else if (node.items) child('items', node.items, `${trail}[]`);
  }
  visit(rootFile, '#', load(rootFile), '$');
}

/** Classify every position that needs a bound, and say how it is bounded. */
function coverage() {
  const rows = [];
  walk(({ file, pointer, node, key, trail }) => {
    if (node.$ref) return; // the target carries the bound
    const exempt = exemption(node, file);
    if (isArraySchema(node)) {
      rows.push({ kind: 'array', keyword: 'maxItems', file, pointer, key, trail, exempt, ...describe(node, 'maxItems', exempt) });
    }
    if (isStringSchema(node) && !(node.enum !== undefined || node.const !== undefined || node.format !== undefined)) {
      rows.push({ kind: 'string', keyword: 'maxLength', file, pointer, key, trail, exempt, ...describe(node, 'maxLength', exempt) });
    }
    if (isMapSchema(node)) {
      rows.push({ kind: 'map', keyword: 'maxProperties', file, pointer, key, trail, exempt: null, ...describe(node, 'maxProperties', null) });
    }
  });
  return rows;
}

function describe(node, keyword, exempt) {
  const enforced = node[keyword];
  const annotated = node[ANNOTATION[keyword]];
  return {
    enforced,
    annotated,
    bounded: exempt !== null || enforced !== undefined || annotated !== undefined,
  };
}

/**
 * Worst-case serialized size, in bytes, of a document that validates against
 * the response schema, counting only the members the schema declares.
 *
 * mode `enforced`  counts the keywords the schema validates today; a position
 *                  with only a 4.0 annotation is unbounded (Infinity).
 * mode `4.0`       also counts the 4.0 annotations.
 *
 * Every declared member is assumed present, every array and map full, and
 * every string at its maximum length. A union takes its widest branch. Members
 * the schema does not declare are not counted: an open object admits any
 * extra member, so the byte budget, not structure, bounds those. The count of
 * open positions is reported with the result.
 */
function worstCase(mode, rootFile = ROOT_FILE) {
  const open = new Set();
  const unbounded = new Set();
  const memo = new Map();

  const bound = (node, keyword) => {
    if (node[keyword] !== undefined) return node[keyword];
    if (mode === '4.0' && node[ANNOTATION[keyword]] !== undefined) return node[ANNOTATION[keyword]];
    return undefined;
  };

  function stringBytes(node, key) {
    if (node.const !== undefined) return JSON.stringify(node.const).length;
    if (node.enum) return Math.max(...node.enum.map((v) => JSON.stringify(v).length));
    let max = bound(node, 'maxLength');
    if (max === undefined && node.format !== undefined) max = FORMAT_MAX_LENGTH[node.format];
    if (max === undefined && Number.isFinite(patternMaxLength(node.pattern))) max = patternMaxLength(node.pattern);
    if (max === undefined) {
      unbounded.add(key);
      return Infinity;
    }
    const ascii = node.pattern !== undefined || node.format !== undefined;
    return max * (ascii ? BYTES_PER_CHAR_PATTERN : BYTES_PER_CHAR_TEXT) + 2;
  }

  // Merge the declared members of a node with the members its allOf adds.
  function collectMembers(node, file, acc) {
    if (node.$ref) {
      const t = resolveRef(node.$ref, file);
      collectMembers(t.node, t.file, acc);
    }
    for (const [name, sub] of Object.entries(node.properties || {})) {
      (acc.props[name] ||= []).push({ sub, file });
    }
    if (node.patternProperties || (node.additionalProperties && typeof node.additionalProperties === 'object')) {
      acc.maps.push({ node, file });
    }
    for (const sub of node.allOf || []) collectMembers(sub, file, acc);
    return acc;
  }

  // Longest serialized key a map's `propertyNames` admits.
  function mapKeyBytes(mapNode, file) {
    let names = mapNode.propertyNames;
    if (names?.$ref) names = resolveRef(names.$ref, file).node;
    if (names?.enum) return Math.max(...names.enum.map((v) => JSON.stringify(v).length));
    if (names?.pattern === '^[A-Z]{2}$') return 4;
    if (names?.maxLength !== undefined) return names.maxLength + 2;
    return DEFAULT_KEY_BYTES + 2;
  }

  function size(node, file, pointer) {
    if (!node || typeof node !== 'object') return 0;
    const key = `${file}${pointer}`;
    if (node.$ref) {
      const t = resolveRef(node.$ref, file);
      return size(t.node, t.file, t.pointer);
    }
    if (memo.has(key)) return memo.get(key);
    memo.set(key, Infinity); // a cycle that no bound cuts is unbounded
    const result = compute(node, file, pointer, key);
    memo.set(key, result);
    return result;
  }

  function compute(node, file, pointer, key) {
    const types = typesOf(node);
    const hasMembers = node.properties || node.patternProperties || node.allOf || node.additionalProperties;
    const branches = [].concat(node.oneOf || [], node.anyOf || []);

    if (isArraySchema(node)) {
      let max = bound(node, 'maxItems');
      if (max === undefined && exemption(node, file) === 'closed-enum') {
        const items = node.items.$ref ? resolveRef(node.items.$ref, file).node : node.items;
        max = items.enum ? items.enum.length : 1;
      }
      if (max === undefined) {
        unbounded.add(key);
        return Infinity;
      }
      if (!node.items || node.items === true || (typeof node.items === 'object' && !Object.keys(node.items).length)) {
        open.add(key);
        return 2;
      }
      return 2 + max * (size(node.items, file, `${pointer}/items`) + 1);
    }
    if (types.includes('object') || hasMembers || (branches.length && !types.length)) {
      let total = 0;
      const members = collectMembers(node, file, { props: {}, maps: [] });
      let widest = 0;
      for (const [name, entries] of Object.entries(members.props)) {
        // An instance satisfies every allOf member, so take the tightest declaration.
        const best = Math.min(
          ...entries.map(({ sub, file: f }) => size(sub, f, `${pointer}/properties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`)),
        );
        total += JSON.stringify(name).length + 1 + best + 1;
      }
      for (const { node: mapNode, file: f } of members.maps) {
        const valueSchema =
          mapNode.additionalProperties && typeof mapNode.additionalProperties === 'object'
            ? mapNode.additionalProperties
            : Object.values(mapNode.patternProperties)[0];
        const max = bound(mapNode, 'maxProperties');
        if (max === undefined) {
          unbounded.add(`${f}${pointer}`);
          return Infinity;
        }
        const keyBytes = mapKeyBytes(mapNode, f);
        total += max * (keyBytes + 1 + size(valueSchema, f, `${pointer}/additionalProperties`) + 1);
      }
      if (!node.properties && !branches.length && !members.maps.length && !node.allOf) open.add(key);
      if ((node.additionalProperties === undefined || node.additionalProperties === true) && types.includes('object')) {
        open.add(key);
      }
      for (const [i, sub] of branches.entries()) {
        widest = Math.max(widest, size(sub, file, `${pointer}/${node.oneOf ? 'oneOf' : 'anyOf'}/${i}`));
      }
      return total + widest + 2;
    }
    if (types.includes('string') || node.enum || node.const !== undefined) {
      const options = [stringBytes(node, key)];
      for (const t of types) {
        if (t === 'integer') options.push(INTEGER_BYTES);
        if (t === 'number') options.push(NUMBER_BYTES);
        if (t === 'boolean') options.push(5);
        if (t === 'null') options.push(4);
      }
      return Math.max(...options);
    }
    if (types.includes('integer')) return INTEGER_BYTES;
    if (types.includes('number')) return NUMBER_BYTES;
    if (types.includes('boolean')) return 5;
    if (types.includes('null')) return 4;
    if (branches.length) return Math.max(...branches.map((sub, i) => size(sub, file, `${pointer}/oneOf/${i}`)));
    open.add(key);
    return 0;
  }

  const root = load(rootFile);
  const perBlock = {};
  const members = collectMembers(root, rootFile, { props: {}, maps: [] });
  let total = 2;
  for (const [name, entries] of Object.entries(members.props)) {
    const best = Math.min(...entries.map(({ sub, file }) => size(sub, file, `#/properties/${name}`)));
    perBlock[name] = best;
    total += JSON.stringify(name).length + 1 + best + 1;
  }
  return { total, perBlock, sizes: memo, openPositions: open.size, unboundedPositions: [...unbounded] };
}

function main() {
  const rows = coverage();
  const unbounded = rows.filter((r) => !r.bounded);
  const wc4 = worstCase('4.0');
  const wc3 = worstCase('enforced');
  const kib = (n) => (Number.isFinite(n) ? `${(n / 1024).toFixed(1)} KiB` : 'unbounded');
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ positions: rows.length, unbounded: unbounded.length, enforced: wc3.total, annotated: wc4.total }, null, 2));
    return;
  }
  console.log(`positions needing a bound: ${rows.length}, unbounded: ${unbounded.length}`);
  for (const r of unbounded) console.log(`  ${r.kind} ${r.key}  (${r.trail})`);
  console.log(`worst case with 4.0 bounds:       ${kib(wc4.total)} (${wc4.total} bytes)`);
  console.log(`worst case with enforced bounds:  ${kib(wc3.total)}`);
  console.log(`open positions (undeclared members not counted): ${wc4.openPositions}`);
  const blocks = Object.entries(wc4.perBlock).sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [name, bytes] of blocks) console.log(`  ${name.padEnd(28)} ${kib(bytes)}`);
}

if (require.main === module) main();

module.exports = {
  ANNOTATION,
  FORMAT_MAX_LENGTH,
  ROOT_FILE,
  coverage,
  exemption,
  load,
  patternMaxLength,
  resolveRef,
  walk,
  worstCase,
};
