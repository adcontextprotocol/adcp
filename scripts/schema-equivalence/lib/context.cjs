'use strict';

/**
 * Same-instance context: what every instance that reaches a node is known to
 * satisfy, from the schemas that apply to the same instance on the way down
 * from the roots. A node's result matters only for instances that satisfy its
 * context, because otherwise an enclosing schema rejects the instance anyway.
 *
 * The context is { types, required, props }: the possible type kinds, keys
 * every object instance has, and, per property name, the { types, required }
 * that the property's value is known to satisfy. It flows
 *   - from a conjunction to each member, with the facts of all members;
 *   - from a schema object to its `anyOf`/`oneOf` branches, `not`, `if`,
 *     `then`, `else`, and schema `dependencies`, with that object's facts;
 *   - from a schema object to `properties/<name>`, as the facts that every
 *     schema applying to the parent instance gives that property (a sibling
 *     `allOf` member's `properties/<name>: {type: object}` reaches a
 *     `then/properties/<name>` of another member);
 *   - to every other subschema as no context.
 * A node reached along several paths gets the join of their contexts
 * (types: union; required and props: intersection), so a rewrite made under
 * it holds at every use. A node that no root reaches has no context.
 */

const { forEachKid, unescapePointer } = require('./graph.cjs');
const { facts, intersect } = require('./disjoint.cjs');

const SAME_INSTANCE = new Set(['not', 'if', 'then', 'else']);

function top() {
  return { types: null, required: new Set(), props: new Map() };
}

function joinEntry(a, b) {
  return {
    types: a.types === null || b.types === null ? null : new Set([...a.types, ...b.types]),
    required: new Set([...a.required].filter(k => b.required.has(k))),
  };
}

function meetEntry(a, b) {
  return { types: intersect(a.types, b.types), required: new Set([...a.required, ...b.required]) };
}

function join(a, b) {
  const props = new Map();
  for (const [k, v] of a.props) if (b.props.has(k)) props.set(k, joinEntry(v, b.props.get(k)));
  return { ...joinEntry(a, b), props };
}

function sameSet(a, b) {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function equal(a, b) {
  if (!sameSet(a.types, b.types) || !sameSet(a.required, b.required) || a.props.size !== b.props.size) return false;
  for (const [k, v] of a.props) {
    const w = b.props.get(k);
    if (!w || !sameSet(v.types, w.types) || !sameSet(v.required, w.required)) return false;
  }
  return true;
}

/** The facts a node gives its own instance, and per property name the facts of its value. */
function ownFacts(graph, id, memo) {
  if (memo.has(id)) return memo.get(id);
  const f = facts(graph, id);
  const props = new Map();
  for (const [name, ids] of f.propNodes) {
    let e = { types: null, required: new Set() };
    for (const pid of ids) {
      const pf = facts(graph, pid);
      e = meetEntry(e, { types: pf.types, required: pf.required });
    }
    props.set(name, e);
  }
  const out = { types: f.types, required: f.required, props };
  memo.set(id, out);
  return out;
}

function meet(state, own) {
  const props = new Map(state.props);
  for (const [k, v] of own.props) props.set(k, props.has(k) ? meetEntry(props.get(k), v) : v);
  return { types: intersect(state.types, own.types), required: new Set([...state.required, ...own.required]), props };
}

/** Map resolved node id -> context, for every node the roots reach. */
function computeContexts(graph, rootIds) {
  const states = new Map();
  const memo = new Map();
  const work = [];
  const push = (id, st) => {
    const r = graph.resolve(id).n;
    const cur = states.get(r);
    const next = cur ? join(cur, st) : st;
    if (cur && equal(cur, next)) return;
    states.set(r, next);
    work.push(r);
  };
  for (const id of rootIds) push(id, top());
  while (work.length) {
    const id = work.pop();
    const st = states.get(id);
    const node = graph.nodes[id];
    if (node.kind === 'conj') {
      const down = meet(st, ownFacts(graph, id, memo));
      for (const m of graph.conjMembers(node)) push(m.n, down);
    } else if (node.kind === 'plain') {
      const down = meet(st, ownFacts(graph, id, memo));
      forEachKid(node, (ref, path) => {
        const key = path.split('/')[0];
        const kid = graph.kid(ref).n;
        if (key === 'anyOf' || key === 'oneOf' || key === 'dependencies' || SAME_INSTANCE.has(key)) push(kid, down);
        else if (key === 'properties') {
          const e = down.props.get(unescapePointer(path.slice('properties/'.length)));
          push(kid, e ? { types: e.types, required: e.required, props: new Map() } : top());
        } else push(kid, top());
      });
    }
  }
  return states;
}

/** Every root node id of every side of a graph. */
function graphRootIds(graph) {
  const out = [];
  for (const [side, s] of graph.sides) {
    for (const rel of s.roots.keys()) {
      const r = graph.rootRef(side, rel);
      if (r) out.push(r.n);
    }
  }
  return out;
}

module.exports = { computeContexts, graphRootIds, top };
