'use strict';

/**
 * Evaluates an instance against a raw source schema (as written, `$ref`s
 * resolved in the tree), with draft-07 semantics as the repo's Ajv
 * configuration applies them. The witness search uses it to steer instance
 * synthesis (which `if` holds, which union branch an instance fits); Ajv
 * still confirms every payload the search reports.
 *
 * Returns true (accepted), false (rejected), or undefined (not decided here:
 * an unresolvable `$ref`, an invalid pattern, or the depth limit).
 */

const { refTarget, readDoc } = require('./graph.cjs');
const { getPointer, stableStringify, jsonType } = require('./json.cjs');

let fullFormats = {};
try {
  ({ fullFormats } = require('ajv-formats/dist/formats'));
} catch {
  fullFormats = {};
}

const MAX_DEPTH = 40;
const regexCache = new Map();

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function regex(p) {
  if (!regexCache.has(p)) {
    let re = null;
    try {
      re = new RegExp(p, 'u');
    } catch {
      re = null;
    }
    regexCache.set(p, re);
  }
  return regexCache.get(p);
}

function typeMatches(t, v) {
  const j = jsonType(v);
  if (t === 'integer') return j === 'integer';
  if (t === 'number') return j === 'integer' || j === 'number';
  return t === j;
}

function formatOk(name, v) {
  const def = fullFormats[name];
  // Under `strict: false` an unknown format asserts nothing.
  if (def === undefined) return true;
  let type = 'string';
  let check = def;
  if (def && typeof def === 'object' && !(def instanceof RegExp)) {
    if (def.async) return undefined;
    type = def.type || 'string';
    check = def.validate;
  }
  if (!typeMatches(type, v)) return true;
  if (check instanceof RegExp) return check.test(v);
  if (typeof check === 'function') return !!check(v);
  return true;
}

const same = (a, b) => stableStringify(a) === stableStringify(b);

/** The raw schema a `$ref` written in `doc` names: { doc, schema } or null. */
function resolveRef(tree, doc, ref) {
  const t = refTarget(doc, ref);
  if (!t) return null;
  const d = readDoc(tree, t.doc);
  const schema = d === undefined || d === null ? undefined : getPointer(d, t.ptr);
  return schema === undefined ? null : { doc: t.doc, schema };
}

function all(results) {
  if (results.some(r => r === false)) return false;
  return results.every(r => r === true) ? true : undefined;
}

/** Whether raw schema `s`, written in document `doc`, accepts `v`. */
function accepts(tree, doc, s, v, depth = 0) {
  if (s === true || s === undefined) return true;
  if (s === false) return false;
  if (!isObj(s) || depth > MAX_DEPTH) return undefined;
  const out = [];
  const sub = (schema, value, d = doc) => accepts(tree, d, schema, value, depth + 1);
  if (typeof s.$ref === 'string') {
    const t = resolveRef(tree, doc, s.$ref);
    out.push(t ? sub(t.schema, v, t.doc) : undefined);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    out.push(types.some(t => typeMatches(t, v)));
  }
  if (Object.prototype.hasOwnProperty.call(s, 'const')) out.push(same(s.const, v));
  if (Array.isArray(s.enum)) out.push(s.enum.some(x => same(x, v)));
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number') out.push(v >= s.minimum);
    if (typeof s.maximum === 'number') out.push(v <= s.maximum);
    if (typeof s.exclusiveMinimum === 'number') out.push(v > s.exclusiveMinimum);
    if (typeof s.exclusiveMaximum === 'number') out.push(v < s.exclusiveMaximum);
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
      const q = v / s.multipleOf;
      out.push(Math.abs(q - Math.round(q)) < 1e-9);
    }
  }
  if (typeof v === 'string') {
    const n = [...v].length;
    if (typeof s.minLength === 'number') out.push(n >= s.minLength);
    if (typeof s.maxLength === 'number') out.push(n <= s.maxLength);
    if (typeof s.pattern === 'string') {
      const re = regex(s.pattern);
      out.push(re ? re.test(v) : undefined);
    }
  }
  if (typeof s.format === 'string') out.push(formatOk(s.format, v));
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number') out.push(v.length >= s.minItems);
    if (typeof s.maxItems === 'number') out.push(v.length <= s.maxItems);
    if (s.uniqueItems === true) out.push(new Set(v.map(stableStringify)).size === v.length);
    if (Array.isArray(s.items)) {
      v.forEach((x, i) => {
        if (i < s.items.length) out.push(sub(s.items[i], x));
        else if (s.additionalItems !== undefined) out.push(sub(s.additionalItems, x));
      });
    } else if (s.items !== undefined) for (const x of v) out.push(sub(s.items, x));
    if (s.contains !== undefined) {
      const rs = v.map(x => sub(s.contains, x));
      out.push(rs.some(r => r === true) ? true : rs.every(r => r === false) ? false : undefined);
    }
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (Array.isArray(s.required)) out.push(s.required.every(k => Object.prototype.hasOwnProperty.call(v, k)));
    if (typeof s.minProperties === 'number') out.push(keys.length >= s.minProperties);
    if (typeof s.maxProperties === 'number') out.push(keys.length <= s.maxProperties);
    const props = isObj(s.properties) ? s.properties : {};
    const patterns = isObj(s.patternProperties) ? Object.entries(s.patternProperties) : [];
    for (const k of keys) {
      let covered = false;
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        covered = true;
        out.push(sub(props[k], v[k]));
      }
      for (const [p, ps] of patterns) {
        const re = regex(p);
        if (!re) {
          out.push(undefined);
          continue;
        }
        if (re.test(k)) {
          covered = true;
          out.push(sub(ps, v[k]));
        }
      }
      if (!covered && s.additionalProperties !== undefined) out.push(sub(s.additionalProperties, v[k]));
      if (s.propertyNames !== undefined) out.push(sub(s.propertyNames, k));
    }
    if (isObj(s.dependencies)) {
      for (const [k, dep] of Object.entries(s.dependencies)) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (Array.isArray(dep)) out.push(dep.every(d => Object.prototype.hasOwnProperty.call(v, d)));
        else out.push(sub(dep, v));
      }
    }
  }
  if (Array.isArray(s.allOf)) for (const m of s.allOf) out.push(sub(m, v));
  if (Array.isArray(s.anyOf)) {
    const rs = s.anyOf.map(m => sub(m, v));
    out.push(rs.some(r => r === true) ? true : rs.every(r => r === false) ? false : undefined);
  }
  if (Array.isArray(s.oneOf)) {
    const rs = s.oneOf.map(m => sub(m, v));
    if (rs.filter(r => r === true).length > 1) out.push(false);
    else if (rs.some(r => r === undefined)) out.push(undefined);
    else out.push(rs.filter(r => r === true).length === 1);
  }
  if (s.not !== undefined) {
    const r = sub(s.not, v);
    out.push(r === undefined ? undefined : !r);
  }
  if (s.if !== undefined) {
    const c = sub(s.if, v);
    if (c === undefined) out.push(undefined);
    else if (c && s.then !== undefined) out.push(sub(s.then, v));
    else if (!c && s.else !== undefined) out.push(sub(s.else, v));
  }
  return all(out);
}

module.exports = { accepts };
