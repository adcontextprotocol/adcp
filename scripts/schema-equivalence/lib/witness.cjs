'use strict';

/**
 * Witnesses: for each manifest entry, one concrete payload that one side
 * accepts and the other rejects (base valid / head invalid for a tightening,
 * the reverse for a loosening, one of each for "both").
 *
 * Targeted search, no generator dependency:
 *   1. Seeds: corpus instances of the root, plus an instance synthesized from
 *      the raw schema and guided down the entry's pointer (choosing the
 *      branch the pointer names, including optional properties on the path).
 *   2. At the instance location the pointer names, try candidate values
 *      derived from the change (values around a changed bound, the values an
 *      enum gained or lost, strings that match one pattern and not the other,
 *      deleting a property that became required, the branch that was added or
 *      removed), then generic values of every JSON type.
 *   3. Accept a payload only when the repo's Ajv configuration gives the
 *      required verdicts on the base and head root.
 */

const { TreeValidator } = require('./corpus.cjs');
const { refTarget, readDoc, originLabel } = require('./graph.cjs');
const { getPointer, escapePointer, unescapePointer, stableStringify } = require('./json.cjs');
const { sampleRegex } = require('./sample-regex.cjs');
const { siteOf, normalizeRoot } = require('./manifest.cjs');
const { VALUE, SINGLE, MAP, UNION } = require('./keywords.cjs');
const { accepts } = require('./raw-eval.cjs');

const FAIL = Symbol('fail');
const DELETE = Symbol('delete');
const MAX_DEPTH = 24;

const FORMAT_SAMPLES = {
  uri: 'https://example.com/x', 'uri-reference': 'https://example.com/x', iri: 'https://example.com/x', 'iri-reference': 'https://example.com/x',
  url: 'https://example.com/x', email: 'a@example.com', 'idn-email': 'a@example.com', 'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01', time: '00:00:00Z', uuid: '00000000-0000-4000-8000-000000000000', hostname: 'example.com',
  'idn-hostname': 'example.com', ipv4: '192.0.2.1', ipv6: '2001:db8::1', regex: '^a$', 'json-pointer': '/a',
  'relative-json-pointer': '0', duration: 'P1D', 'uri-template': 'https://example.com/{id}', byte: 'YQ==', password: 'x',
  binary: 'x',
};
const GENERIC = [null, true, false, 0, -1, 1, 1.5, 1e15, '', 'a', 'A', '0', 'a'.repeat(300), 'a'.repeat(5000), [], [1], {}, { a: 1 }];

function parseLocation(label) {
  if (!label) return null;
  const hash = label.indexOf('#');
  const file = label.slice(0, hash);
  const ptr = label.slice(hash + 1);
  return file.startsWith('dist/schemas/') ? { doc: `dist:${file.slice('dist/schemas/'.length)}`, ptr } : { doc: `src:${file}`, ptr };
}

function rawAt(tree, loc) {
  if (!loc) return undefined;
  const doc = readDoc(tree, loc.doc);
  return doc === undefined || doc === null ? undefined : getPointer(doc, loc.ptr);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(a, b) {
  if (a === FAIL || a === undefined) return b;
  if (b === FAIL || b === undefined) return a;
  if (isObj(a) && isObj(b)) {
    const out = { ...b };
    for (const [k, v] of Object.entries(a)) out[k] = k in b ? merge(v, b[k]) : v;
    return out;
  }
  return a;
}

function synthString(s) {
  const min = s.minLength || 0;
  const max = s.maxLength === undefined ? Infinity : s.maxLength;
  const cands = [];
  if (s.format && FORMAT_SAMPLES[s.format]) cands.push(FORMAT_SAMPLES[s.format]);
  if (typeof s.pattern === 'string') cands.push(...sampleRegex(s.pattern));
  cands.push('a');
  let re = null;
  try {
    re = typeof s.pattern === 'string' ? new RegExp(s.pattern, 'u') : null;
  } catch {
    re = null;
  }
  for (const c0 of cands) {
    let c = c0;
    if (c.length < min) c = c + c.slice(-1).repeat(min - c.length);
    if (c.length > max) c = c.slice(0, max);
    if (!re || re.test(c)) return c;
  }
  return cands[0];
}

function synthNumber(s, integer) {
  let v = 0;
  if (typeof s.minimum === 'number') v = s.minimum;
  else if (typeof s.exclusiveMinimum === 'number') v = s.exclusiveMinimum + (integer ? 1 : 0.5);
  else if (typeof s.maximum === 'number' && s.maximum < 0) v = s.maximum;
  if (typeof s.multipleOf === 'number' && s.multipleOf > 0) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
  if (integer) v = Math.ceil(v);
  return v;
}

function pickType(s) {
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : null;
  if (types) {
    for (const t of ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']) if (types.includes(t)) return t;
    return types[0];
  }
  if (s.properties || s.required || s.additionalProperties !== undefined || s.patternProperties) return 'object';
  if (s.items || s.minItems !== undefined) return 'array';
  if (s.minProperties !== undefined || s.maxProperties !== undefined) return 'object';
  if (s.pattern || s.minLength !== undefined || s.maxLength !== undefined || s.format) return 'string';
  if (s.minimum !== undefined || s.maximum !== undefined) return 'number';
  return 'object';
}

const COMBINATORS = ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'not'];

function without(s, keys) {
  const out = {};
  for (const [k, v] of Object.entries(s)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/**
 * The property schemas that conjunction members (written in `doc`) declare,
 * by name, including members reached through `$ref` and their own `allOf`
 * members. A property behind a `$ref` is given as a `$ref` to its location,
 * so it resolves in its own document.
 */
function memberProperties(tree, doc, members, depth = 0) {
  const out = {};
  const visit = (d, ptr, s, level) => {
    if (level > 4 || !isObj(s)) return;
    if (typeof s.$ref === 'string') {
      const t = refTarget(d, s.$ref);
      const target = t && rawAt(tree, t);
      if (target !== undefined) visit(t.doc, t.ptr, target, level + 1);
    }
    if (isObj(s.properties)) {
      for (const [name, ps] of Object.entries(s.properties)) {
        if (name in out) continue;
        out[name] = ptr === null ? ps : { $ref: refUrl(d, `${ptr}/properties/${escapePointer(name)}`) };
      }
    }
    if (Array.isArray(s.allOf)) s.allOf.forEach((m, j) => visit(d, ptr === null ? null : `${ptr}/allOf/${j}`, m, level + 1));
  };
  // An inline member has no known pointer: its schemas stay raw, in `doc`.
  for (const m of members) visit(doc, null, m, depth);
  return out;
}

/** An instance of raw schema `s` (in document `doc`), guided along pointer segments `segs`. */
function synth(tree, doc, s, segs, depth = 0, choice = 0, props0 = {}) {
  if (depth > MAX_DEPTH) return segs.length ? FAIL : null;
  // Properties declared next to a combinator apply inside its members too
  // (a branch that only says `required: [x]` takes x's schema from here).
  const ctxProps = isObj(s) && isObj(s.properties) ? { ...props0, ...s.properties } : props0;
  if (s === true || s === undefined) return segs.length ? FAIL : {};
  if (s === false || !isObj(s)) return FAIL;
  segs = alignSegs(s, segs);
  if (typeof s.$ref === 'string') {
    const t = refTarget(doc, s.$ref);
    const target = t && rawAt(tree, t);
    if (target === undefined) return FAIL;
    const rest = segs[0] === '$ref' ? segs.slice(1) : segs;
    const v = synth(tree, t.doc, target, rest, depth + 1, choice, ctxProps);
    const siblings = without(s, ['$ref']);
    return merge(v, synth(tree, doc, siblings, [], depth + 1, choice, ctxProps));
  }
  if (Array.isArray(s.allOf)) {
    const guided = segs[0] === 'allOf' ? Number(segs[1]) : -1;
    // A property one member declares, also behind the member's `$ref`, is
    // the schema of that name in every member (a member that only says
    // `required: [spend]` takes spend's schema from a referenced sibling).
    const shared = { ...memberProperties(tree, doc, s.allOf), ...ctxProps };
    const parts = s.allOf.map((m, j) => synth(tree, doc, m, j === guided ? segs.slice(2) : [], depth + 1, choice, shared));
    if (parts.some(p => p === FAIL && guided >= 0)) return FAIL;
    const rest = synth(tree, doc, without(s, ['allOf']), guided >= 0 ? [] : segs, depth + 1, choice, shared);
    // Earlier wins on conflicts: the guided member, then the node's own
    // keywords (unions, pinned values), then the other members.
    const ordered = guided >= 0 ? [parts[guided], rest, ...parts.filter((_, j) => j !== guided)] : [rest, ...parts];
    return ordered.reduce((acc, p) => merge(acc, p), undefined);
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (!Array.isArray(s[key])) continue;
    const restSchema = without(s, [key]);
    if (segs[0] === 'anyOf' || segs[0] === 'oneOf') {
      const v = synth(tree, doc, s[key][Number(segs[1])], segs.slice(2), depth + 1, choice, ctxProps);
      return v === FAIL ? FAIL : merge(v, synth(tree, doc, restSchema, [], depth + 1, choice, ctxProps));
    }
    const len = s[key].length;
    const start = len ? choice % len : 0;
    const order = s[key].map((_, i) => (i + start) % len);
    for (const i of order) {
      const v = synth(tree, doc, s[key][i], [], depth + 1, choice, ctxProps);
      // The branch is more specific than its siblings: its values win.
      if (v !== FAIL) return merge(v, synth(tree, doc, restSchema, segs, depth + 1, choice, ctxProps));
    }
    return FAIL;
  }
  if ((segs[0] === 'then' || segs[0] === 'else') && s[segs[0]]) {
    return merge(synth(tree, doc, s[segs[0]], segs.slice(1), depth + 1, choice, ctxProps), synth(tree, doc, without(s, ['if', 'then', 'else']), [], depth + 1, choice, ctxProps));
  }
  if (Object.prototype.hasOwnProperty.call(s, 'const')) return segs.length ? FAIL : s.const;
  if (Array.isArray(s.enum) && s.enum.length) return segs.length ? FAIL : s.enum[choice % s.enum.length];
  const type = pickType(s);
  if (type === 'object') {
    const o = {};
    const props = ctxProps;
    for (const r of Array.isArray(s.required) ? s.required : []) {
      if (segs[0] === 'properties' && segs[1] === r) continue;
      const v = synth(tree, doc, props[r] === undefined ? (isObj(s.additionalProperties) ? s.additionalProperties : true) : props[r], [], depth + 1, choice, {});
      if (v === FAIL) return FAIL;
      o[r] = v;
    }
    // Optional properties pinned to one value usually discriminate a branch.
    if (isObj(s.properties)) {
      for (const [name, ps] of Object.entries(s.properties)) {
        if (!(name in o) && isObj(ps) && Object.prototype.hasOwnProperty.call(ps, 'const')) o[name] = ps.const;
      }
    }
    if (segs[0] === 'properties') {
      const v = synth(tree, doc, props[segs[1]], segs.slice(2), depth + 1, choice, {});
      if (v === FAIL) return FAIL;
      o[segs[1]] = v;
    } else if (segs[0] === 'additionalProperties') {
      const v = synth(tree, doc, s.additionalProperties, segs.slice(1), depth + 1, choice, {});
      if (v === FAIL) return FAIL;
      o.__witness_extra = v;
    } else if (segs[0] === 'dependencies') {
      if (!(segs[1] in o)) o[segs[1]] = synth(tree, doc, props[segs[1]], [], depth + 1, choice, {});
      const dep = s.dependencies && s.dependencies[segs[1]];
      if (isObj(dep)) return merge(o, synth(tree, doc, dep, segs.slice(2), depth + 1, choice, ctxProps));
    } else if (segs.length) return FAIL;
    if (isObj(s.dependencies)) {
      for (const [name, dep] of Object.entries(s.dependencies)) {
        if (!(name in o) || !Array.isArray(dep)) continue;
        for (const d of dep) if (!(d in o)) o[d] = synth(tree, doc, props[d], [], depth + 1, choice, {});
      }
    }
    return fillProperties(tree, doc, s, o, props, depth, choice);
  }
  if (type === 'array') {
    const guided = segs[0] === 'items' || segs[0] === 'contains';
    const n = Math.max(s.minItems || 0, guided ? 1 : 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      let item;
      if (Array.isArray(s.items)) item = s.items[i] === undefined ? (s.additionalItems === undefined ? true : s.additionalItems) : s.items[i];
      else item = s.items === undefined ? true : s.items;
      let rest = [];
      if (i === 0 && segs[0] === 'items') rest = Array.isArray(s.items) ? segs.slice(2) : segs.slice(1);
      if (i === 0 && segs[0] === 'contains') {
        item = s.contains;
        rest = segs.slice(1);
      }
      let v = synth(tree, doc, item, rest, depth + 1, choice, {});
      if (v === FAIL) return FAIL;
      if (s.uniqueItems && typeof v === 'string' && i > 0) v = `${v}${i}`;
      out.push(v);
    }
    if (segs.length && !guided) return FAIL;
    return out;
  }
  if (segs.length) return FAIL;
  if (type === 'string') return synthString(s);
  if (type === 'integer' || type === 'number') return synthNumber(s, type === 'integer');
  if (type === 'boolean') return true;
  return null;
}

/**
 * Object `o` with properties added until it has `minProperties`: the
 * schema's optional properties first, then names its `patternProperties` or
 * open `additionalProperties` admit.
 */
function fillProperties(tree, doc, s, o, props, depth, choice = 0) {
  const min = typeof s.minProperties === 'number' ? s.minProperties : 0;
  const count = () => Object.keys(o).length;
  for (const [name, ps] of Object.entries(props)) {
    if (count() >= min) return o;
    if (name in o) continue;
    const v = synth(tree, doc, ps, [], depth + 1, choice, {});
    if (v !== FAIL) o[name] = v;
  }
  const open = [];
  for (const [p, ps] of Object.entries(isObj(s.patternProperties) ? s.patternProperties : {})) {
    for (const name of sampleRegex(p)) open.push([name, ps]);
  }
  if (s.additionalProperties !== false) {
    for (let i = 0; i < 26; i++) open.push([String.fromCharCode(97 + i), isObj(s.additionalProperties) ? s.additionalProperties : true]);
  }
  for (const [name, ps] of open) {
    if (count() >= min) break;
    if (name in o) continue;
    const v = synth(tree, doc, ps, [], depth + 1, choice, {});
    if (v !== FAIL) o[name] = v;
  }
  return o;
}

/**
 * The pointer comes from one side: pointer segments without the leading
 * combinator steps that schema `s` does not have (an inline subschema where
 * the head has a `$ref`).
 */
function alignSegs(s, segs) {
  while (segs.length) {
    if (segs[0] === '$ref' && typeof s.$ref !== 'string') segs = segs.slice(1);
    else if (segs[0] === 'allOf' && !Array.isArray(s.allOf)) segs = segs.slice(2);
    else if ((segs[0] === 'anyOf' || segs[0] === 'oneOf') && !Array.isArray(s.anyOf) && !Array.isArray(s.oneOf)) segs = segs.slice(2);
    else break;
  }
  return segs;
}

/** Pointer segments from the first step into the instance (a property, an item), past combinator steps. */
function instanceSegs(segs) {
  let i = 0;
  while (i < segs.length) {
    if (['allOf', 'anyOf', 'oneOf'].includes(segs[i])) i += 2;
    else if (['$ref', 'then', 'else'].includes(segs[i])) i += 1;
    else break;
  }
  return segs.slice(i);
}

const sameJson = (a, b) => stableStringify(a) === stableStringify(b);
const omit = (o, k) => {
  const out = { ...o };
  delete out[k];
  return out;
};

/**
 * How many values branch `b` pins (its own or its properties' `const` and
 * `enum`, and its `type`) that instance `v` contradicts. Union branches are
 * tried in this order, so a value another conjunct already pinned keeps the
 * branch it selects.
 */
function conflicts(tree, doc, b, v) {
  const { doc: d, schema } = derefRaw(tree, doc, b);
  if (!isObj(schema)) return 0;
  let n = 0;
  if (schema.type !== undefined && accepts(tree, d, { type: schema.type }, v) === false) n += 10;
  if (isObj(v) && isObj(schema.properties)) {
    for (const [k, ps] of Object.entries(schema.properties)) {
      if (!(k in v) || !isObj(ps)) continue;
      const pin = {};
      if (Object.prototype.hasOwnProperty.call(ps, 'const')) pin.const = ps.const;
      if (Array.isArray(ps.enum)) pin.enum = ps.enum;
      if (Object.keys(pin).length && accepts(tree, d, pin, v[k]) === false) n += 1;
    }
  }
  return n;
}

/**
 * Instance `v` made to satisfy raw schema `s` (in document `doc`) where a
 * local edit can: the values `const` and `enum` pin, the properties
 * `required` and `minProperties` ask for, a valid value for a property of the
 * wrong type, the union branch the instance fits, the `then` or `else` its
 * `if` selects (or the other one, by making the `if` fail or hold), and no
 * property a closed object forbids. Each step is checked with the raw
 * evaluator; Ajv still confirms the result. The location pointer segments
 * `segs` lead to keeps its path. Returns a new value.
 */
function conform(tree, doc, s, v, segs, depth = 0, props0 = {}) {
  if (depth > MAX_DEPTH || !isObj(s) || v === FAIL || v === undefined) return v;
  if (accepts(tree, doc, s, v) === true) return v;
  segs = alignSegs(s, segs);
  // Conjuncts the pointer does not name still see the same instance: they
  // keep the instance path, not the combinator steps.
  const here = instanceSegs(segs);
  const ctxProps = isObj(s.properties) ? { ...props0, ...s.properties } : props0;
  const sub = (schema, value, rest = [], d = doc, props = {}) => conform(tree, d, schema, value, rest, depth + 1, props);
  let out = v;
  if (typeof s.$ref === 'string') {
    const t = refTarget(doc, s.$ref);
    const target = t && rawAt(tree, t);
    if (target !== undefined) out = sub(target, out, segs[0] === '$ref' ? segs.slice(1) : segs, t.doc, ctxProps);
  }
  if (!segs.length) {
    if (Object.prototype.hasOwnProperty.call(s, 'const')) return structuredClone(s.const);
    if (Array.isArray(s.enum) && s.enum.length && !s.enum.some(x => sameJson(x, out))) return structuredClone(s.enum[0]);
    if (s.type !== undefined && accepts(tree, doc, { type: s.type }, out) === false) {
      const fresh = synth(tree, doc, s, [], depth + 1, 0, props0);
      if (fresh !== FAIL) out = fresh;
    }
    const scalar = {};
    for (const k of ['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (k in s) scalar[k] = s[k];
    if (typeof out === 'string' && accepts(tree, doc, scalar, out) === false) out = synthString(s);
    else if (typeof out === 'number' && accepts(tree, doc, scalar, out) === false) out = synthNumber(s, Number.isInteger(out));
  }
  if (isObj(out)) out = conformObject(tree, doc, s, out, segs, depth, ctxProps);
  else if (Array.isArray(out)) out = conformArray(tree, doc, s, out, segs, depth);
  if (Array.isArray(s.allOf)) {
    const guided = segs[0] === 'allOf' ? Number(segs[1]) : -1;
    const shared = { ...memberProperties(tree, doc, s.allOf), ...ctxProps };
    s.allOf.forEach((m, j) => {
      out = sub(m, out, j === guided ? segs.slice(2) : here, doc, shared);
    });
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (!Array.isArray(s[key]) || !s[key].length) continue;
    const union = { [key]: s[key] };
    if (accepts(tree, doc, union, out) === true) continue;
    // The branch the pointer names first, then the others by how few of
    // their pinned values the instance contradicts.
    const guided = segs[0] === 'anyOf' || segs[0] === 'oneOf' ? Number(segs[1]) : -1;
    const order = s[key].map((b, i) => ({ i, n: i === guided ? -1 : conflicts(tree, doc, b, out) })).sort((a, b) => a.n - b.n || a.i - b.i);
    for (const { i } of order) {
      // A branch can take a few passes: a value one conjunct pins changes
      // which branch of a nested union fits.
      let cand = out;
      for (let pass = 0; pass < 3; pass++) {
        const next = sub(s[key][i], cand, i === guided ? segs.slice(2) : here, doc, ctxProps);
        const done = sameJson(next, cand);
        cand = next;
        if (done || accepts(tree, doc, union, cand) !== false) break;
      }
      if (accepts(tree, doc, union, cand) !== false) {
        out = cand;
        break;
      }
    }
  }
  if (segs[0] === 'then' || segs[0] === 'else') {
    if (s[segs[0]] !== undefined) out = sub(s[segs[0]], out, segs.slice(1), doc, ctxProps);
  } else if (s.if !== undefined) out = conformConditional(tree, doc, s, out, here, depth, ctxProps);
  if (s.not !== undefined && accepts(tree, doc, s.not, out) === true && isObj(out)) {
    // Drop a property the negated schema requires.
    const keys = requiredKeys(tree, doc, s.not).filter(k => k in out && !(here[0] === 'properties' && here[1] === k));
    for (const k of keys) {
      const cand = omit(out, k);
      if (accepts(tree, doc, s.not, cand) === false) {
        out = cand;
        break;
      }
    }
  }
  return out;
}

/** Property names a raw schema requires, its own and those of its union branches. */
function requiredKeys(tree, doc, s, depth = 0) {
  const { doc: d, schema } = derefRaw(tree, doc, s);
  if (!isObj(schema) || depth > 4) return [];
  const out = Array.isArray(schema.required) ? schema.required.filter(k => typeof k === 'string') : [];
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) for (const b of schema[key]) out.push(...requiredKeys(tree, d, b, depth + 1));
  }
  return [...new Set(out)];
}

function conformObject(tree, doc, s, o0, segs, depth, ctxProps) {
  const o = { ...o0 };
  const guided = segs[0] === 'properties' ? segs[1] : segs[0] === 'additionalProperties' ? '__witness_extra' : null;
  const own = isObj(s.properties) ? s.properties : {};
  const patterns = Object.entries(isObj(s.patternProperties) ? s.patternProperties : {}).map(([p, ps]) => {
    try {
      return [new RegExp(p, 'u'), ps];
    } catch {
      return [null, ps];
    }
  });
  const extra = isObj(s.additionalProperties) ? s.additionalProperties : true;
  const schemaOf = k => (ctxProps[k] !== undefined ? ctxProps[k] : (patterns.find(([re]) => re && re.test(k)) || [])[1] || extra);
  for (const r of Array.isArray(s.required) ? s.required : []) {
    if (r in o) continue;
    const v = synth(tree, doc, schemaOf(r), [], depth + 1, 0, {});
    if (v !== FAIL) o[r] = v;
  }
  for (const k of Object.keys(o)) {
    const rest = k === guided ? (guided === '__witness_extra' ? segs.slice(1) : segs.slice(2)) : [];
    let covered = false;
    if (Object.prototype.hasOwnProperty.call(own, k)) {
      covered = true;
      o[k] = conform(tree, doc, own[k], o[k], rest, depth + 1, {});
    }
    for (const [re, ps] of patterns) {
      if (re && re.test(k)) {
        covered = true;
        o[k] = conform(tree, doc, ps, o[k], rest, depth + 1, {});
      }
    }
    if (covered || s.additionalProperties === undefined) continue;
    if (s.additionalProperties === false) {
      if (k !== guided) delete o[k];
    } else o[k] = conform(tree, doc, s.additionalProperties, o[k], rest, depth + 1, {});
  }
  if (isObj(s.dependencies)) {
    for (const [name, dep] of Object.entries(s.dependencies)) {
      if (!(name in o)) continue;
      if (Array.isArray(dep)) {
        for (const d of dep) {
          if (d in o) continue;
          const v = synth(tree, doc, schemaOf(d), [], depth + 1, 0, {});
          if (v !== FAIL) o[d] = v;
        }
      }
    }
  }
  fillProperties(tree, doc, s, o, own, depth);
  if (typeof s.maxProperties === 'number') {
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    for (const k of Object.keys(o).reverse()) {
      if (Object.keys(o).length <= s.maxProperties) break;
      if (!required.has(k) && k !== guided) delete o[k];
    }
  }
  return o;
}

function conformArray(tree, doc, s, a0, segs, depth) {
  const a = [...a0];
  const tuple = Array.isArray(s.items);
  const guided = segs[0] === 'items' ? (tuple ? Number(segs[1]) : 0) : segs[0] === 'contains' ? 0 : -1;
  const rest = segs[0] === 'items' && tuple ? segs.slice(2) : segs.slice(1);
  const itemSchema = i => (tuple ? (s.items[i] === undefined ? (s.additionalItems === undefined ? true : s.additionalItems) : s.items[i]) : s.items === undefined ? true : s.items);
  for (let i = 0; i < a.length; i++) a[i] = conform(tree, doc, itemSchema(i), a[i], i === guided ? rest : [], depth + 1, {});
  while (typeof s.minItems === 'number' && a.length < s.minItems) {
    const v = synth(tree, doc, itemSchema(a.length), [], depth + 1, a.length, {});
    if (v === FAIL) break;
    a.push(v);
  }
  if (typeof s.maxItems === 'number' && a.length > s.maxItems) a.length = Math.max(s.maxItems, guided + 1);
  return a;
}

/**
 * Instance `out` with the `then` or `else` that its `if` selects applied.
 * When that branch cannot be satisfied, the condition is flipped: a property
 * the `if` requires is dropped (so `else` applies), or the instance is made to
 * satisfy the `if` (so `then` applies).
 */
function conformConditional(tree, doc, s, out, segs, depth, ctxProps) {
  const holds = accepts(tree, doc, s.if, out);
  if (holds === undefined) return out;
  const apply = (cond, inst) => {
    const b = cond ? s.then : s.else;
    if (b === undefined) return inst;
    const r = conform(tree, doc, b, inst, segs, depth + 1, ctxProps);
    return accepts(tree, doc, b, r) === false ? null : r;
  };
  const kept = apply(holds, out);
  if (kept) return kept;
  const flips = [];
  if (holds && isObj(out)) {
    const guided = segs[0] === 'properties' ? segs[1] : null;
    for (const k of requiredKeys(tree, doc, s.if)) if (k in out && k !== guided) flips.push(omit(out, k));
  } else if (!holds) flips.push(conform(tree, doc, s.if, out, segs, depth + 1, ctxProps));
  for (const f of flips) {
    if (accepts(tree, doc, s.if, f) !== !holds) continue;
    const r = apply(!holds, f);
    if (r) return r;
  }
  return out;
}

/** Instance `v` conformed to root schema `s` in a few passes, until the evaluator accepts it. */
function conformRoot(tree, doc, s, v, segs) {
  let out = v;
  for (let pass = 0; pass < 3 && out !== FAIL; pass++) {
    if (accepts(tree, doc, s, out) === true) break;
    const next = conform(tree, doc, s, out, segs);
    if (sameJson(next, out)) break;
    out = next;
  }
  return out;
}

/**
 * The raw schema object that holds a branch entry's union: the node at the
 * entry's location, or, for a conjunction member written behind the
 * location's `$ref` / `allOf` (pointer ending …/$ref/allOf/2), the object
 * those segments lead to. Returns { doc, node } or null.
 */
function branchHolder(tree, loc, segs) {
  const key = segs[segs.length - 2];
  const idx = Number(segs[segs.length - 1]);
  let node = rawAt(tree, loc);
  if (isObj(node) && Array.isArray(node[key]) && node[key][idx] !== undefined) return { doc: loc.doc, node };
  const trail = [];
  for (let i = segs.length - 3; i >= 1;) {
    if (segs[i] === '$ref') { trail.unshift('$ref'); i -= 1; }
    else if (/^\d+$/.test(segs[i]) && segs[i - 1] === 'allOf') { trail.unshift(`allOf/${segs[i]}`); i -= 2; }
    else break;
  }
  let doc = loc.doc;
  let ptr = loc.ptr;
  for (const step of trail) {
    if (step === '$ref') {
      const t = isObj(node) && typeof node.$ref === 'string' ? refTarget(doc, node.$ref) : null;
      if (!t) return null;
      doc = t.doc;
      ptr = t.ptr;
    } else ptr = `${ptr}/${step}`;
    node = rawAt(tree, { doc, ptr });
  }
  return isObj(node) ? { doc, node } : null;
}

/**
 * Instances that exercise different parts of a schema: for a union, each
 * branch; for an object, its required properties plus one optional property
 * at a time. Feeds if/then witnesses (an object valid for video requirements
 * is not valid for image requirements).
 */
function variants(tree, doc, schema, depth = 0) {
  const { doc: d, schema: s } = derefRaw(tree, doc, schema);
  if (depth > 3 || !isObj(s)) return [];
  const out = [];
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[key])) for (const b of s[key]) out.push(...variants(tree, d, b, depth + 1));
  }
  const base = synth(tree, d, s, [], 0, 0);
  if (base !== FAIL) out.push(base);
  if (isObj(s.properties) && isObj(base)) {
    for (const [k, ps] of Object.entries(s.properties).slice(0, 20)) {
      if (k in base) continue;
      const v = synth(tree, d, ps, [], 0, 0);
      if (v !== FAIL) out.push({ ...base, [k]: v });
    }
  }
  return out.slice(0, 200);
}

/** Follows a raw schema's `$ref` chain; returns { doc, schema }. */
function derefRaw(tree, doc, s, depth = 0) {
  if (depth > 8 || !isObj(s) || typeof s.$ref !== 'string') return { doc, schema: s };
  const t = refTarget(doc, s.$ref);
  const target = t && rawAt(tree, t);
  return target === undefined ? { doc, schema: s } : derefRaw(tree, t.doc, target, depth + 1);
}

/**
 * Property schemas visible at a location: its own `properties`, and those of
 * its parent and the parent's union branches when the location is a branch.
 */
function propertyPool(tree, loc) {
  const pool = {};
  const add = (docKey, raw) => {
    const { schema } = derefRaw(tree, docKey, raw);
    if (isObj(schema) && isObj(schema.properties)) {
      for (const [k, v] of Object.entries(schema.properties)) if (!(k in pool)) pool[k] = v;
    }
  };
  add(loc.doc, rawAt(tree, loc));
  const m = /^(.*)\/(anyOf|oneOf|allOf)\/\d+$/.exec(loc.ptr);
  if (m) {
    const parent = rawAt(tree, { doc: loc.doc, ptr: m[1] });
    add(loc.doc, parent);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (isObj(parent) && Array.isArray(parent[key])) parent[key].forEach(b => add(loc.doc, b));
    }
  }
  return pool;
}

/**
 * Values that probably violate raw schema `s` (each is confirmed with Ajv
 * later): a value of every JSON type, objects whose properties get such
 * values (one level of nesting), and instances of a `not` operand.
 */
function violations(tree, doc, s, depth = 0) {
  if (depth > 4 || !isObj(s)) return [];
  if (typeof s.$ref === 'string') {
    const t = refTarget(doc, s.$ref);
    const target = t && rawAt(tree, t);
    return target === undefined ? [] : violations(tree, t.doc, target, depth + 1);
  }
  const out = [null, 0, 1.5, 'x', true, [], {}];
  if (isObj(s.properties)) {
    for (const [name, ps] of Object.entries(s.properties).slice(0, 12)) {
      for (const v of violations(tree, doc, ps, depth + 1)) out.push({ [name]: v });
    }
  }
  if (isObj(s.not)) {
    const v = synth(tree, doc, s.not, [], 0, 0);
    if (v !== FAIL) out.push(v);
  }
  for (const m of Array.isArray(s.allOf) ? s.allOf : []) out.push(...violations(tree, doc, m, depth + 1).slice(7));
  return out;
}

/** Instance steps a schema pointer names, and whether the path ends in a branch. */
function instancePath(pointer) {
  const segs = pointer.split('/').slice(1).map(unescapePointer);
  const steps = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === 'properties') steps.push(segs[++i]);
    else if (s === 'additionalProperties') steps.push('__witness_extra');
    else if (s === 'items') {
      if (/^\d+$/.test(segs[i + 1] || '') ) steps.push(Number(segs[++i]));
      else steps.push(0);
    } else if (s === 'contains') steps.push(0);
    else if (['anyOf', 'oneOf', 'allOf', 'dependencies'].includes(s)) i++;
    else if (['$ref', 'then', 'else'].includes(s)) continue;
    else return null;
  }
  return { segs, steps };
}

function getAt(v, steps) {
  let cur = v;
  for (const s of steps) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setAt(v, steps, value) {
  if (steps.length === 0) return value === DELETE ? undefined : value;
  const copy = structuredClone(v);
  let cur = copy;
  for (const s of steps.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return FAIL;
    cur = cur[s];
  }
  if (cur === null || typeof cur !== 'object') return FAIL;
  const last = steps[steps.length - 1];
  if (value === DELETE) {
    if (Array.isArray(cur)) cur.splice(last, 1);
    else delete cur[last];
  } else cur[last] = value;
  return copy;
}

function stringMutations(s) {
  if (typeof s !== 'string') return [];
  return [`${s}x`, s.toUpperCase(), s.toLowerCase(), s.slice(1), `-${s}`, `${s} `, `${s}.5`, s.replace(/[a-z]/g, 'A'), s.replace(/\d/g, 'a'), s.repeat(3),
    `${s}\u00e9`, `${s}\n`, `${s}\u2014`, `${s}_`, `${s}/`, `${s}:`];
}

/**
 * Strings of the given lengths: the current string repeated and cut, and,
 * when the location has a `format` or `pattern` (`keep` holds them), the
 * current string with one of its characters repeated or removed at each
 * position, kept only when every format and pattern still accepts it (an
 * email address made long in its local part).
 */
function lengthVariants(cur, lengths, keep = null) {
  const base = typeof cur === 'string' && cur.length ? cur : 'a';
  const sizes = lengths.filter(n => Number.isInteger(n) && n >= 0 && n < 20000);
  const out = sizes.map(n => base.repeat(Math.ceil((n + 1) / base.length)).slice(0, n));
  if (!keep) return out;
  const chars = [...base];
  for (const n of sizes) {
    const d = n - chars.length;
    for (let i = 0; i < chars.length && i < 128; i++) {
      const s = d >= 0 ? [...chars.slice(0, i + 1), chars[i].repeat(d), ...chars.slice(i + 1)].join('') : [...chars.slice(0, i), ...chars.slice(i - d)].join('');
      if ([...s].length === n && keep(s)) out.push(s);
    }
  }
  return [...new Set(out)];
}

/** A test that every format and pattern in `formats` / `patterns` accepts a string, or null when there are none. */
function formatKeeper(formats, patterns) {
  if (!formats.length && !patterns.length) return null;
  const schemas = [...formats.map(f => ({ format: f })), ...patterns.map(p => ({ pattern: p }))];
  return s => schemas.every(sc => accepts(null, 'src:', sc, s) !== false);
}

/** Candidate values (or edits) at the instance location for one difference entry. */
function candidates(entry, ctx) {
  const k = entry.keyword;
  const o = entry.old;
  const n = entry.new;
  const out = [];
  const cur = ctx.current;
  // Constraint-derived objects go first, merged into the valid instance.
  if (isObj(cur)) for (const o of ctx.overlays || []) out.push({ ...cur, ...o });
  const nums = [o, n].filter(x => typeof x === 'number');
  const around = [...new Set(nums.flatMap(x => [x - 1, x, x + 1, x + 0.5]).concat(nums.length === 2 ? [(nums[0] + nums[1]) / 2] : []))].sort((p, q) => p - q);
  if (['maxLength', 'minLength'].includes(k)) out.push(...lengthVariants(cur, around, formatKeeper(ctx.formats || [], ctx.patterns)));
  if (['maxItems', 'minItems'].includes(k)) {
    const item = Array.isArray(cur) && cur.length ? cur[0] : 'a';
    for (const len of around) if (Number.isInteger(len) && len >= 0 && len < 1000) out.push(Array.from({ length: len }, (_, i) => (typeof item === 'string' ? `${item}${i || ''}` : structuredClone(item))));
  }
  if (['maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'multipleOf'].includes(k)) out.push(...around, ...around.map(Math.round));
  if (k === 'enum' || k === 'const') {
    const a = k === 'enum' ? (o || []) : o === undefined ? [] : [o];
    const b = k === 'enum' ? (n || []) : n === undefined ? [] : [n];
    const sa = new Set(a.map(stableStringify));
    const sb = new Set(b.map(stableStringify));
    out.push(...a.filter(x => !sb.has(stableStringify(x))), ...b.filter(x => !sa.has(stableStringify(x))));
  }
  if (k === 'required') {
    const a = new Set(o || []);
    const b = new Set(n || []);
    for (const p of [...b].filter(x => !a.has(x)).concat([...a].filter(x => !b.has(x)))) out.push({ deleteKey: p });
  }
  // A union added or removed as a whole: the instance without the properties
  // its branches require, one at a time and all of them.
  if ((k === 'anyOf' || k === 'oneOf') && isObj(cur) && (Array.isArray(o) !== Array.isArray(n))) {
    const keys = [...new Set((Array.isArray(o) ? o : n).flatMap(b => (isObj(b) && Array.isArray(b.required) ? b.required : [])).filter(p => p in cur))];
    for (const p of keys) out.push({ deleteKey: p });
    if (keys.length > 1) out.push(keys.reduce((acc, p) => omit(acc, p), cur));
  }
  // `uniqueItems` added or removed: the array with its first item repeated.
  if (k === 'uniqueItems' && Array.isArray(cur) && cur.length) out.push([...cur, structuredClone(cur[0])]);
  // `additionalProperties` added, removed or changed: the object with one
  // more property, of each JSON type.
  if (k === 'additionalProperties' && isObj(cur)) {
    for (const v of ['a', 1, true, null, {}, []]) out.push({ ...cur, __witness_extra: v });
  }
  // `minProperties` or `maxProperties`: objects with property counts around
  // the bounds, from the instance's own properties and copies of its first
  // value under new names.
  if ((k === 'minProperties' || k === 'maxProperties') && isObj(cur)) {
    const keys = Object.keys(cur);
    const filler = keys.length ? cur[keys[0]] : 'a';
    for (const count of around) {
      if (!Number.isInteger(count) || count < 0 || count > 64) continue;
      const obj = {};
      for (const key of keys.slice(0, count)) obj[key] = cur[key];
      for (let i = 0; Object.keys(obj).length < count; i++) obj[`x${i}`] = structuredClone(filler);
      out.push(obj);
    }
  }
  if (k === 'pattern' || ctx.patterns.length) {
    const pats = k === 'pattern' && typeof o === 'string' && typeof n === 'string' ? [o, n, ...ctx.patterns] : [...ctx.patterns, ...[o, n].filter(x => typeof x === 'string' && k === 'pattern')];
    // Corpus strings are many; with a pattern on each side keep only those
    // the two patterns disagree on, otherwise a bounded sample.
    let corpusStrings = ctx.corpusStrings.slice(0, 200);
    const res = pats.slice(0, 2).map(p => { try { return new RegExp(p, 'u'); } catch { return null; } });
    if (res.length >= 2 && res[0] && res[1]) corpusStrings = ctx.corpusStrings.filter(x => res[0].test(x) !== res[1].test(x)).slice(0, 200);
    // A pattern on one side only: the strings it rejects are the ones that tell the sides apart.
    else if (res.length && res[0]) corpusStrings = ctx.corpusStrings.filter(x => !res[0].test(x)).slice(0, 200);
    const strs = new Set([...pats.flatMap(sampleRegex), ...stringMutations(cur), ...corpusStrings]);
    out.push(...strs);
  }
  if (k === 'format') out.push(...Object.values(FORMAT_SAMPLES), 'not a valid value', '2026-13-45', 'http://', 'a b');
  if (k === 'properties') out.push(DELETE);
  for (const s of ctx.synthesized) out.push(s);
  if (typeof cur === 'string') out.push(...stringMutations(cur));
  out.push(...GENERIC);
  return out;
}

/**
 * Witnesses belong to one manifest line. A line's witness is a payload whose
 * verdict differs between base and head (in the declared direction) because
 * of that line: on a hybrid head where only that line's keyword is reverted
 * at its site, the payload gets the base verdict again. The search runs over
 * the line's own entries (its roots and pointers), so a line cannot pass on a
 * neighbouring line's payload, and a line that changes nothing finds none.
 * A line declared `none` passes only when no attributed witness is found.
 *
 * Separately, each site is searched in both directions without attribution:
 * a direction found there that no line at the site declares fails the site.
 * The search is not exhaustive: a missing witness is not a proof.
 */
async function generateWitnesses({ baseTree, headTree, manifest, match, corpus, validators: given }) {
  const validators = given || { base: new TreeValidator(baseTree), head: new TreeValidator(headTree) };
  const trees = { base: baseTree, head: headTree };
  const corpusStrings = corpus ? corpus.probes.map(p => p.value).filter(v => typeof v === 'string' && v.length < 200).slice(0, 5000) : [];
  const ctx = { trees, validators, corpus, corpusStrings };
  const byPointer = (a, b) => a.pointer.length - b.pointer.length || (a.root < b.root ? -1 : 1);
  const sites = new Map();
  const results = new Map();
  for (const change of manifest.changes) {
    const m = match && match.matched.find(x => x.change.index === change.index);
    if (!m) {
      results.set(change.index, { index: change.index, direction: change.direction, ok: false, payloads: [], reason: 'no matching difference' });
      continue;
    }
    const site = siteOf(m.entries[0]);
    if (!sites.has(site)) sites.set(site, { lines: [], entries: [] });
    sites.get(site).lines.push(change);
    sites.get(site).entries.push(...m.entries);

    // Per-line, attributed search over the line's own entries.
    const entries = [];
    const seenRoots = new Set();
    for (const e of [...m.entries].sort(byPointer)) {
      if (seenRoots.has(e.root)) continue;
      seenRoots.add(e.root);
      entries.push(e);
      if (entries.length === 4) break;
    }
    const res = { index: change.index, direction: change.direction, site, ok: false, payloads: [] };
    const reasons = [];
    const found = { tighten: null, loosen: null };
    const declared = change.direction === 'both' ? ['tighten', 'loosen'] : change.direction === 'none' ? [] : [change.direction];
    // Every entry of a line shares its site. A revert at the site itself
    // serves all of the line's roots; a revert that reaches the site through
    // a `$ref` holds for one referencing site, so roots that reach the site
    // from another one get their own reverted head. Each reverted head has
    // one lazily compiling Ajv.
    const hybrids = new Map();
    const hybridFor = (entry) => {
      const hybrid = revertedHead(trees, entry);
      if (!hybrid.tree) return hybrid;
      if (!hybrids.has(hybrid.tree.label)) hybrids.set(hybrid.tree.label, new TreeValidator(hybrid.tree, { lazy: true }));
      return { hv: hybrids.get(hybrid.tree.label) };
    };
    if (!entries.length) reasons.push('cannot attribute: no entries');
    let firstCompiled = true;
    let compileError = null;
    for (const entry of entries) {
      const hybrid = hybridFor(entry);
      if (!hybrid.hv) {
        reasons.push(`cannot attribute: ${hybrid.reason}`);
        continue;
      }
      const h = await hybrid.hv.get(`${entry.root}#`);
      if (typeof h !== 'function') {
        compileError = h.error;
        continue;
      }
      // Declared directions are searched on every root until found; the
      // other direction (an attributed witness the line does not declare)
      // only on the first root that compiles.
      const dirs = ['tighten', 'loosen'].filter(d => !found[d] && (declared.includes(d) || firstCompiled));
      firstCompiled = false;
      for (const dir of dirs) {
        const accept = dir === 'tighten' ? 'base' : 'head';
        const reject = dir === 'tighten' ? 'head' : 'base';
        // Reverting the line restores the base verdict.
        const attributed = (p) => (dir === 'tighten' ? h(p) : !h(p));
        found[dir] = await search(entry, accept, reject, ctx, attributed);
      }
      if (declared.every(d => found[d])) break;
    }
    // A recorded witness counts when the search finds none, and only when it
    // verifies: Ajv gives it the declared direction at base and head, and
    // with this line alone reverted it gets the base verdict again.
    const recordedReasons = [];
    for (const w of change.witness === undefined ? [] : [].concat(change.witness)) {
      const open = declared.filter(d => !found[d]);
      if (!open.length) break;
      const rel = normalizeRoot(w.root);
      const entry = m.entries.find(e => e.root === rel);
      if (!entry) {
        recordedReasons.push(`the recorded witness's root ${rel} is not one of this line's roots`);
        continue;
      }
      const vb = await validators.base.get(`${rel}#`);
      const vh = await validators.head.get(`${rel}#`);
      if (typeof vb !== 'function' || typeof vh !== 'function') {
        recordedReasons.push(`the recorded witness's root ${rel} does not compile`);
        continue;
      }
      const atBase = vb(w.instance);
      const atHead = vh(w.instance);
      const dir = atBase && !atHead ? 'tighten' : !atBase && atHead ? 'loosen' : null;
      if (!dir || !open.includes(dir)) {
        recordedReasons.push(`the recorded witness is ${atBase ? 'valid' : 'invalid'} at the base and ${atHead ? 'valid' : 'invalid'} at the head, not a ${open.join('/')}`);
        continue;
      }
      // Attributed to the line where its keyword can be reverted alone, else
      // to its site: the head with the whole schema at the site reverted.
      const hybrid = hybridFor(entry);
      let h = hybrid.hv ? await hybrid.hv.get(`${rel}#`) : null;
      let attribution = 'line';
      if (typeof h !== 'function') {
        const site = hybridFor({ ...entry, keyword: '(schema)' });
        const hs = site.hv ? await site.hv.get(`${rel}#`) : null;
        if (typeof hs !== 'function') {
          recordedReasons.push(`cannot attribute the recorded witness: ${hybrid.reason || 'the head with this line reverted does not compile'}`);
          continue;
        }
        h = hs;
        attribution = 'site';
      }
      if (dir === 'tighten' ? !h(w.instance) : h(w.instance)) {
        recordedReasons.push(`the recorded witness changes verdict for another reason: with this line reverted it is still ${dir === 'tighten' ? 'invalid' : 'valid'}`);
        continue;
      }
      found[dir] = { root: rel, payload: w.instance, at: [], recorded: true, attribution };
    }
    const observed = ['tighten', 'loosen'].filter(d => found[d]);
    if (firstCompiled && compileError) reasons.push(`cannot attribute: the head with this line reverted does not compile (${compileError})`);
    res.observed = observed;
    res.payloads = observed.map(d => payloadRecord(d, found[d]));
    const missing = declared.filter(d => !found[d]);
    const extra = observed.filter(d => !declared.includes(d));
    if (missing.length && !reasons.length) reasons.push(`no ${missing.join('/')} witness attributed to this line in ${entries.length} root(s)`);
    else if (missing.length) reasons.push(`no ${missing.join('/')} witness`);
    if (missing.length) reasons.push(...recordedReasons);
    if (extra.length) reasons.push(`a ${extra.join('/')} witness is attributed to this line, which declares ${change.direction}`);
    if (!missing.length && !extra.length) reasons.length = 0;
    if (observed.some(d => found[d].recorded)) res.from = 'recorded';
    res.ok = reasons.length === 0;
    if (reasons.length) res.reason = [...new Set(reasons)].join('; ');
    results.set(change.index, res);
  }

  // Per-site search in both directions, without attribution: a direction
  // the site shows that none of its lines declares is an undeclared change.
  for (const [site, group] of sites) {
    const declared = new Set(group.lines.flatMap(l => (l.direction === 'both' ? ['tighten', 'loosen'] : l.direction === 'none' ? [] : [l.direction])));
    const roots = [...new Set([...group.entries].sort(byPointer).map(e => e.root))].slice(0, 6);
    for (const dir of ['tighten', 'loosen']) {
      if (declared.has(dir)) continue;
      const accept = dir === 'tighten' ? 'base' : 'head';
      const reject = dir === 'tighten' ? 'head' : 'base';
      let hit = null;
      for (const root of roots) {
        for (const entry of group.entries.filter(e => e.root === root)) {
          hit = await search(entry, accept, reject, ctx, () => true);
          if (hit) break;
        }
        if (hit) break;
      }
      if (!hit) continue;
      for (const line of group.lines) {
        const r = results.get(line.index);
        r.ok = false;
        r.site_undeclared = payloadRecord(dir, hit);
        r.reason = [r.reason, `site ${site} has a ${dir} witness that no line at the site declares`].filter(Boolean).join('; ');
      }
    }
  }
  return [...results.values()].sort((a, b) => a.index - b.index);
}

function payloadRecord(dir, found) {
  return {
    kind: dir,
    ...(found.recorded ? { from: 'recorded', attribution: found.attribution } : {}),
    root: found.root,
    payload: found.payload,
    at: found.at.length ? `/${found.at.map(x => String(x).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '',
    value: getAt(found.payload, found.at),
    base: dir === 'tighten' ? 'valid' : 'invalid',
    head: dir === 'tighten' ? 'invalid' : 'valid',
  };
}

const PRIVATE_SUFFIX = '.witness-revert.json';
const BASE_SUFFIX = '.witness-base.json';

/**
 * Whether a map keyword's entry (`properties`, `patternProperties`,
 * `dependencies`) names one member: its pointer ends at a member that the
 * side with the value writes. Otherwise the whole map was added or removed,
 * as when a site now names a definition with `properties`; such an entry
 * renders the map itself, so a pointer that happens to end at a name of the
 * map is told apart by the rendered keys. `head` and `base` are the raw
 * schemas at the entry's locations.
 */
function mapMember(entry, head, base) {
  const kw = entry.keyword;
  if (!MAP.has(kw) && kw !== 'dependencies') return false;
  const segs = entry.pointer.split('/').map(unescapePointer);
  const name = segs[segs.length - 1];
  if (segs[segs.length - 2] !== kw) return false;
  const added = Object.prototype.hasOwnProperty.call(entry, 'new');
  const side = added ? head : base;
  if (!isObj(side) || !isObj(side[kw]) || side[kw][name] === undefined) return false;
  const value = added ? entry.new : entry.old;
  const keys = (o) => Object.keys(o).sort().join('\u0000');
  return !(isObj(value) && keys(value) === keys(side[kw]));
}

/**
 * The `$ref`s an entry's pointer follows through the head source, in order:
 * where each `$ref` is written (`holder`) and the location it names
 * (`target`). The walk stops at the first segment the source does not have.
 */
function refHops(tree, entry) {
  const hops = [];
  let doc = `src:${entry.root}`;
  let ptr = '';
  for (const seg of entry.pointer.split('/').slice(1).map(unescapePointer)) {
    const node = rawAt(tree, { doc, ptr });
    if (node === null || typeof node !== 'object') break;
    if (seg === '$ref') {
      const t = typeof node.$ref === 'string' ? refTarget(doc, node.$ref) : null;
      if (!t) break;
      hops.push({ holder: { doc, ptr }, target: t });
      doc = t.doc;
      ptr = t.ptr;
    } else {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) break;
      ptr = `${ptr}/${escapePointer(seg)}`;
    }
  }
  return hops;
}

/**
 * The hops to copy so that a revert at `loc` reaches only this entry's
 * referencing site: the last hop into `loc`'s document whose target holds
 * `loc`, and the `$ref`s that lead straight to it (a `$ref` to a schema that
 * is itself a `$ref`). Empty when no `$ref` leads to the location.
 */
function siteHops(hops, loc) {
  let k = -1;
  for (let i = hops.length - 1; i >= 0; i--) {
    const t = hops[i].target;
    if (t.doc === loc.doc && (loc.ptr === t.ptr || loc.ptr.startsWith(`${t.ptr}/`))) {
      k = i;
      break;
    }
  }
  if (k < 0) return [];
  let first = k;
  while (first > 0 && hops[first - 1].target.doc === hops[first].holder.doc && hops[first - 1].target.ptr === hops[first].holder.ptr) first--;
  return hops.slice(first, k + 1);
}

function refUrl(docKey, ptr) {
  const rel = docKey.slice(docKey.indexOf(':') + 1);
  return `/schemas/${rel}${ptr ? `#${ptr.split('/').map(s => encodeURIComponent(s)).join('/')}` : ''}`;
}

/**
 * A copy of raw schema `s`, written in document `docKey`, whose `$ref`s name
 * the same locations from any document: `url(target)` gives each one's new
 * value. Data keywords are left as they are.
 */
function absoluteRefs(s, docKey, url) {
  if (Array.isArray(s)) return s.map(x => absoluteRefs(x, docKey, url));
  if (!isObj(s)) return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === '$ref' && typeof v === 'string') {
      const t = refTarget(docKey, v);
      out[k] = t ? url(t) : v;
    } else if (['const', 'enum', 'default', 'examples'].includes(k)) out[k] = structuredClone(v);
    else out[k] = absoluteRefs(v, docKey, url);
  }
  return out;
}

/**
 * The head tree with one difference entry reverted at its site: the entry's
 * keyword at head_location gets the base value back, or is removed when the
 * base lacks it. Returns { tree }, or { reason } when the keyword as the
 * source writes it cannot be mapped back (it came from a normalization).
 *
 * When the constraint reaches the entry through a `$ref` (the head location
 * is a definition the entry's referencing site now names, and the base wrote
 * the constraint elsewhere), the revert edits a private copy of the
 * definition's document, and only that site's `$ref` (and the `$ref`s of a
 * chain that leads to it) names the copy. The definition's other users keep
 * the head's schema. A base value copied into another document keeps naming
 * what it named in the base: its `$ref`s become absolute.
 */
function revertedHead(trees, entry) {
  const loc = parseLocation(entry.head_location);
  if (!loc || !loc.doc.startsWith('src:')) return { reason: `site ${entry.head_location} is not a source schema` };
  const baseLoc = parseLocation(entry.base_location);
  const edits = new Map(); // source path -> the document the hybrid uses
  const editable = (docKey) => {
    const r = docKey.slice(4);
    if (!edits.has(r)) edits.set(r, structuredClone(trees.head.files.get(r)));
    return edits.get(r);
  };
  const privateRels = new Set();
  let rel = loc.doc.slice(4);
  const hops = baseLoc && entry.base_location !== entry.head_location ? siteHops(refHops(trees.head, entry), loc) : [];
  if (hops.some(h => !h.target.doc.startsWith('src:') || !h.holder.doc.startsWith('src:'))) return { reason: `cannot copy a released schema on the way to ${entry.head_location}` };
  if (hops.length) {
    // Copies are made from the last hop back, so each holder in a copied
    // document is edited in its copy.
    const copyOf = (docKey) => {
      const r = docKey.slice(4);
      const copy = r.replace(/\.json$/, '') + PRIVATE_SUFFIX;
      if (!edits.has(copy)) {
        edits.set(copy, structuredClone(trees.head.files.get(r)));
        privateRels.add(copy);
      }
      return copy;
    };
    for (let i = hops.length - 1; i >= 0; i--) {
      const { holder, target } = hops[i];
      const holderDoc = i > 0 ? edits.get(copyOf(holder.doc)) : editable(holder.doc);
      getPointer(holderDoc, holder.ptr).$ref = refUrl(`src:${copyOf(target.doc)}`, target.ptr);
    }
    rel = copyOf(loc.doc);
  }
  const docKey = `src:${rel}`;
  const doc = edits.has(rel) ? edits.get(rel) : editable(loc.doc);
  const raw = getPointer(doc, loc.ptr);
  if (!isObj(raw)) return { reason: `no schema object at ${entry.head_location}` };
  const baseRaw = rawAt(trees.base, baseLoc);
  // A base value keeps naming what it named where the base wrote it: the
  // head's schema at that location, or, when the head no longer has it (a
  // local definition the change moved out), a copy of the base document.
  const baseTarget = (t) => {
    if (!t.doc.startsWith('src:') || rawAt(trees.head, t) !== undefined) return refUrl(t.doc, t.ptr);
    const r = t.doc.slice(4);
    const copy = r.replace(/\.json$/, '') + BASE_SUFFIX;
    if (!edits.has(copy)) {
      edits.set(copy, structuredClone(trees.base.files.get(r)));
      privateRels.add(copy);
    }
    return refUrl(`src:${copy}`, t.ptr);
  };
  const fromBase = (v) => (baseLoc && (baseLoc.doc !== loc.doc || hops.length) ? absoluteRefs(v, baseLoc.doc, baseTarget) : structuredClone(v));
  const kw = entry.keyword;
  const has = (f) => Object.prototype.hasOwnProperty.call(entry, f);
  const written = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const segs = entry.pointer.split('/').map(unescapePointer);
  const last = segs[segs.length - 1];
  const UNIONS = ['anyOf', 'oneOf', 'allOf'];
  const branch = /^\d+$/.test(last) && UNIONS.includes(segs[segs.length - 2]) && UNIONS.includes(kw);
  if (kw === '(schema)') {
    // The whole node changed (for example `true` became a schema).
    // A synthetic base node (`true`) has no source location: use the base
    // file at the same path, or the rendered value.
    const atSite = rawAt(trees.base, { doc: loc.doc, ptr: loc.ptr });
    const before = baseRaw !== undefined ? fromBase(baseRaw)
      : atSite !== undefined ? structuredClone(atSite)
        : typeof entry.old === 'boolean' ? entry.old : undefined;
    if (before === undefined) return { reason: `no base schema at ${entry.base_location}` };
    if (loc.ptr === '') edits.set(rel, before);
    else setPointer(doc, loc.ptr, before);
    return finish(`the schema at ${entry.head_location} reverted`);
  }
  if (branch) {
    const key = segs[segs.length - 2];
    const idx = Number(last);
    // A conjunction member can be written behind the location's `$ref` or
    // `allOf` (the pointer ends …/$ref/allOf/2): follow those segments.
    const trail = [];
    for (let i = segs.length - 3; i >= 1; ) {
      if (segs[i] === '$ref') { trail.unshift('$ref'); i -= 1; }
      else if (/^\d+$/.test(segs[i]) && segs[i - 1] === 'allOf') { trail.unshift(`allOf/${segs[i]}`); i -= 2; }
      else break;
    }
    if (!(Array.isArray(raw[key]) && raw[key][idx] !== undefined) && trail.length) {
      let at = docKey;
      let ptr = loc.ptr;
      let node = raw;
      for (const step of trail) {
        if (step === '$ref') {
          const t = isObj(node) && typeof node.$ref === 'string' ? refTarget(at, node.$ref) : null;
          if (!t || !t.doc.startsWith('src:')) return { reason: `cannot follow $ref from ${entry.head_location}` };
          at = t.doc;
          ptr = t.ptr;
        } else ptr = `${ptr}/${step}`;
        node = getPointer(edits.has(at.slice(4)) ? edits.get(at.slice(4)) : editable(at), ptr);
      }
      if (!isObj(node)) return { reason: `no schema object behind ${entry.head_location}` };
      return revertBranch(node, key, idx);
    }
    return revertBranch(raw, key, idx);
  }
  return revertKeyword();

  function revertBranch(target, key, idx) {
    if (has('new') && !has('old')) {
      if (!Array.isArray(target[key]) || target[key][idx] === undefined) return { reason: `${key}/${idx} is not written at ${entry.head_location}` };
      target[key].splice(idx, 1);
      // An empty allOf is an invalid schema; no members means no keyword.
      if (target[key].length === 0) delete target[key];
    } else if (has('old') && !has('new')) {
      const b = isObj(baseRaw) && Array.isArray(baseRaw[key]) ? baseRaw[key][idx] : undefined;
      if (b === undefined) return { reason: `${key}/${idx} is not written at ${entry.base_location}` };
      target[key] = [...(Array.isArray(target[key]) ? target[key] : []), fromBase(b)];
    } else return { reason: `cannot revert a ${key} branch change` };
    return finish(`${kw} reverted at ${entry.head_location}`);
  }

  function revertKeyword() {
    if (mapMember(entry, raw, baseRaw)) {
      if (has('new') && !has('old')) delete raw[kw][last];
      else raw[kw] = { ...raw[kw], [last]: fromBase(baseRaw[kw][last]) };
    } else if (VALUE.has(kw)) {
      // `const` may be written as a one-value `enum`.
      const oneValueEnum = kw === 'const' && Array.isArray(raw.enum) && raw.enum.length === 1;
      if (has('new') && !written(kw) && !oneValueEnum) return { reason: `${kw} at ${entry.head_location} comes from a normalization, not the source` };
      if (oneValueEnum) delete raw.enum;
      if (kw === 'enum' && written('const')) delete raw.const;
      if (has('old')) raw[kw] = structuredClone(entry.old);
      else delete raw[kw];
    } else if (SINGLE.has(kw) || MAP.has(kw) || UNION.has(kw) || kw === 'items' || kw === 'dependencies') {
      // A keyword whose value holds subschemas comes back as the base wrote it.
      if (has('new') && !written(kw)) return { reason: `${kw} at ${entry.head_location} comes from a normalization, not the source` };
      if (has('old')) {
        const b = isObj(baseRaw) ? baseRaw[kw] : undefined;
        if (b === undefined) return { reason: `${kw} is not written at ${entry.base_location}` };
        raw[kw] = fromBase(b);
      } else delete raw[kw];
    } else {
      return { reason: `no revert for keyword ${kw}` };
    }
    return finish(`${kw} reverted at ${entry.head_location}`);
  }

  function finish(what) {
    const files = new Map(trees.head.files);
    for (const [r, d] of edits) {
      // A private copy is its own document.
      if (privateRels.has(r) && isObj(d) && typeof d.$id === 'string') d.$id = `/schemas/${r}`;
      files.set(r, d);
    }
    const via = hops.length ? ` for ${originLabel(hops[0].holder)} only` : '';
    return { tree: { label: `${trees.head.label} with ${what}${via}`, commit: null, files, readDist: trees.head.readDist } };
  }
}

function setPointer(doc, ptr, value) {
  const segs = ptr.split('/').slice(1).map(unescapePointer);
  let cur = doc;
  for (const seg of segs.slice(0, -1)) cur = cur[seg];
  cur[segs[segs.length - 1]] = value;
  return doc;
}

async function search(entry, accept, reject, { trees, validators, corpus, corpusStrings }, attributed = () => true) {
  const location = `${entry.root}#`;
  const va = await validators[accept].get(location);
  const vr = await validators[reject].get(location);
  if (typeof va !== 'function' || typeof vr !== 'function') return null;
  const ok = (p) => p !== FAIL && p !== undefined && va(p) && !vr(p) && attributed(p);
  const path = instancePath(entry.pointer);
  if (!path) return null;
  const steps = path.steps;
  // A branch/member entry (…/anyOf/3) and a property-presence entry name a
  // location below the node; `required` names the object itself.
  const branchEntry = /\/(anyOf|oneOf|allOf)\/\d+$/.test(entry.pointer) && ['anyOf', 'oneOf', 'allOf'].includes(entry.keyword);
  const wholeMap = entry.keyword === 'properties'
    && !mapMember(entry, rawAt(trees.head, parseLocation(entry.head_location)), rawAt(trees.base, parseLocation(entry.base_location)));

  const seeds = [];
  if (corpus) for (const b of corpus.bound) if (b.schema === location) seeds.push(b.instance);
  for (const side of [accept, reject]) {
    const doc = `src:${entry.root}`;
    const root = rawAt(trees[side], { doc, ptr: '' });
    // Each instance as synthesized, and conformed to the whole root (an
    // `if` elsewhere in the root, a union branch, a pinned value).
    for (const choice of [0, 1, 2, 3, 4, 5]) {
      const guided = synth(trees[side], doc, root, path.segs, 0, choice);
      if (guided !== FAIL) seeds.push(guided, conformRoot(trees[side], doc, root, guided, path.segs));
    }
    const plain = synth(trees[side], doc, root, [], 0, 0);
    if (plain !== FAIL) seeds.push(plain, conformRoot(trees[side], doc, root, plain, []));
  }
  const synthesized = [];
  const patterns = [];
  const formats = [];
  const overlays = [];
  for (const [side, label] of [['base', entry.base_location], ['head', entry.head_location]]) {
    const loc = parseLocation(label);
    let raw = rawAt(trees[side], loc);
    if (raw === undefined) continue;
    const pool = propertyPool(trees[side], loc);
    if (branchEntry) {
      const segs = entry.pointer.split('/').map(unescapePointer);
      const idx = Number(segs[segs.length - 1]);
      const key = segs[segs.length - 2];
      const holder = branchHolder(trees[side], loc, segs);
      raw = holder && Array.isArray(holder.node[key]) ? holder.node[key][idx] : undefined;
      if (holder) loc.doc = holder.doc;
    } else if (entry.keyword === 'properties' && !wholeMap) {
      const name = unescapePointer(entry.pointer.split('/').pop());
      raw = isObj(raw) && isObj(raw.properties) ? raw.properties[name] : undefined;
    }
    if (raw === undefined) continue;
    // A whole map: objects whose properties take values the map's schemas
    // may reject, merged into the valid instance.
    if (wholeMap && isObj(raw)) for (const bad of violations(trees[side], loc.doc, raw)) if (isObj(bad)) overlays.push(bad);
    if (isObj(raw) && typeof raw.pattern === 'string') patterns.push(raw.pattern);
    const fmt = derefRaw(trees[side], loc.doc, raw).schema;
    if (isObj(fmt) && typeof fmt.format === 'string') formats.push(fmt.format);
    // Candidates built from the constraint itself, merged into the valid
    // instance at the location: what a `not` excludes, and an instance that
    // satisfies an `if` and violates its `then`.
    // Property values come from the schemas the site and its sibling
    // branches declare, so the merged instance stays valid elsewhere.
    if (isObj(raw) && isObj(raw.not)) {
      // With placeholder values ({}) and with values the site's own
      // property schemas accept: either can be the one the base admits.
      for (const [choice, props] of [[0, {}], [0, pool], [1, pool], [2, pool]]) {
        const v = synth(trees[side], loc.doc, raw.not, [], 0, choice, props);
        if (v === FAIL) continue;
        synthesized.push(v);
        if (isObj(v)) overlays.push(v);
      }
      // A guard on an either/or pair (not: {required: [k]}): the witness
      // carries k with a value the other branch rejects, so the base matches
      // exactly one branch and the head none.
      const keys = Array.isArray(raw.not.required) ? raw.not.required.filter(k => typeof k === 'string') : [];
      for (const g of [null, 'x', 0, true, [], {}]) {
        if (keys.length) overlays.push(Object.fromEntries(keys.map(k => [k, g])));
      }
    }
    // An added or changed `oneOf`: objects that two of its branches accept,
    // which the `oneOf` rejects.
    if (isObj(raw) && entry.keyword === 'oneOf' && Array.isArray(raw.oneOf)) {
      const branches = raw.oneOf.slice(0, 8).map(b => synth(trees[side], loc.doc, b, [], 0, 0, pool));
      for (let i = 0; i < branches.length; i++) {
        for (let j = i + 1; j < branches.length; j++) {
          if (isObj(branches[i]) && isObj(branches[j])) overlays.push({ ...branches[i], ...branches[j] }, { ...branches[j], ...branches[i] });
        }
      }
    }
    if (isObj(raw) && raw.if !== undefined && raw.then !== undefined) {
      const ifv = synth(trees[side], loc.doc, raw.if, [], 0, 0, pool);
      if (ifv !== FAIL) {
        const bads = violations(trees[side], loc.doc, raw.then);
        // Values another branch of the property's own schema accepts (an
        // object valid for video requirements but not for image ones).
        const then = derefRaw(trees[side], loc.doc, raw.then);
        if (isObj(then.schema) && isObj(then.schema.properties)) {
          for (const name of Object.keys(then.schema.properties)) {
            if (pool[name] === undefined) continue;
            for (const v of variants(trees[side], loc.doc, pool[name])) bads.push({ [name]: v });
          }
        }
        for (const bad of bads) {
          if (isObj(ifv) && isObj(bad)) overlays.push({ ...ifv, ...bad });
          else if (!isObj(ifv)) synthesized.push(bad);
        }
      }
    }
    if (isObj(raw)) for (const bad of violations(trees[side], loc.doc, raw)) if (!isObj(bad)) synthesized.push(bad);
    for (const choice of [0, 1]) {
      const v = synth(trees[side], loc.doc, raw, [], 0, choice);
      if (v !== FAIL) synthesized.push(v);
    }
  }

  const seen = new Set();
  for (const seed of seeds) {
    const key = stableStringify(seed);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!va(seed)) continue;
    if (ok(seed)) return { root: entry.root, payload: seed, at: steps };
    const current = getAt(seed, steps);
    const ctx = { current, synthesized, patterns, formats, corpusStrings, overlays };
    for (const cand of candidates(entry, ctx)) {
      let payload;
      if (cand && typeof cand === 'object' && cand.deleteKey !== undefined) {
        const obj = getAt(seed, steps);
        if (!isObj(obj) || !(cand.deleteKey in obj)) continue;
        payload = setAt(seed, [...steps, cand.deleteKey], DELETE);
      } else payload = setAt(seed, steps, cand);
      if (ok(payload)) return { root: entry.root, payload, at: steps };
    }
  }
  return null;
}

module.exports = { generateWitnesses, synth, instancePath };
