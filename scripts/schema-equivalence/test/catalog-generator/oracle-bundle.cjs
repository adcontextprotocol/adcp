'use strict';

/**
 * Turns one catalog pair into the self-contained inclusion problems the
 * offline oracle decides: `{"definitions": {...}, "allOf": [S1, {"not": S2}]}`.
 *
 * Every `$ref` target (file plus JSON pointer) becomes its own top-level
 * definition, named per side (`L0...`, `R0...`), so the two sides never share
 * a definition even when they spell a `$ref` the same way. The oracle's own
 * file resolution names definitions after the raw `$ref` string, so it must
 * never see a multi-file schema.
 *
 * The output keeps Ajv's draft-07 meaning, with two translations the oracle
 * needs:
 *   - annotations (`title`, `description`, `$id`, `x-*`, ...) are dropped;
 *   - `discriminator` with `oneOf` becomes the exact formula Ajv evaluates
 *     (ajv/lib/vocabularies/discriminator): a non-object passes; an object
 *     must carry the tag as a string, and is checked against the one branch
 *     whose `properties/<tag>` `const` or `enum` lists that value. Ajv skips
 *     the `oneOf` itself.
 *
 * `format` is kept, and the oracle ignores it, so the generator decides pairs
 * that use `format` by hand.
 */

const path = require('node:path');
const { createAjv } = require('../../lib/ajv.cjs');

const SINGLE = new Set(['not', 'if', 'then', 'else', 'additionalItems', 'contains', 'propertyNames', 'additionalProperties', 'items']);
const ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'items']);
const MAPS = new Set(['properties', 'patternProperties', 'dependencies']);
const DROP = new Set(['$id', '$schema', '$comment', 'title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly', 'definitions', '$defs', 'enumDescriptions', 'contentMediaType', 'contentEncoding']);
const AJV_RULES = new Set(Object.keys(createAjv().RULES.all));

function getPointer(doc, ptr) {
  if (!ptr) return doc;
  return ptr.replace(/^\//, '').split('/').map(s => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((n, k) => {
      if (n === undefined || n === null) throw new Error(`bad pointer ${ptr}`);
      return n[k];
    }, doc);
}

function resolveFile(fromRel, fileRef) {
  if (fileRef.startsWith('/schemas/')) return fileRef.slice('/schemas/'.length);
  if (/^[a-z]+:/i.test(fileRef)) throw new Error(`absolute URL ref not supported: ${fileRef}`);
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), fileRef));
}

function splitRef(rel, ref) {
  const [f, frag = ''] = ref.split('#');
  return { rel: f ? resolveFile(rel, f) : rel, ptr: frag };
}

/** Ajv's discriminator mapping: the tag values of each oneOf branch, or an error. */
function discriminatorMapping(files, node, rel) {
  const tag = node.discriminator.propertyName;
  if (typeof tag !== 'string') throw new Error('discriminator without propertyName');
  if (node.discriminator.mapping) throw new Error('discriminator mapping is not supported by Ajv');
  const hasReq = (s) => Array.isArray(s.required) && s.required.includes(tag);
  const topRequired = hasReq(node);
  let tagRequired = true;
  const seen = new Set();
  const out = node.oneOf.map((branch) => {
    let sch = branch;
    if (sch && typeof sch === 'object' && typeof sch.$ref === 'string' && !Object.keys(sch).some(k => k !== '$ref' && AJV_RULES.has(k))) {
      const t = splitRef(rel, sch.$ref);
      sch = getPointer(files[t.rel], t.ptr);
    }
    const propSch = sch && sch.properties && sch.properties[tag];
    if (!propSch || typeof propSch !== 'object') throw new Error(`discriminator: branch without properties/${tag}`);
    tagRequired = tagRequired && (topRequired || hasReq(sch));
    let values;
    if (propSch.const) values = [propSch.const];
    else if (propSch.enum) values = propSch.enum;
    else throw new Error(`discriminator: properties/${tag} needs const or enum`);
    for (const v of values) {
      if (typeof v !== 'string' || seen.has(v)) throw new Error('discriminator: tag values must be unique strings');
      seen.add(v);
    }
    return values;
  });
  if (!tagRequired) throw new Error(`discriminator: "${tag}" must be required`);
  return { tag, values: out };
}

function makeSide(prefix, files, rootRel) {
  const ids = new Map();
  const defs = {};
  const queue = [];
  const idFor = (rel, ptr) => {
    const k = `${rel}#${ptr}`;
    if (!ids.has(k)) {
      const id = `${prefix}${ids.size}`;
      ids.set(k, id);
      queue.push([id, rel, ptr]);
    }
    return ids.get(k);
  };
  function walk(node, rel) {
    if (typeof node === 'boolean') return node;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) throw new Error(`not a schema in ${rel}`);
    const out = {};
    const extra = [];
    const disc = node.discriminator !== undefined && Array.isArray(node.oneOf);
    if (disc) {
      const { tag, values } = discriminatorMapping(files, node, rel);
      const branches = node.oneOf.map((b, i) => ({ allOf: [{ properties: { [tag]: { enum: values[i] } } }, walk(b, rel)] }));
      extra.push({ anyOf: [{ not: { type: 'object' } }, { type: 'object', required: [tag], anyOf: branches }] });
    }
    for (const [k, v] of Object.entries(node)) {
      if (DROP.has(k) || k.startsWith('x-')) continue;
      if (disc && (k === 'discriminator' || k === 'oneOf')) continue;
      if (k === 'discriminator') throw new Error('discriminator without oneOf');
      if (k === 'nullable') throw new Error('nullable is not used by the catalog');
      if (k === '$ref') {
        const t = splitRef(rel, v);
        if (!files[t.rel]) throw new Error(`unresolved $ref ${v} in ${rel}`);
        out.$ref = `#/definitions/${idFor(t.rel, t.ptr)}`;
        continue;
      }
      if (SINGLE.has(k) && (typeof v === 'boolean' || (v && typeof v === 'object' && !Array.isArray(v)))) {
        out[k] = walk(v, rel);
        continue;
      }
      if (ARRAYS.has(k) && Array.isArray(v)) {
        out[k] = v.map(x => walk(x, rel));
        continue;
      }
      if (MAPS.has(k)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, Array.isArray(s) ? s : walk(s, rel)]));
        continue;
      }
      out[k] = v;
    }
    if (extra.length) out.allOf = [...(out.allOf || []), ...extra];
    return out;
  }
  const rootId = idFor(rootRel, '');
  while (queue.length) {
    const [id, rel, ptr] = queue.shift();
    defs[id] = walk(getPointer(files[rel], ptr), rel);
  }
  return { rootId, defs };
}

/** The forward (base included in head?) and reverse (head included in base?) problems. */
function inclusionProblems(baseFiles, headFiles, root) {
  const base = makeSide('L', baseFiles, root);
  const head = makeSide('R', headFiles, root);
  const definitions = { ...base.defs, ...head.defs };
  const mk = (a, b) => ({ definitions, allOf: [{ $ref: `#/definitions/${a.rootId}` }, { not: { $ref: `#/definitions/${b.rootId}` } }] });
  return { fwd: mk(base, head), rev: mk(head, base) };
}

module.exports = { inclusionProblems, discriminatorMapping };
