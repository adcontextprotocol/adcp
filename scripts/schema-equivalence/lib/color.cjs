'use strict';

/**
 * Partition refinement (bisimulation) over the canonical graph.
 *
 * Two nodes get the same color exactly when their infinite unfoldings are
 * identical up to the canonical form: same keywords and values, and children
 * with the same colors (`anyOf` branches and `allOf` members as sets, `oneOf`
 * branches as a multiset, `items` tuples in order). Equal colors therefore
 * mean the schemas accept the same payloads. Colors are small integers from
 * an exact signature table, so there are no hash collisions.
 */

const { stableStringify } = require('./json.cjs');
const { SINGLE, MAP } = require('./keywords.cjs');

function reachable(graph, rootIds) {
  const seen = new Set();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of children(graph, id)) if (!seen.has(c)) stack.push(c);
  }
  return [...seen];
}

/** Resolved child ids of a canonical node. */
function children(graph, id) {
  const node = graph.nodes[id];
  const out = [];
  if (node.kind === 'conj') for (const m of graph.conjMembers(node)) out.push(m.n);
  if (node.kind === 'plain') {
    for (const [key, val] of Object.entries(node.kids)) {
      if (SINGLE.has(key)) out.push(graph.kid(val).n);
      else if (key === 'items') {
        if (val.tuple) for (const r of val.tuple) out.push(graph.kid(r).n);
        else out.push(graph.kid(val).n);
      } else if (key === 'anyOf' || key === 'oneOf') for (const r of val) out.push(graph.kid(r).n);
      else if (MAP.has(key)) for (const r of Object.values(val)) out.push(graph.kid(r).n);
      else if (key === 'dependencies') for (const r of Object.values(val)) if (!r.arr) out.push(graph.kid(r).n);
    }
  }
  return out;
}

function localPart(node) {
  const parts = [];
  for (const k of Object.keys(node.ckw).sort()) parts.push(`${k}=${stableStringify(node.ckw[k])}`);
  for (const k of Object.keys(node.info).sort()) parts.push(`i:${k}=${stableStringify(node.info[k])}`);
  return parts.join('|');
}

function signature(graph, id, color, local) {
  const node = graph.nodes[id];
  if (node.kind === 'bool') return node.value ? 'T' : 'F';
  const c = (ref) => color.get(graph.kid(ref).n);
  if (node.kind === 'conj') {
    const ms = [...new Set(graph.conjMembers(node).map(m => color.get(m.n)))].sort((a, b) => a - b);
    const info = node.info ? Object.keys(node.info).sort().map(k => `i:${k}=${stableStringify(node.info[k])}`).join('|') : '';
    return `A[${ms.join(',')}]${info}`;
  }
  const parts = [`P${local.get(id)}`];
  for (const key of Object.keys(node.kids).sort()) {
    const val = node.kids[key];
    if (SINGLE.has(key)) parts.push(`${key}:${c(val)}`);
    else if (key === 'items') parts.push(val.tuple ? `items:[${val.tuple.map(c).join(',')}]` : `items:${c(val)}`);
    else if (key === 'anyOf') parts.push(`anyOf:{${[...new Set(val.map(c))].sort((a, b) => a - b).join(',')}}`);
    else if (key === 'oneOf') parts.push(`oneOf:(${val.map(c).sort((a, b) => a - b).join(',')})`);
    else if (MAP.has(key) || key === 'dependencies') {
      const names = Object.keys(val).sort();
      parts.push(`${key}{${names.map(n => `${JSON.stringify(n)}:${val[n].arr ? `arr${stableStringify(val[n].arr)}` : c(val[n])}`).join(',')}}`);
    }
  }
  return parts.join('|');
}

/**
 * Colors every node reachable from `rootIds`. Returns Map id -> color.
 */
function colorGraph(graph, rootIds) {
  const ids = reachable(graph, rootIds);
  const local = new Map();
  const localTable = new Map();
  for (const id of ids) {
    const node = graph.nodes[id];
    if (node.kind !== 'plain') continue;
    const key = localPart(node);
    if (!localTable.has(key)) localTable.set(key, localTable.size);
    local.set(id, localTable.get(key));
  }
  // Round 0: kind + local keywords only.
  let color = new Map();
  let table = new Map();
  for (const id of ids) {
    const node = graph.nodes[id];
    const sig = node.kind === 'bool' ? (node.value ? 'T' : 'F') : node.kind === 'conj' ? 'A' : `P${local.get(id)}|${Object.keys(node.kids).sort().join(',')}`;
    if (!table.has(sig)) table.set(sig, table.size);
    color.set(id, table.get(sig));
  }
  let classes = table.size;
  for (let round = 0; round < ids.length + 1; round++) {
    const next = new Map();
    const nextTable = new Map();
    for (const id of ids) {
      const sig = `${color.get(id)}#${signature(graph, id, color, local)}`;
      if (!nextTable.has(sig)) nextTable.set(sig, nextTable.size);
      next.set(id, nextTable.get(sig));
    }
    color = next;
    if (nextTable.size === classes) break;
    classes = nextTable.size;
  }
  return color;
}

module.exports = { colorGraph, children, reachable };
