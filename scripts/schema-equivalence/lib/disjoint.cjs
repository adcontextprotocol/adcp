'use strict';

/**
 * The disjointness prover: decides, for two schema nodes and the context
 * that holds where they are evaluated, that no instance can satisfy both
 * under Ajv's semantics with the repo's options. It never guesses: a rule
 * concludes "disjoint" only from facts that hold for every instance, and
 * every other case returns null ("not proven").
 *
 * Facts are read from a node's own keywords and its conjunction members
 * (`allOf`, `$ref` with siblings). Rules, in the order they are tried:
 *
 *   types              the possible JSON types do not overlap (`integer` is
 *                      inside `number`; `const`/`enum` narrow the type; a
 *                      `not` over a schema that accepts every value of a type
 *                      removes that type, so `not: {required: [k]}` leaves
 *                      only objects).
 *   values             the `const`/`enum` value sets do not overlap.
 *   tag-values         objects only, a property required by both, and its
 *                      `const`/`enum` value sets do not overlap.
 *   property-schemas   objects only, a property required by both, and the
 *                      prover shows its two schemas disjoint.
 *   closed-object      objects only, one branch requires a key that the
 *                      other's `additionalProperties: false` (with that same
 *                      object's `properties` and `patternProperties`) or a
 *                      `false` property schema forbids.
 *   not-implied        every instance of one branch satisfies a schema that
 *                      the other branch negates with `not` (required keys,
 *                      pinned values, the same referenced schema).
 *   not-alternatives   one branch needs one of several alternatives (`anyOf`,
 *                      or `oneOf` without `discriminator`), and every
 *                      alternative implies the other branch's `not` operand.
 *   finite-values      one branch allows finitely many values, and the
 *                      evaluator shows that the other branch rejects each.
 *   array-items        arrays only, the instance needs an item, and the
 *                      prover shows the two item schemas disjoint.
 *
 * `required`, `properties`, `additionalProperties` and the other object
 * keywords say nothing about non-objects, so the object rules need the
 * object-only condition; `minItems` and `items` likewise need arrays only.
 * `additionalProperties` sees only the `properties` and `patternProperties`
 * of its own schema object, and the canonical form never merges another
 * member's `properties` into such an object (graph.cjs `_mergePlain`), so a
 * closed object is read one schema object at a time.
 */

const { stableStringify, jsonType } = require('./json.cjs');
const { originLabel, KEYWORD_TYPE } = require('./graph.cjs');

let fullFormats = {};
try {
  ({ fullFormats } = require('ajv-formats/dist/formats'));
} catch {
  fullFormats = {};
}

const ALL = ['null', 'boolean', 'object', 'array', 'string', 'int', 'frac'];
const TYPE_NAMES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const MAX_DEPTH = 6;
const UPPER = new Set(['maxLength', 'maxItems', 'maxProperties', 'maximum', 'exclusiveMaximum']);
const LOWER = new Set(['minLength', 'minItems', 'minProperties', 'minimum', 'exclusiveMinimum']);
const FORMAT_KEYWORDS = new Set(['format', 'formatMaximum', 'formatMinimum', 'formatExclusiveMaximum', 'formatExclusiveMinimum']);

function typeSet(types) {
  const out = new Set();
  for (const t of types) {
    if (t === 'number') { out.add('int'); out.add('frac'); }
    else if (t === 'integer') out.add('int');
    else out.add(t);
  }
  return out;
}

function valueKinds(values) {
  const out = new Set();
  for (const v of values) {
    const t = jsonType(v);
    out.add(t === 'integer' ? 'int' : t === 'number' ? 'frac' : t);
  }
  return out;
}

function intersect(a, b) {
  if (a === null || a === undefined) return b === undefined ? null : b;
  if (b === null || b === undefined) return a;
  return new Set([...a].filter(x => b.has(x)));
}

function subset(a, b) {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function disjointSets(a, b) {
  if (a === null || b === null) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/** Whether keyword `k` constrains instances of type kind `t` (Ajv runs it for that type). */
function appliesTo(k, t) {
  if (FORMAT_KEYWORDS.has(k)) return t === 'string' || t === 'int' || t === 'frac';
  const kt = KEYWORD_TYPE.get(k);
  if (!kt) return true;
  if (kt === 'number') return t === 'int' || t === 'frac';
  return kt === t;
}

/** Whether keyword `k` is vacuous for every type kind in `types` (a non-null set). */
function vacuous(k, types) {
  if (types === null) return false;
  for (const t of types) if (appliesTo(k, t)) return false;
  return true;
}

function isFalse(graph, id) {
  const n = graph.nodes[graph.resolve(id).n];
  return n.kind === 'bool' && n.value === false;
}

function isTrue(graph, id) {
  const n = graph.nodes[graph.resolve(id).n];
  return n.kind === 'bool' && n.value === true;
}

/** The non-conjunction nodes a node is the conjunction of, resolved. */
function expand(graph, id, out = [], seen = new Set()) {
  const r = graph.resolve(id).n;
  if (seen.has(r)) return out;
  seen.add(r);
  const node = graph.nodes[r];
  if (node.kind === 'conj') for (const m of graph.conjMembers(node)) expand(graph, m.n, out, seen);
  else out.push(node);
  return out;
}

/**
 * True when node `id` accepts every instance of type kind `t`. Conservative:
 * any keyword that applies to `t` and is not a `type` that allows it, or an
 * `anyOf` with such a branch, makes it false.
 */
function acceptsAll(graph, id, t, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  const node = graph.nodes[graph.resolve(id).n];
  if (node.kind === 'bool') return node.value;
  if (node.kind === 'conj') return graph.conjMembers(node).every(m => acceptsAll(graph, m.n, t, depth + 1));
  if (node.kind !== 'plain') return false;
  for (const [k, v] of Object.entries(node.kw)) {
    if (!appliesTo(k, t)) continue;
    if (k === 'type' && Array.isArray(v) && v.every(x => TYPE_NAMES.has(x)) && node.kw.nullable === undefined) {
      if (!typeSet(v).has(t)) return false;
      continue;
    }
    return false;
  }
  for (const [k, v] of Object.entries(node.kids)) {
    if (!appliesTo(k, t)) continue;
    if (k === 'anyOf') {
      if (!v.some(r => acceptsAll(graph, graph.kid(r).n, t, depth + 1))) return false;
      continue;
    }
    return false;
  }
  return true;
}

const factsCache = new WeakMap();

/**
 * Facts about the instances a node accepts, read from its own keywords and
 * its conjunction members:
 *   types       possible type kinds (null: any)
 *   values      stable-JSON value set (null: unbounded)
 *   required    keys every object instance has
 *   props       property name -> stable-JSON value set of its schema (null: unbounded)
 *   propNodes   property name -> schema node ids that apply to its value
 *   forbidden   keys no object instance has (a `false` property schema)
 *   closed      per closed schema object: { names, patterns } it allows
 *   items       item schema ids (non-tuple `items`) and the largest `minItems`
 *   nots        `not` operand ids
 *   unions      per `anyOf` (or `oneOf` without `discriminator`): branch ids
 *   narrowedBy  'not' when a `not` removed types
 */
function facts(graph, id) {
  let cache = factsCache.get(graph);
  if (!cache) factsCache.set(graph, (cache = new Map()));
  const r = graph.resolve(id).n;
  if (cache.has(r)) return cache.get(r);
  const out = membersFacts(graph, expand(graph, r));
  cache.set(r, out);
  return out;
}

function membersFacts(graph, nodes) {
  let types = null;
  let values = null;
  let narrowedBy = null;
  const required = new Set();
  const props = new Map();
  const propNodes = new Map();
  const forbidden = new Set();
  const closed = [];
  const items = [];
  let minItems = 0;
  const nots = [];
  const unions = [];
  const plains = [];
  for (const p of nodes) {
    if (p.kind === 'bool') {
      if (!p.value) types = new Set();
      continue;
    }
    if (p.kind !== 'plain') continue;
    plains.push(p);
    if (Array.isArray(p.kw.type) && p.kw.type.every(t => TYPE_NAMES.has(t))) {
      types = intersect(types, typeSet(p.kw.nullable === true ? [...p.kw.type, 'null'] : p.kw.type));
    }
    if (Object.prototype.hasOwnProperty.call(p.kw, 'const')) values = intersect(values, new Set([stableStringify(p.kw.const)]));
    else if (Array.isArray(p.kw.enum)) values = intersect(values, new Set(p.kw.enum.map(stableStringify)));
    if (Array.isArray(p.kw.required)) for (const k of p.kw.required) required.add(k);
    if (typeof p.kw.minItems === 'number') minItems = Math.max(minItems, p.kw.minItems);
    if (p.kids.properties) {
      for (const [name, ref] of Object.entries(p.kids.properties)) {
        const n = graph.kid(ref).n;
        if (isFalse(graph, n)) forbidden.add(name);
        const vs = valueSetOf(graph, n);
        props.set(name, intersect(props.has(name) ? props.get(name) : null, vs));
        if (!propNodes.has(name)) propNodes.set(name, []);
        propNodes.get(name).push(n);
      }
    }
    if (p.kids.additionalProperties && isFalse(graph, graph.kid(p.kids.additionalProperties).n)) {
      const names = new Set(Object.entries(p.kids.properties || {}).filter(([, ref]) => !isFalse(graph, graph.kid(ref).n)).map(([k]) => k));
      closed.push({ names, patterns: Object.keys(p.kids.patternProperties || {}), origin: p.origin });
    }
    if (p.kids.items && !p.kids.items.tuple) items.push(graph.kid(p.kids.items).n);
    if (p.kids.not) {
      const n = graph.kid(p.kids.not).n;
      nots.push(n);
      const excluded = ALL.filter(t => acceptsAll(graph, n, t));
      if (excluded.length) {
        const before = types;
        types = intersect(types, new Set(ALL.filter(t => !excluded.includes(t))));
        if (before === null || before.size !== types.size) narrowedBy = 'not';
      }
    }
    if (p.kids.anyOf) unions.push({ key: 'anyOf', ids: p.kids.anyOf.map(x => graph.kid(x).n) });
    if (p.kids.oneOf && p.kw.discriminator === undefined) unions.push({ key: 'oneOf', ids: p.kids.oneOf.map(x => graph.kid(x).n) });
  }
  if (values !== null) types = intersect(types, valueKinds([...values].map(v => JSON.parse(v))));
  return { types, values, required, props, propNodes, forbidden, closed, items, minItems, nots, unions, plains, narrowedBy };
}

/** The `const`/`enum` value set of a node (null: unbounded), from its own schema objects only. */
function valueSetOf(graph, id) {
  let values = null;
  for (const p of expand(graph, id)) {
    if (p.kind === 'bool' && !p.value) values = new Set();
    if (p.kind !== 'plain') continue;
    if (Object.prototype.hasOwnProperty.call(p.kw, 'const')) values = intersect(values, new Set([stableStringify(p.kw.const)]));
    else if (Array.isArray(p.kw.enum)) values = intersect(values, new Set(p.kw.enum.map(stableStringify)));
  }
  return values;
}

/** A pattern as Ajv compiles it (`u` flag), or null when it does not compile. */
const regexCache = new Map();
function regex(p) {
  if (regexCache.has(p)) return regexCache.get(p);
  let re = null;
  try {
    re = new RegExp(p, 'u');
  } catch {
    re = null;
  }
  regexCache.set(p, re);
  return re;
}

/** Whether a closed schema object lets key `k` be present. */
function closedAllows(c, k) {
  if (c.names.has(k)) return true;
  for (const p of c.patterns) {
    const re = regex(p);
    if (!re || re.test(k)) return true;
  }
  return false;
}

/** Whether no object instance with these facts can carry key `k`. */
function keyForbidden(f, k) {
  return f.forbidden.has(k) || f.closed.some(c => !closedAllows(c, k));
}

// ---- Evaluator: three-valued Ajv semantics on a scalar value.

function sameValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function typeMatches(t, v) {
  const j = jsonType(v);
  if (t === 'integer') return j === 'integer';
  if (t === 'number') return j === 'integer' || j === 'number';
  return t === j;
}

function formatResult(name, v) {
  const def = fullFormats[name];
  if (def === undefined) return undefined;
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
  if (check === true) return true;
  return undefined;
}

/**
 * Validates value `v` against node `id`: true (Ajv accepts), false (Ajv
 * rejects), or undefined (not decided here). Object and array values are
 * decided only by `type`, `const`, and `enum`.
 */
function evaluate(graph, id, v, depth = 0) {
  if (depth > 16) return undefined;
  const node = graph.nodes[graph.resolve(id).n];
  if (node.kind === 'bool') return node.value;
  const all = (results) => (results.some(x => x === false) ? false : results.every(x => x === true) ? true : undefined);
  if (node.kind === 'conj') return all(graph.conjMembers(node).map(m => evaluate(graph, m.n, v, depth + 1)));
  if (node.kind !== 'plain' || node.kw.nullable !== undefined) return undefined;
  const j = jsonType(v);
  const kind = j === 'integer' ? 'int' : j === 'number' ? 'frac' : j;
  const scalar = j !== 'object' && j !== 'array';
  const results = [];
  for (const [k, s] of Object.entries(node.kw)) {
    if (!appliesTo(k, kind)) continue;
    if (k === 'type') {
      if (!Array.isArray(s) || !s.every(t => TYPE_NAMES.has(t))) results.push(undefined);
      else results.push(s.some(t => typeMatches(t, v)));
    } else if (k === 'const') results.push(sameValue(s, v));
    else if (k === 'enum') results.push(Array.isArray(s) ? s.some(x => sameValue(x, v)) : undefined);
    else if (!scalar) results.push(undefined);
    else if (k === 'pattern') {
      const re = typeof s === 'string' ? regex(s) : null;
      results.push(re ? re.test(v) : undefined);
    } else if (k === 'minLength' || k === 'maxLength') {
      const n = [...v].length;
      results.push(typeof s !== 'number' ? undefined : k === 'minLength' ? n >= s : n <= s);
    } else if (k === 'minimum') results.push(typeof s === 'number' ? v >= s : undefined);
    else if (k === 'maximum') results.push(typeof s === 'number' ? v <= s : undefined);
    else if (k === 'exclusiveMinimum') results.push(typeof s === 'number' ? v > s : undefined);
    else if (k === 'exclusiveMaximum') results.push(typeof s === 'number' ? v < s : undefined);
    else if (k === 'format') results.push(typeof s === 'string' ? formatResult(s, v) : undefined);
    else results.push(undefined);
  }
  for (const [k, ref] of Object.entries(node.kids)) {
    if (!appliesTo(k, kind)) continue;
    if (k === 'not') {
      const r = evaluate(graph, graph.kid(ref).n, v, depth + 1);
      results.push(r === undefined ? undefined : !r);
    } else if (k === 'anyOf' || k === 'oneOf') {
      if (k === 'oneOf' && node.kw.discriminator !== undefined) {
        results.push(j === 'object' ? undefined : true);
        continue;
      }
      const rs = ref.map(x => evaluate(graph, graph.kid(x).n, v, depth + 1));
      if (k === 'anyOf') results.push(rs.some(x => x === true) ? true : rs.every(x => x === false) ? false : undefined);
      else if (rs.some(x => x === undefined)) results.push(undefined);
      else results.push(rs.filter(Boolean).length === 1);
    } else if (k === 'if') {
      const c = evaluate(graph, graph.kid(ref).n, v, depth + 1);
      const branch = c === undefined ? undefined : c ? node.kids.then : node.kids.else;
      if (c === undefined) results.push(undefined);
      else if (branch) results.push(evaluate(graph, graph.kid(branch).n, v, depth + 1));
    } else if (k === 'then' || k === 'else') {
      continue;
    } else results.push(undefined);
  }
  return all(results);
}

// ---- Implication: every instance of the evidence satisfies a schema.

/**
 * Returns a reason string when every instance that satisfies all evidence
 * nodes (and the context) satisfies node `target`, else null. Structural and
 * conservative: each keyword of the target must be implied by the same
 * keyword in an evidence schema object, by the evidence's facts (types,
 * values, required keys), or be vacuous for the evidence's types.
 */
function implies(graph, evidence, ctx, target, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  const nodes = [];
  const seen = new Set();
  for (const id of evidence) expand(graph, id, nodes, seen);
  const ev = membersFacts(graph, nodes);
  for (const k of ctx.required || []) ev.required.add(k);
  const types = intersect(ev.types, ctx.types || null);
  if (types !== null && types.size === 0) return 'no instance';
  const t = graph.resolve(target).n;
  if (seen.has(t)) return `the same schema (${originLabel(graph.nodes[t].origin)})`;
  const node = graph.nodes[t];
  if (node.kind === 'bool') return node.value ? 'true' : null;
  if (node.kind === 'conj') {
    const reasons = [];
    for (const m of graph.conjMembers(node)) {
      const r = implies(graph, evidence, ctx, m.n, depth + 1);
      if (!r) return null;
      reasons.push(r);
    }
    return reasons.join('; ');
  }
  if (node.kind !== 'plain') return null;
  const reasons = [];
  const plains = ev.plains;
  for (const [k, v] of Object.entries(node.kw)) {
    if (k === 'nullable' || k === 'discriminator') return null;
    if (vacuous(k, types)) continue;
    if (k === 'type') {
      if (!Array.isArray(v) || types === null || !subset(types, typeSet(v))) return null;
      reasons.push(`type ${JSON.stringify(v)}`);
    } else if (k === 'const' || k === 'enum') {
      const allowed = new Set((k === 'const' ? [v] : Array.isArray(v) ? v : []).map(stableStringify));
      if (ev.values === null || !subset(ev.values, allowed)) return null;
      reasons.push(`${k} ${JSON.stringify(v)}`);
    } else if (k === 'required') {
      if (!Array.isArray(v) || !v.every(x => ev.required.has(x))) return null;
      reasons.push(`required ${JSON.stringify(v)}`);
    } else if (UPPER.has(k) && typeof v === 'number') {
      if (!plains.some(p => typeof p.kw[k] === 'number' && p.kw[k] <= v)) return null;
    } else if (LOWER.has(k) && typeof v === 'number') {
      if (!plains.some(p => typeof p.kw[k] === 'number' && p.kw[k] >= v)) return null;
    } else if (!plains.some(p => Object.prototype.hasOwnProperty.call(p.kw, k) && stableStringify(p.ckw[k]) === stableStringify(node.ckw[k]))) {
      return null;
    }
  }
  const kidId = (ref) => graph.kid(ref).n;
  const same = (k, ref) => plains.some(p => p.kids[k] && !p.kids[k].tuple && !Array.isArray(p.kids[k]) && p.kids[k].n !== undefined && kidId(p.kids[k]) === kidId(ref));
  const sameList = (k, refs) => plains.some(p => Array.isArray(p.kids[k]) && p.kids[k].length === refs.length && p.kids[k].every((r, i) => kidId(r) === kidId(refs[i])) && stableStringify(p.kw.discriminator) === stableStringify(node.kw.discriminator));
  for (const [k, ref] of Object.entries(node.kids)) {
    if (vacuous(k, types)) continue;
    if (k === 'properties') {
      for (const [name, pref] of Object.entries(ref)) {
        const pid = kidId(pref);
        if (isTrue(graph, pid)) continue;
        if (keyForbidden(ev, name)) continue;
        const evProps = ev.propNodes.get(name) || [];
        if (!evProps.length) return null;
        const r = implies(graph, evProps, {}, pid, depth + 1);
        if (!r) return null;
        reasons.push(`properties/${name}: ${r}`);
      }
    } else if (k === 'patternProperties') {
      const pats = Object.entries(ref);
      const ok = plains.some(p => p.kids.patternProperties && pats.every(([pat, r]) => p.kids.patternProperties[pat] && kidId(p.kids.patternProperties[pat]) === kidId(r)));
      if (!ok) return null;
    } else if (k === 'additionalProperties') {
      const names = new Set(Object.keys(node.kids.properties || {}));
      const pats = new Set(Object.keys(node.kids.patternProperties || {}));
      const ok = plains.some((p) => {
        const ap = p.kids.additionalProperties;
        if (!ap || !(isFalse(graph, kidId(ap)) || kidId(ap) === kidId(ref))) return false;
        return Object.keys(p.kids.properties || {}).every(n => names.has(n)) && Object.keys(p.kids.patternProperties || {}).every(x => pats.has(x));
      });
      if (!ok) return null;
    } else if (k === 'items' && !ref.tuple) {
      if (!ev.items.length) return null;
      const r = implies(graph, ev.items, {}, kidId(ref), depth + 1);
      if (!r) return null;
      reasons.push(`items: ${r}`);
    } else if (k === 'anyOf') {
      if (sameList(k, ref)) continue;
      let found = null;
      for (let i = 0; i < ref.length && !found; i++) {
        const r = implies(graph, evidence, ctx, kidId(ref[i]), depth + 1);
        if (r) found = `anyOf/${i}: ${r}`;
      }
      if (!found) return null;
      reasons.push(found);
    } else if (k === 'oneOf') {
      if (!sameList(k, ref)) return null;
    } else if (k === 'if' || k === 'then' || k === 'else') {
      const group = ['if', 'then', 'else'].filter(x => node.kids[x]);
      if (!plains.some(p => group.every(x => p.kids[x] && kidId(p.kids[x]) === kidId(node.kids[x])))) return null;
    } else if (ref && ref.n !== undefined) {
      if (!same(k, ref)) return null;
    } else {
      return null;
    }
  }
  return reasons.length ? reasons.join(', ') : 'no constraint';
}

// ---- The prover.

const TOP = Object.freeze({ types: null, required: new Set() });

/**
 * Returns { rule, text } when nodes a and b are disjoint under ctx
 * ({ types, required } that hold for the instance), else null.
 */
function proveDisjoint(graph, a, b, ctx = TOP, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  const fa = facts(graph, a);
  const fb = facts(graph, b);
  const ctxTypes = ctx.types === undefined ? null : ctx.types;
  const t = intersect(intersect(fa.types, fb.types), ctxTypes) || new Set(ALL);
  if (t.size === 0) return { rule: 'types', text: 'disjoint types' };
  if (disjointSets(fa.values, fb.values)) return { rule: 'values', text: 'disjoint const/enum values' };
  const ctxRequired = ctx.required || new Set();
  const reqA = new Set([...fa.required, ...ctxRequired]);
  const reqB = new Set([...fb.required, ...ctxRequired]);
  if ([...t].every(x => x === 'object')) {
    const via = objectsVia(fa, fb, ctxTypes);
    for (const [p, va] of fa.props) {
      if (!reqA.has(p) || !reqB.has(p) || !fb.props.has(p)) continue;
      if (disjointSets(va, fb.props.get(p))) return { rule: 'tag-values', text: `required property "${p}" with disjoint const/enum values${via}` };
    }
    for (const [Y, req] of [[fb, reqA], [fa, reqB]]) {
      for (const k of req) {
        if (keyForbidden(Y, k)) return { rule: 'closed-object', text: `closed object: one branch requires "${k}", which the other does not allow${via}` };
      }
    }
    for (const [p, na] of fa.propNodes) {
      if (!reqA.has(p) || !reqB.has(p) || !fb.propNodes.has(p)) continue;
      for (const x of na) {
        for (const y of fb.propNodes.get(p)) {
          const inner = proveDisjoint(graph, x, y, TOP, depth + 1);
          if (inner) return { rule: 'property-schemas', text: `required property "${p}" with disjoint schemas (${inner.text})${via}` };
        }
      }
    }
  }
  for (const [x, f, Y] of [[a, fa, fb], [b, fb, fa]]) {
    for (const o of Y.nots) {
      const r = implies(graph, [x], ctx, o);
      if (r) return { rule: 'not-implied', text: `one branch implies what the other's "not" excludes (${r})` };
    }
    for (const o of Y.nots) {
      for (const u of f.unions) {
        const rs = [];
        for (const br of u.ids) {
          const r = implies(graph, [x, br], ctx, o);
          if (!r) break;
          rs.push(r);
        }
        if (rs.length === u.ids.length) return { rule: 'not-alternatives', text: `each "${u.key}" alternative of one branch implies what the other's "not" excludes (${rs.join(' | ')})` };
      }
    }
  }
  for (const [X, y] of [[fa, b], [fb, a]]) {
    if (X.values === null || X.values.size > 256) continue;
    const vals = [...X.values].map(v => JSON.parse(v));
    if (vals.every(v => evaluate(graph, y, v) === false)) return { rule: 'finite-values', text: `finite values: the other branch rejects each of the ${vals.length} values` };
  }
  if ([...t].every(x => x === 'array') && Math.max(fa.minItems, fb.minItems) >= 1) {
    for (const x of fa.items) {
      for (const y of fb.items) {
        const inner = proveDisjoint(graph, x, y, TOP, depth + 1);
        if (inner) return { rule: 'array-items', text: `the instance needs an item, and the item schemas are disjoint (${inner.text})` };
      }
    }
  }
  return null;
}

function objectsVia(fa, fb, ctxTypes) {
  const own = (f) => f.types !== null && [...f.types].every(x => x === 'object') && !f.narrowedBy;
  if (own(fa) || own(fb)) return '';
  if (fa.narrowedBy || fb.narrowedBy) return '; objects only through "not"';
  if (ctxTypes) return '; objects only through the enclosing schema';
  return '';
}

/** Returns a proof string when nodes a and b are disjoint under ctx, else null. */
function disjoint(graph, a, b, ctx) {
  const p = proveDisjoint(graph, a, b, ctx);
  return p ? p.text : null;
}

/**
 * The context a set of schema objects gives the instance they apply to:
 * { types, required }, with the same type narrowing as `facts`.
 */
function contextOf(graph, plains) {
  const f = membersFacts(graph, plains);
  return { types: f.types, required: f.required };
}

module.exports = { proveDisjoint, disjoint, facts, membersFacts, contextOf, implies, evaluate, acceptsAll, intersect, typeSet, ALL, TOP };
