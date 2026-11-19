'use strict';

/**
 * Builds the canonical schema graph for one or more schema trees.
 *
 * Every schema location (document + JSON pointer) becomes one node. A `$ref`
 * becomes an edge to the target location instead of a copy, so recursive
 * schemas are finite graphs and two roots are equivalent when their graphs
 * are bisimilar (lib/color.cjs). Cutting a cycle at a fixed depth would make
 * the result depend on where the cycle was entered; bisimulation does not.
 *
 * Node kinds:
 *   bool   `true` / `false`
 *   plain  assertion keywords of one schema object, without `allOf`/`$ref`
 *   conj   a conjunction (`allOf`) of two or more nodes
 *   alias  this location means exactly another node (`{ "$ref": X }`)
 *
 * Normalizations applied here (each has a fixture under test/fixtures):
 *   - annotation keywords dropped (keywords.cjs STRIP; informational ones are
 *     kept only in `annotated` mode);
 *   - `$ref` with siblings is the conjunction of the target and the siblings
 *     (Ajv 8 applies `$ref` siblings in draft-07), `allOf` members join the
 *     same conjunction, nested conjunctions are flattened, `true` members are
 *     dropped, duplicate members are dropped, a one-member conjunction is that
 *     member;
 *   - a one-branch `anyOf`/`oneOf` is that branch (not under `discriminator`,
 *     which changes `oneOf` evaluation);
 *   - `type` is a sorted set, and `"x"` equals `["x"]`; `enum` and `required`
 *     are sorted sets; a one-value `enum` is `const`;
 *   - `required: []`, `minLength: 0`, `minItems: 0`, `minProperties: 0`,
 *     `uniqueItems: false` equal absence;
 *   - `type` next to `const`/`enum` is dropped when every allowed value
 *     already has one of the listed types;
 *   - `additionalProperties`, `additionalItems`, `items`, `propertyNames`,
 *     `then`, `else` equal absence when their subschema is `true`;
 *   - `then`/`else` without `if` and `if` without `then`/`else` are dropped
 *     (Ajv ignores them);
 *   - an object with no remaining keywords is `true`.
 */

const { SINGLE, MAP, UNION, VALUE, STRIP, TRUE_IS_ABSENT, isInfo } = require('./keywords.cjs');
const { sortedSet, stableStringify, escapePointer, unescapePointer, getPointer, jsonType } = require('./json.cjs');
const { canonicalPattern } = require('./pattern.cjs');

const ORIGIN = 'https://adcontextprotocol.org';
const SEMVER_SEGMENT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

class Graph {
  constructor({ annotated = false } = {}) {
    this.annotated = annotated;
    this.nodes = [];
    this.TRUE = this.add({ kind: 'bool', value: true, origin: null });
    this.FALSE = this.add({ kind: 'bool', value: false, origin: null });
    this.locNode = new Map(); // locKey -> node id
    this.problems = [];
    this.sides = new Map(); // side -> { tree, roots: Map rel -> ref }
    this._resolved = null;
  }

  add(node) {
    node.id = this.nodes.length;
    this.nodes.push(node);
    return node.id;
  }

  /**
   * A plain node. `kw` keeps the source spelling for reports; `ckw` is the
   * spelling used for comparison (canonical regex patterns).
   */
  addPlain(origin, kw, kids, info) {
    return this.add({ kind: 'plain', origin, kw, ckw: canonicalKw(kw), kids, info });
  }

  /** Adds every root of a tree under a side label ('base' / 'head'). */
  addSide(side, tree, rootFiles) {
    const ctx = { side, tree, docs: new Map(), nestedIds: new Map() };
    const roots = new Map();
    const work = [];
    const enqueue = (doc, ptr) => {
      const key = locKey(side, doc, ptr);
      if (!this.locNode.has(key)) {
        this.locNode.set(key, -1);
        work.push({ doc, ptr, key });
      }
      return key;
    };
    for (const rel of rootFiles) {
      roots.set(rel, { loc: enqueue(`src:${rel}`, ''), via: '' });
    }
    while (work.length) {
      const item = work.pop();
      const value = getPointer(this._doc(ctx, item.doc), item.ptr);
      this.locNode.set(item.key, this._buildLocation(ctx, item.doc, item.ptr, value, enqueue));
    }
    this.sides.set(side, { tree, roots, ctx });
    this._resolved = null;
    return roots;
  }

  /** The raw source JSON at a node origin. */
  rawAt(origin) {
    const ctx = this.sides.get(origin.side).ctx;
    return getPointer(this._doc(ctx, origin.doc), origin.ptr);
  }

  /** Resolves a raw `$ref` written at an origin; returns an origin or null. */
  rawRef(origin, ref) {
    const ctx = this.sides.get(origin.side).ctx;
    const t = this._resolveRef(ctx, origin.doc, origin.ptr, ref);
    return t ? { side: origin.side, doc: t.doc, ptr: t.ptr } : null;
  }

  _doc(ctx, doc) {
    if (ctx.docs.has(doc)) return ctx.docs.get(doc);
    let value;
    if (doc.startsWith('src:')) value = ctx.tree.files.get(doc.slice(4));
    else value = ctx.tree.readDist(doc.slice(5));
    ctx.docs.set(doc, value);
    ctx.nestedIds.set(doc, nestedIdPointers(value));
    return value;
  }

  /** Resolves a `$ref` string written at (doc, ptr) to a location, or null. */
  _resolveRef(ctx, doc, ptr, ref) {
    const nested = ctx.nestedIds.get(doc) || [];
    const absolute = /^[a-z]+:/i.test(ref) || ref.startsWith('/');
    if (!absolute && nested.some(p => ptr === p || ptr.startsWith(`${p}/`))) {
      throw new Error(`${doc}#${ptr}: relative $ref ${ref} under a nested $id is not supported`);
    }
    const t = refTarget(doc, ref);
    if (!t) return null;
    const { doc: targetDoc, ptr: frag } = t;
    const target = this._doc(ctx, targetDoc);
    if (target === undefined || target === null) return null;
    if (getPointer(target, frag) === undefined) return null;
    return { doc: targetDoc, ptr: frag };
  }

  _buildLocation(ctx, doc, ptr, value, enqueue) {
    const origin = { side: ctx.side, doc, ptr };
    if (value === true) return this.TRUE;
    if (value === false) return this.FALSE;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.problems.push({ side: ctx.side, location: `${doc}#${ptr}`, problem: 'schema is not an object or boolean' });
      return this.addPlain(origin, { $invalid: stableStringify(value) }, {}, {});
    }
    const child = (suffix) => ({ loc: enqueue(doc, `${ptr}/${suffix}`), via: '' });
    const parts = [];
    const kw = {};
    const kids = {};
    const info = {};

    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref') {
        if (typeof v !== 'string') {
          kw.$ref = stableStringify(v);
          continue;
        }
        const target = this._resolveRef(ctx, doc, ptr, v);
        if (!target) {
          this.problems.push({ side: ctx.side, location: `${doc}#${ptr}`, problem: `unresolved $ref ${v}` });
          kw.$ref = `unresolved:${v}`;
        } else {
          parts.push({ loc: enqueue(target.doc, target.ptr), via: '/$ref' });
        }
      } else if (key === 'allOf' && Array.isArray(v)) {
        v.forEach((_, i) => parts.push({ loc: enqueue(doc, `${ptr}/allOf/${i}`), via: `/allOf/${i}` }));
      } else if (UNION.has(key) && Array.isArray(v)) {
        if (v.length === 1 && !(key === 'oneOf' && value.discriminator !== undefined)) {
          parts.push({ loc: enqueue(doc, `${ptr}/${key}/0`), via: `/${key}/0` });
        } else {
          kids[key] = v.map((_, i) => child(`${key}/${i}`));
        }
      } else if (SINGLE.has(key) && v !== null && typeof v === 'object' || SINGLE.has(key) && typeof v === 'boolean') {
        kids[key] = child(escapePointer(key));
      } else if (key === 'items' && Array.isArray(v)) {
        kids.items = { tuple: v.map((_, i) => child(`items/${i}`)) };
      } else if (key === 'items' && (typeof v === 'boolean' || (v && typeof v === 'object'))) {
        kids.items = child('items');
      } else if (MAP.has(key) && v && typeof v === 'object' && !Array.isArray(v)) {
        kids[key] = {};
        for (const name of Object.keys(v)) kids[key][name] = child(`${key}/${escapePointer(name)}`);
      } else if (key === 'dependencies' && v && typeof v === 'object' && !Array.isArray(v)) {
        kids.dependencies = {};
        for (const [name, dep] of Object.entries(v)) {
          kids.dependencies[name] = Array.isArray(dep)
            ? { arr: sortedSet(dep) }
            : child(`dependencies/${escapePointer(name)}`);
        }
      } else if (VALUE.has(key)) {
        kw[key] = v;
      } else if (STRIP.has(key)) {
        // dropped
      } else if (isInfo(key)) {
        if (this.annotated) info[key] = v;
      } else {
        // An assertion keyword with a malformed value: keep it verbatim.
        kw[key] = stableStringify(v);
      }
    }

    normalizeValues(kw);
    pruneByType(kw, kids);
    const members = parts.slice();
    const split = splitByType(kw, kids);
    if (split) {
      // { type: [A, B], ...typed keywords } is anyOf over one branch per type.
      const branches = split.branches.map(b => ({ n: this.addPlain(origin, b.kw, b.kids, {}), via: '' }));
      members.push({ n: this.addPlain(origin, {}, { anyOf: branches }, {}), via: '' });
    }
    const noAssertions = Object.keys(kw).length === 0 && Object.keys(kids).length === 0;
    // Annotations beside `$ref`/`allOf` belong to this location, not to a
    // member: they stay on the conjunction (annotated mode only).
    const conjInfo = noAssertions && members.length > 0 ? info : {};
    const restEmpty = noAssertions && (Object.keys(info).length === 0 || members.length > 0);
    const rest = restEmpty ? null : this.addPlain(origin, kw, kids, info);
    if (rest !== null) members.push({ n: rest, via: '' });
    if (members.length === 0) return this.TRUE;
    if (members.length === 1 && parts.length === 0 && !Object.keys(conjInfo).length) return members[0].n;
    return this.add({ kind: 'conj', origin, members, info: conjInfo });
  }

  /**
   * Resolves location references to node ids, flattens conjunctions, and
   * computes which nodes are `true`. Call once after every side is added.
   */
  finalize() {
    const refN = (ref) => (ref.n !== undefined ? ref.n : this.locNode.get(ref.loc));
    // 1. Location refs -> node ids.
    for (const node of this.nodes) {
      if (node.kind === 'conj') node.members = node.members.map(m => ({ n: refN(m), via: m.via }));
      if (node.kind === 'plain') forEachKid(node, (ref) => { ref.n = refN(ref); delete ref.loc; });
    }
    // 2. Flatten conjunctions (detects conjunction cycles).
    const flat = new Map();
    const expand = (id, stack) => {
      const node = this.nodes[id];
      if (node.kind !== 'conj' || (stack.size > 0 && hasInfo(node))) return [{ n: id, via: '' }];
      if (flat.has(id)) return flat.get(id);
      if (stack.has(id)) {
        throw new Error(`conjunction cycle through ${originLabel(node.origin)} (a schema that is its own allOf/$ref member)`);
      }
      stack.add(id);
      const out = [];
      for (const m of node.members) {
        for (const e of expand(m.n, stack)) out.push({ n: e.n, via: m.via + e.via });
      }
      stack.delete(id);
      flat.set(id, out);
      return out;
    };
    for (const node of this.nodes) {
      if (node.kind !== 'conj') continue;
      const seen = new Set();
      const members = [];
      for (const m of expand(node.id, new Set())) {
        if (m.n === this.TRUE || seen.has(m.n)) continue;
        seen.add(m.n);
        members.push(m);
      }
      node.members = members;
    }
    // 3. `true` fixpoint, then drop keywords that are `true`.
    this._propagateTrue();
    this._mergeValueUnions();
    this._propertyNamesAreStrings();
    this._propagateTrue();
  }

  _propagateTrue() {
    const prev = this.isTrue;
    this.isTrue = new Uint8Array(this.nodes.length);
    if (prev) this.isTrue.set(prev.subarray(0, Math.min(prev.length, this.nodes.length)));
    this.isTrue[this.TRUE] = 1;
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes) {
        if (this.isTrue[node.id]) continue;
        if (this._computeTrue(node)) {
          this.isTrue[node.id] = 1;
          changed = true;
        }
      }
    }
    for (const node of this.nodes) if (node.kind === 'plain') this._dropTrueKids(node);
    this._resolved = null;
  }

  /**
   * Property names are strings. Inside `propertyNames` every keyword that
   * applies to the same instance (`allOf`, `anyOf`, `oneOf`, `not`, `if`,
   * `then`, `else`, `$ref`) sees a string, so the subgraph is rewritten in a
   * "string instance" context: a `type` that includes "string" is dropped, a
   * `type`, `const`, or `enum` that admits no string makes the node `false`,
   * keywords for other types are dropped, and `false` union branches go.
   * The rewrite builds context copies (node identity is location plus
   * context), because targets such as core/country-code.json are shared with
   * value positions where `type` matters.
   */
  _propertyNamesAreStrings() {
    const memo = new Map();
    const pending = new Set();
    // Follows finished aliases without the resolve memo (placeholders change).
    const peek = (id) => {
      let cur = id;
      for (let i = 0; i < 1000; i++) {
        const n = this.nodes[cur];
        if (pending.has(cur) || n.kind !== 'alias') return n;
        cur = n.target.n;
      }
      return this.nodes[cur];
    };
    const isFalse = (id) => { const n = peek(id); return n.kind === 'bool' && n.value === false; };
    const isTrueNow = (id) => { const n = peek(id); return n.kind === 'bool' && n.value === true; };
    const toCtx = (id) => {
      const r = this.resolve(id).n;
      if (memo.has(r)) return memo.get(r);
      const node = this.nodes[r];
      if (node.kind === 'bool' || (node.kind === 'plain' && node.kw.nullable !== undefined)) {
        memo.set(r, r);
        return r;
      }
      const ph = this.add({ kind: 'alias', target: { n: this.TRUE, via: '' }, origin: node.origin });
      memo.set(r, ph);
      pending.add(ph);
      let result;
      if (node.kind === 'conj') {
        const members = this.conjMembers(node).map(m => ({ n: toCtx(m.n), via: m.via }));
        const live = members.filter(m => !isTrueNow(m.n));
        if (members.some(m => isFalse(m.n))) result = this.FALSE;
        else if (live.length === 0) result = this.TRUE;
        else if (live.length === 1 && !hasInfo(node)) result = live[0].n;
        else result = this.add({ kind: 'conj', origin: node.origin, members: live, info: node.info || {} });
      } else {
        result = this._stringCopy(node, toCtx, isFalse);
      }
      Object.assign(this.nodes[ph], { kind: 'alias', target: { n: result, via: '' } });
      pending.delete(ph);
      return ph;
    };
    const count = this.nodes.length;
    for (let id = 0; id < count; id++) {
      const node = this.nodes[id];
      if (node.kind !== 'plain' || !node.kids.propertyNames) continue;
      const ref = this.kid(node.kids.propertyNames);
      const n = toCtx(ref.n);
      if (n !== ref.n) node.kids.propertyNames = { n, via: ref.via };
    }
    this._resolved = null;
  }

  /** A plain node read in the string-instance context; returns a node id. */
  _stringCopy(node, toCtx, isFalse) {
    const kw = { ...node.kw };
    if (Array.isArray(kw.type) && kw.type.every(t => TYPE_NAMES.has(t))) {
      if (!kw.type.includes('string')) return this.FALSE;
      delete kw.type;
    }
    if (Object.prototype.hasOwnProperty.call(kw, 'const') && typeof kw.const !== 'string') return this.FALSE;
    if (Array.isArray(kw.enum)) {
      kw.enum = kw.enum.filter(v => typeof v === 'string');
      if (kw.enum.length === 0) return this.FALSE;
      normalizeValues(kw);
    }
    for (const k of Object.keys(kw)) if (KEYWORD_TYPE.has(k) && KEYWORD_TYPE.get(k) !== 'string') delete kw[k];
    const kids = {};
    for (const [k, v] of Object.entries(node.kids)) {
      if (KEYWORD_TYPE.has(k)) continue; // object and array keywords never apply to a string
      if (k === 'anyOf' || k === 'oneOf') {
        const refs = v.map(r => ({ n: toCtx(this.kid(r).n), via: '' })).filter(r => !isFalse(r.n));
        if (refs.length === 0) return this.FALSE;
        kids[k] = refs;
      } else if (k === 'not') {
        const n = toCtx(this.kid(v).n);
        if (isFalse(n)) continue;
        kids.not = { n, via: '' };
      } else if (k === 'if' || k === 'then' || k === 'else') {
        kids[k] = { n: toCtx(this.kid(v).n), via: '' };
      } else {
        kids[k] = v;
      }
    }
    // A one-branch union is its branch.
    const members = [];
    for (const k of ['anyOf', 'oneOf']) {
      if (kids[k] && kids[k].length === 1 && !(k === 'oneOf' && kw.discriminator !== undefined)) {
        members.push({ n: kids[k][0].n, via: '' });
        delete kids[k];
      }
    }
    const empty = !Object.keys(kw).length && !Object.keys(kids).length && !Object.keys(node.info).length;
    if (!empty) members.push({ n: this.addPlain(node.origin, kw, kids, node.info), via: '' });
    if (members.length === 0) return this.TRUE;
    if (members.length === 1) return members[0].n;
    return this.add({ kind: 'conj', origin: node.origin, members, info: {} });
  }

  /**
   * A union whose branches only list values (`const`/`enum`) is one `enum`
   * of all those values. For `oneOf` the value sets must not overlap (a value
   * in two branches matches two branches). Intersected with the node's own
   * `const`/`enum` when it has one; skipped when the result would be empty.
   */
  _mergeValueUnions() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes) {
        if (node.kind !== 'plain' || node.kw.discriminator !== undefined) continue;
        for (const key of ['anyOf', 'oneOf']) {
          const refs = node.kids[key];
          if (!refs) continue;
          const sets = [];
          for (const r of refs) {
            const b = this.nodes[this.kid(r).n];
            const keys = b.kind === 'plain' ? Object.keys(b.kw) : [];
            if (b.kind !== 'plain' || Object.keys(b.kids).length || Object.keys(b.info).length || keys.length !== 1 || !['const', 'enum'].includes(keys[0])) {
              sets.length = 0;
              break;
            }
            sets.push((keys[0] === 'const' ? [b.kw.const] : b.kw.enum).map(stableStringify));
          }
          if (sets.length !== refs.length || sets.length === 0) continue;
          if (key === 'oneOf') {
            const seen = new Set();
            if (sets.some(set => set.some(v => seen.has(v) || !seen.add(v)))) continue;
          }
          let values = new Set(sets.flat());
          if (Object.prototype.hasOwnProperty.call(node.kw, 'const') || Array.isArray(node.kw.enum)) {
            const own = new Set((Object.prototype.hasOwnProperty.call(node.kw, 'const') ? [node.kw.const] : node.kw.enum).map(stableStringify));
            values = new Set([...values].filter(v => own.has(v)));
          }
          if (values.size === 0) continue;
          delete node.kw.const;
          node.kw.enum = [...values].map(v => JSON.parse(v));
          normalizeValues(node.kw);
          node.ckw = canonicalKw(node.kw);
          delete node.kids[key];
          this._resolved = null;
          changed = true;
        }
      }
    }
  }

  _computeTrue(node) {
    if (node.kind === 'bool') return node.value === true;
    if (node.kind === 'conj') return !hasInfo(node) && node.members.every(m => this.isTrue[m.n]);
    if (node.kind !== 'plain') return false;
    if (Object.keys(node.kw).length || Object.keys(node.info).length) return false;
    const view = this._effectiveKids(node);
    return Object.keys(view).length === 0;
  }

  /** Subschema keywords left after dropping the ones that equal absence. */
  _effectiveKids(node) {
    const out = {};
    for (const [key, ref] of Object.entries(node.kids)) {
      if (TRUE_IS_ABSENT.has(key) && ref.n !== undefined && this.isTrue[ref.n]) continue;
      out[key] = ref;
    }
    if (out.dependencies) {
      const deps = {};
      for (const [name, d] of Object.entries(out.dependencies)) {
        if (d.arr ? d.arr.length === 0 : this.isTrue[d.n]) continue;
        deps[name] = d;
      }
      if (Object.keys(deps).length) out.dependencies = deps;
      else delete out.dependencies;
    }
    if (out.items && out.items.tuple === undefined) delete out.additionalItems; // ignored unless items is an array
    if (!out.items) delete out.additionalItems;
    if (!out.if) {
      delete out.then;
      delete out.else;
    } else if (!out.then && !out.else) {
      delete out.if;
    }
    return out;
  }

  _dropTrueKids(node) {
    node.kids = this._effectiveKids(node);
  }

  /**
   * Follows aliases and one-member conjunctions to the node that represents
   * a location in the canonical form. Returns { n, via }.
   */
  resolve(id) {
    if (!this._resolved) this._resolved = new Map();
    const memo = this._resolved;
    if (memo.has(id)) return memo.get(id);
    let cur = id;
    let via = '';
    const seen = new Set();
    for (;;) {
      if (seen.has(cur)) throw new Error(`alias cycle at node ${cur}`);
      seen.add(cur);
      if (this.isTrue[cur] && this.nodes[cur].replacedBy === undefined) {
        cur = this.TRUE;
        break;
      }
      const node = this.nodes[cur];
      if (node.replacedBy !== undefined) {
        cur = node.replacedBy;
        continue;
      }
      if (node.kind === 'alias') {
        via += node.target.via;
        cur = node.target.n;
        continue;
      }
      if (node.kind === 'conj' && !hasInfo(node)) {
        const live = node.members.filter(m => !this.isTrue[m.n]);
        if (live.length === 1) {
          via += live[0].via;
          cur = live[0].n;
          continue;
        }
      }
      break;
    }
    const out = { n: cur, via };
    memo.set(id, out);
    return out;
  }

  /** Live members of a conjunction, resolved. */
  conjMembers(node) {
    return node.members.filter(m => !this.isTrue[m.n]).map(m => {
      const r = this.resolve(m.n);
      return { n: r.n, via: m.via + r.via };
    });
  }

  /** A kid reference, resolved. */
  kid(ref) {
    const r = this.resolve(ref.n);
    return { n: r.n, via: (ref.via || '') + r.via };
  }

  rootRef(side, rel) {
    const s = this.sides.get(side);
    const r = s && s.roots.get(rel);
    if (!r) return null;
    const loc = this.locNode.get(r.loc);
    const res = this.resolve(loc);
    return { n: res.n, via: res.via };
  }
}

/**
 * The document key and JSON pointer a `$ref` written in `doc` names, without
 * checking that it exists. Source documents are `src:<path>`, released ones
 * (`/schemas/<semver>/...`) are `dist:<semver>/<path>`.
 */
function refTarget(doc, ref) {
  const docPath = doc.slice(doc.indexOf(':') + 1);
  let url;
  try {
    url = new URL(ref, `${ORIGIN}/schemas/${docPath}`);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/schemas/')) return null;
  let rel = decodeURIComponent(url.pathname.slice('/schemas/'.length));
  if (rel.startsWith('latest/')) rel = rel.slice('latest/'.length);
  const first = rel.split('/')[0];
  const targetDoc = SEMVER_SEGMENT.test(first) ? `dist:${rel}` : `src:${rel}`;
  const frag = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';
  if (frag !== '' && !frag.startsWith('/')) return null;
  return { doc: targetDoc, ptr: frag };
}

/** A document of a tree by key. */
function readDoc(tree, doc) {
  return doc.startsWith('src:') ? tree.files.get(doc.slice(4)) : tree.readDist(doc.slice(5));
}

function hasInfo(node) {
  return !!node.info && Object.keys(node.info).length > 0;
}

function locKey(side, doc, ptr) {
  return `${side}|${doc}#${ptr}`;
}

function originLabel(origin) {
  if (!origin) return '(synthetic)';
  const doc = origin.doc.slice(origin.doc.indexOf(':') + 1);
  return `${origin.doc.startsWith('dist:') ? 'dist/schemas/' : ''}${doc}#${origin.ptr}`;
}

function forEachKid(node, fn) {
  for (const [key, val] of Object.entries(node.kids)) {
    if (SINGLE.has(key)) fn(val, key);
    else if (key === 'items') {
      if (val.tuple) val.tuple.forEach((r, i) => fn(r, `items/${i}`));
      else fn(val, 'items');
    } else if (UNION.has(key)) val.forEach((r, i) => fn(r, `${key}/${i}`));
    else if (MAP.has(key)) for (const [name, r] of Object.entries(val)) fn(r, `${key}/${escapePointer(name)}`);
    else if (key === 'dependencies') {
      for (const [name, r] of Object.entries(val)) if (!r.arr) fn(r, `dependencies/${escapePointer(name)}`);
    }
  }
}

/** JSON pointers (below the root) of subschemas that declare their own `$id`. */
function nestedIdPointers(doc) {
  const out = [];
  const walk = (v, ptr) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${ptr}/${i}`));
      return;
    }
    if (ptr !== '' && typeof v.$id === 'string' && !/^(examples|enum|const|default)$/.test(ptr.split('/').pop())) out.push(ptr);
    for (const [k, x] of Object.entries(v)) {
      if (k === 'examples' || k === 'enum' || k === 'const' || k === 'default' || k.startsWith('x-')) continue;
      walk(x, `${ptr}/${escapePointer(k)}`);
    }
  };
  walk(doc, '');
  return out;
}

// Keywords that only constrain instances of some JSON types (Ajv runs them
// only for those types). `format*` stays out: ajv-formats has number formats.
const TYPE_KEYWORDS = {
  string: ['maxLength', 'minLength', 'pattern'],
  number: ['multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum'],
  object: ['required', 'properties', 'patternProperties', 'additionalProperties', 'minProperties', 'maxProperties', 'dependencies', 'propertyNames'],
  array: ['items', 'additionalItems', 'maxItems', 'minItems', 'uniqueItems', 'contains'],
};
const KEYWORD_TYPE = new Map();
for (const [t, ks] of Object.entries(TYPE_KEYWORDS)) for (const k of ks) KEYWORD_TYPE.set(k, t);

function applies(keyword, types) {
  const t = KEYWORD_TYPE.get(keyword);
  if (!t) return true;
  return types.some(x => x === t || (t === 'number' && x === 'integer'));
}

function typedNode(kw) {
  return Array.isArray(kw.type) && kw.type.length > 0 && kw.type.every(t => TYPE_NAMES.has(t)) && kw.nullable === undefined;
}

/** Drops keywords that cannot apply to any type the node allows. */
function pruneByType(kw, kids) {
  if (!typedNode(kw)) return;
  for (const k of Object.keys(kw)) if (!applies(k, kw.type)) delete kw[k];
  for (const k of Object.keys(kids)) if (!applies(k, kw.type)) delete kids[k];
}

/**
 * Splits a node that allows several types and has type-specific keywords
 * into one anyOf branch per type, each with the keywords that apply to it.
 * Mutates kw/kids to keep only the keywords every type shares.
 */
function splitByType(kw, kids) {
  if (!typedNode(kw) || kw.type.length < 2) return null;
  const typed = (k) => KEYWORD_TYPE.has(k);
  if (!Object.keys(kw).some(typed) && !Object.keys(kids).some(typed)) return null;
  const branches = kw.type.map(t => {
    const bkw = { type: [t] };
    const bkids = {};
    for (const k of Object.keys(kw)) if (typed(k) && applies(k, [t])) bkw[k] = kw[k];
    for (const k of Object.keys(kids)) if (typed(k) && applies(k, [t])) bkids[k] = kids[k];
    return { kw: bkw, kids: bkids };
  });
  delete kw.type;
  for (const k of Object.keys(kw)) if (typed(k)) delete kw[k];
  for (const k of Object.keys(kids)) if (typed(k)) delete kids[k];
  return { branches };
}

function canonicalKw(kw) {
  if (typeof kw.pattern !== 'string') return kw;
  return { ...kw, pattern: canonicalPattern(kw.pattern) };
}

const TYPE_NAMES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

/** Value-level normalizations on one schema object's assertion keywords. */
function normalizeValues(kw) {
  if (typeof kw.type === 'string') kw.type = [kw.type];
  if (Array.isArray(kw.type) && kw.type.every(t => TYPE_NAMES.has(t))) kw.type = [...new Set(kw.type)].sort();
  if (Array.isArray(kw.enum)) {
    kw.enum = sortedSet(kw.enum);
    if (kw.enum.length === 1 && !Object.prototype.hasOwnProperty.call(kw, 'const')) {
      kw.const = kw.enum[0];
      delete kw.enum;
    }
  }
  if (Array.isArray(kw.required)) {
    kw.required = [...new Set(kw.required)].sort();
    if (kw.required.length === 0) delete kw.required;
  }
  for (const k of ['minLength', 'minItems', 'minProperties']) if (kw[k] === 0) delete kw[k];
  if (kw.uniqueItems === false) delete kw.uniqueItems;
  // Not next to Ajv's `nullable`, which reads `type`.
  if (Array.isArray(kw.type) && kw.type.every(t => TYPE_NAMES.has(t)) && kw.nullable === undefined) {
    const values = Object.prototype.hasOwnProperty.call(kw, 'const') ? [kw.const] : Array.isArray(kw.enum) ? kw.enum : null;
    if (values && values.every(v => {
      const t = jsonType(v);
      return kw.type.includes(t) || (t === 'integer' && kw.type.includes('number'));
    })) {
      delete kw.type;
    }
  }
}

module.exports = { Graph, hasInfo, forEachKid, originLabel, locKey, unescapePointer, canonicalKw, normalizeValues, refTarget, readDoc };
