'use strict';

/**
 * Walks the base and head canonical graphs in parallel from each root and
 * reports where they differ as (root, pointer, keyword, old, new) entries.
 *
 * `pointer` is the path from the root to the schema node that holds the
 * keyword, through inlined `$ref`s (the `$ref` segment stays in the path so a
 * reader can follow it). Branch and member indexes are the source indexes on
 * the head side, or on the base side for something the head removed.
 * `old` / `new` are omitted when the keyword or subschema is absent on that
 * side. Subschemas are rendered two levels deep; deeper nodes appear as
 * `{ "$at": "<source location>" }`.
 */

const { stableStringify, escapePointer } = require('./json.cjs');
const { SINGLE, MAP, isInfo } = require('./keywords.cjs');
const { originLabel } = require('./graph.cjs');

const RENDER_DEPTH = 2;

function render(graph, id, depth = RENDER_DEPTH, stack = new Set()) {
  const node = graph.nodes[id];
  if (node.kind === 'bool') return node.value;
  if (depth < 0 || stack.has(id)) return { $at: originLabel(node.origin) };
  stack.add(id);
  let out;
  const r = (ref) => render(graph, graph.kid(ref).n, depth - 1, stack);
  const sortRendered = (arr) => arr.map(x => [stableStringify(x), x]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(x => x[1]);
  if (node.kind === 'conj') {
    out = { allOf: sortRendered(graph.conjMembers(node).map(m => render(graph, m.n, depth - 1, stack))) };
    for (const k of Object.keys(node.info || {}).sort()) out[k] = node.info[k];
  } else {
    out = {};
    for (const k of Object.keys(node.kw).sort()) out[k] = node.kw[k];
    for (const k of Object.keys(node.info).sort()) out[k] = node.info[k];
    for (const key of Object.keys(node.kids).sort()) {
      const val = node.kids[key];
      if (SINGLE.has(key)) out[key] = r(val);
      else if (key === 'items') out.items = val.tuple ? val.tuple.map(r) : r(val);
      // A union a rewrite rule changed renders as the keyword its source wrote.
      else if (key === 'anyOf' || key === 'oneOf') out[(node.srcUnion && node.srcUnion[key]) || key] = sortRendered(val.map(r));
      else if (MAP.has(key) || key === 'dependencies') {
        out[key] = {};
        for (const name of Object.keys(val).sort()) out[key][name] = val[name].arr ? val[name].arr : r(val[name]);
      }
    }
  }
  stack.delete(id);
  return out;
}

class Differ {
  constructor(graph, color) {
    this.graph = graph;
    this.color = color;
  }

  /** Differences for one root. `a`/`b` are resolved refs ({ n, via }) or null. */
  diffRoot(root, a, b) {
    const entries = [];
    if (!a || !b) {
      entries.push(this._entry(root, '', '(root)', a, b, a ? { present: true } : undefined, b ? { present: true } : undefined));
      return entries;
    }
    const visited = new Set();
    this._walk(root, a.n, b.n, '', entries, visited);
    return entries;
  }

  _entry(root, pointer, keyword, a, b, oldV, newV, parentA, parentB) {
    const g = this.graph;
    const e = { root, pointer, keyword };
    if (oldV !== undefined) e.old = oldV;
    if (newV !== undefined) e.new = newV;
    const la = parentA !== undefined ? parentA : a && a.n !== undefined ? a.n : a;
    const lb = parentB !== undefined ? parentB : b && b.n !== undefined ? b.n : b;
    // A node merged from several schema objects reports the object that
    // writes the keyword (or the property, for a presence entry).
    const where = (id) => {
      const node = g.nodes[id];
      const o = node.kwOrigins || {};
      const name = keyword === 'properties' ? pointer.split('/').pop().replace(/~1/g, '/').replace(/~0/g, '~') : null;
      return originLabel((name !== null && o[`properties/${name}`]) || o[keyword] || node.origin);
    };
    e.base_location = la !== null && la !== undefined ? where(la) : null;
    e.head_location = lb !== null && lb !== undefined ? where(lb) : null;
    if (isInfo(keyword.split('/')[0]) && keyword !== '(schema)' && keyword !== '(root)') e.info = true;
    return e;
  }

  /**
   * Informational keywords of a node as its location sees them: a
   * conjunction's members' annotations, overridden by the annotations written
   * beside its `$ref`/`allOf`.
   */
  _effectiveInfo(id, depth = 0) {
    const node = this.graph.nodes[id];
    if (node.kind === 'plain') return node.info;
    if (node.kind !== 'conj' || depth > 50) return {};
    const out = {};
    for (const m of this.graph.conjMembers(node)) Object.assign(out, this._effectiveInfo(m.n, depth + 1));
    return Object.assign(out, node.info || {});
  }

  _walk(root, a, b, path, out, visited, skipInfo = false) {
    const key = `${a},${b},${skipInfo ? 1 : 0}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (this.color.get(a) === this.color.get(b)) return;
    const g = this.graph;
    const A = g.nodes[a];
    const B = g.nodes[b];
    if (!skipInfo) {
      const ia = this._effectiveInfo(a);
      const ib = this._effectiveInfo(b);
      for (const k of union(Object.keys(ia), Object.keys(ib))) {
        const va = ia[k];
        const vb = ib[k];
        if (va !== undefined && vb !== undefined && stableStringify(va) === stableStringify(vb)) continue;
        out.push(this._entry(root, path, k, a, b, va, vb, a, b));
      }
    }
    if (A.kind === 'plain' && B.kind === 'plain') {
      this._plain(root, a, b, A, B, path, out, visited);
      return;
    }
    if (A.kind === 'bool' || B.kind === 'bool') {
      out.push(this._entry(root, path, '(schema)', a, b, render(g, a), render(g, b), a, b));
      return;
    }
    const ma = A.kind === 'conj' ? g.conjMembers(A) : [{ n: a, via: '' }];
    const mb = B.kind === 'conj' ? g.conjMembers(B) : [{ n: b, via: '' }];
    // The conjunction's annotations were compared above, members included.
    this._matchSets(root, path, 'allOf', ma, mb, a, b, out, visited, (m) => m.via || '', true);
  }

  _plain(root, a, b, A, B, path, out, visited) {
    const g = this.graph;
    // A `oneOf` that a rewrite rule turned into `anyOf` on one side only is
    // still the source's `oneOf`: compare its branches with the other side's
    // `oneOf` branches, so a change inside the branches (a `not` guard that
    // made them disjoint) is reported where it was written. When the branches
    // match, the union keyword itself is the difference.
    const rewritten = (N) => N.kids.anyOf && !N.kids.oneOf && N.srcUnion && N.srcUnion.anyOf === 'oneOf';
    const plainOneOf = (N) => N.kids.oneOf && !N.kids.anyOf;
    const pairUnions = (plainOneOf(A) && rewritten(B)) || (rewritten(A) && plainOneOf(B));
    if (pairUnions) {
      const ka = A.kids.oneOf || A.kids.anyOf;
      const kb = B.kids.oneOf || B.kids.anyOf;
      const before = out.length;
      const ma = ka.map((r, i) => ({ ...g.kid(r), idx: i, src: 'oneOf' }));
      const mb = kb.map((r, i) => ({ ...g.kid(r), idx: i, src: 'oneOf' }));
      this._matchSets(root, path, 'oneOf', ma, mb, a, b, out, visited, (m) => `/${m.src}/${m.idx}${m.via}`);
      if (out.length === before) {
        for (const key of ['anyOf', 'oneOf']) {
          if (!A.kids[key] && !B.kids[key]) continue;
          out.push(this._entry(root, path, key, a, b,
            A.kids[key] ? this._renderKid(key, A.kids[key]) : undefined, B.kids[key] ? this._renderKid(key, B.kids[key]) : undefined, a, b));
        }
      }
    }
    for (const k of union(Object.keys(A.kw), Object.keys(B.kw))) {
      const va = A.kw[k];
      const vb = B.kw[k];
      if (va !== undefined && vb !== undefined && stableStringify(A.ckw[k]) === stableStringify(B.ckw[k])) continue;
      out.push(this._entry(root, path, k, a, b, va, vb, a, b));
    }
    for (const key of union(Object.keys(A.kids), Object.keys(B.kids))) {
      if (pairUnions && (key === 'anyOf' || key === 'oneOf')) continue;
      const ka = A.kids[key];
      const kb = B.kids[key];
      if (!ka || !kb) {
        // A union a rewrite rule changed is reported under the keyword its source wrote.
        const named = (N) => (N.srcUnion && N.srcUnion[key]) || key;
        out.push(this._entry(root, path, ka ? named(A) : named(B), a, b,
          ka ? this._renderKid(key, ka) : undefined, kb ? this._renderKid(key, kb) : undefined, a, b));
        continue;
      }
      if (SINGLE.has(key) || (key === 'items' && !ka.tuple && !kb.tuple)) {
        const ra = g.kid(ka);
        const rb = g.kid(kb);
        this._walk(root, ra.n, rb.n, `${path}/${key}${rb.via}`, out, visited);
      } else if (key === 'items') {
        if (!ka.tuple || !kb.tuple) {
          out.push(this._entry(root, path, 'items', a, b, this._renderKid(key, ka), this._renderKid(key, kb), a, b));
          continue;
        }
        const n = Math.max(ka.tuple.length, kb.tuple.length);
        for (let i = 0; i < n; i++) {
          if (i < ka.tuple.length && i < kb.tuple.length) {
            const ra = g.kid(ka.tuple[i]);
            const rb = g.kid(kb.tuple[i]);
            this._walk(root, ra.n, rb.n, `${path}/items/${i}${rb.via}`, out, visited);
          } else {
            out.push(this._entry(root, `${path}/items/${i}`, 'items', a, b,
              i < ka.tuple.length ? render(g, g.kid(ka.tuple[i]).n) : undefined,
              i < kb.tuple.length ? render(g, g.kid(kb.tuple[i]).n) : undefined, a, b));
          }
        }
      } else if (key === 'anyOf' || key === 'oneOf') {
        // A rewritten union keeps the keyword its source wrote (oneOf).
        const srcA = (A.srcUnion && A.srcUnion[key]) || key;
        const srcB = (B.srcUnion && B.srcUnion[key]) || key;
        const ma = ka.map((r, i) => ({ ...g.kid(r), idx: i, src: srcA }));
        const mb = kb.map((r, i) => ({ ...g.kid(r), idx: i, src: srcB }));
        this._matchSets(root, path, key, ma, mb, a, b, out, visited, (m) => `/${m.src}/${m.idx}${m.via}`);
      } else if (MAP.has(key) || key === 'dependencies') {
        for (const name of union(Object.keys(ka), Object.keys(kb))) {
          const pa = ka[name];
          const pb = kb[name];
          const ptr = `${path}/${key}/${escapePointer(name)}`;
          if (pa && pb && !pa.arr && !pb.arr) {
            const ra = g.kid(pa);
            const rb = g.kid(pb);
            this._walk(root, ra.n, rb.n, `${ptr}${rb.via}`, out, visited);
          } else if (pa && pb && pa.arr && pb.arr && stableStringify(pa.arr) === stableStringify(pb.arr)) {
            continue;
          } else {
            out.push(this._entry(root, ptr, key, a, b,
              pa ? (pa.arr ? pa.arr : render(g, g.kid(pa).n)) : undefined,
              pb ? (pb.arr ? pb.arr : render(g, g.kid(pb).n)) : undefined, a, b));
          }
        }
      }
    }
  }

  _renderKid(key, val) {
    const g = this.graph;
    const r = (ref) => render(g, g.kid(ref).n);
    if (SINGLE.has(key)) return r(val);
    if (key === 'items') return val.tuple ? val.tuple.map(r) : r(val);
    if (key === 'anyOf' || key === 'oneOf') return val.map(r);
    const out = {};
    for (const name of Object.keys(val).sort()) out[name] = val[name].arr ? val[name].arr : r(val[name]);
    return out;
  }

  /**
   * Pairs set members (union branches or conjunction members) by color, then
   * pairs leftovers by structural similarity, and reports the rest as added
   * or removed.
   */
  _matchSets(root, path, keyword, ma, mb, a, b, out, visited, seg, skipInfo = false) {
    const g = this.graph;
    const color = this.color;
    let restA;
    let restB;
    if (keyword === 'oneOf') {
      // Multiset: a duplicated oneOf branch changes the meaning.
      const pool = new Map();
      for (const m of mb) {
        const c = color.get(m.n);
        if (!pool.has(c)) pool.set(c, []);
        pool.get(c).push(m);
      }
      restA = [];
      for (const m of ma) {
        const list = pool.get(color.get(m.n));
        if (list && list.length) list.shift();
        else restA.push(m);
      }
      restB = [...pool.values()].flat();
    } else {
      // Set: duplicates of the same member carry no meaning.
      const ca = new Set(ma.map(m => color.get(m.n)));
      const cb = new Set(mb.map(m => color.get(m.n)));
      const once = (list) => {
        const seen = new Set();
        return list.filter(m => !seen.has(color.get(m.n)) && seen.add(color.get(m.n)));
      };
      restA = once(ma.filter(m => !cb.has(color.get(m.n))));
      restB = once(mb.filter(m => !ca.has(color.get(m.n))));
    }
    // Pair leftovers.
    const pairs = [];
    if (restA.length === 1 && restB.length === 1) {
      pairs.push([restA[0], restB[0]]);
      restA.length = 0;
      restB = [];
    } else if (restA.length && restB.length) {
      const scored = [];
      for (const x of restA) for (const y of restB) {
        const s = similarity(g, color, x.n, y.n);
        if (s > 0) scored.push([s, x, y]);
      }
      scored.sort((p, q) => q[0] - p[0]);
      const ua = new Set();
      const ub = new Set();
      for (const [, x, y] of scored) {
        if (ua.has(x) || ub.has(y)) continue;
        ua.add(x);
        ub.add(y);
        pairs.push([x, y]);
      }
      restA.splice(0, restA.length, ...restA.filter(x => !ua.has(x)));
      restB = restB.filter(y => !ub.has(y));
    }
    for (const [x, y] of pairs) this._walk(root, x.n, y.n, `${path}${seg(y)}`, out, visited, skipInfo);
    for (const x of restA) out.push(this._entry(root, `${path}${seg(x)}`, keyword, x, null, render(g, x.n), undefined, a, b));
    for (const y of restB) out.push(this._entry(root, `${path}${seg(y)}`, keyword, null, y, undefined, render(g, y.n), a, b));
  }
}

/** How alike two nodes look: shared keyword values and equal-colored children. */
function similarity(g, color, a, b) {
  const A = g.nodes[a];
  const B = g.nodes[b];
  if (A.kind !== 'plain' || B.kind !== 'plain') return A.kind === B.kind ? 1 : 0;
  let s = 0;
  s += 1;
  for (const k of Object.keys(A.ckw)) if (B.ckw[k] !== undefined && stableStringify(A.ckw[k]) === stableStringify(B.ckw[k])) s += 2;
  const ka = Object.keys(A.kids);
  for (const k of ka) if (B.kids[k] !== undefined) s += 1;
  const pa = A.kids.properties || {};
  const pb = B.kids.properties || {};
  for (const name of Object.keys(pa)) {
    if (!pb[name]) continue;
    s += 1;
    if (color.get(g.kid(pa[name]).n) === color.get(g.kid(pb[name]).n)) s += 3;
  }
  return s;
}

function union(a, b) {
  return [...new Set([...a, ...b])].sort();
}

module.exports = { Differ, render };
