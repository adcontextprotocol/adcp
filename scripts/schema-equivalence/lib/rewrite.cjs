'use strict';

/**
 * Class 2 rewrite rules. Each rule replaces a node with a node that accepts
 * exactly the same payloads, and fires only when a mechanical precondition
 * proves that. When the precondition fails the node is left alone, so the
 * difference stays in the report.
 *
 * Disjointness. Two branches are proven disjoint when one of these holds,
 * using only the branch's top-level keywords (its own and its `allOf`
 * members') and the keywords of the node that holds the union:
 *   (a) their possible JSON types do not overlap (`integer` is inside
 *       `number`; `const`/`enum` narrow the type);
 *   (b) their `const`/`enum` value sets do not overlap;
 *   (c) both can only be objects, a property is required in both (or by the
 *       enclosing node), and its `const`/`enum` value sets do not overlap.
 * `required` and `properties` say nothing about non-objects, so (c) needs the
 * object-only condition: a string would satisfy two object branches that lack
 * `type: "object"`.
 *
 * Rules:
 *   oneOf-to-anyOf: `oneOf` over pairwise-disjoint branches is `anyOf`.
 *   discriminator-to-anyOf: Ajv's `discriminator` + `oneOf` (non-objects pass,
 *     objects are checked against the branch their tag selects) is `anyOf`
 *     when the enclosing node only admits objects and the discriminator is
 *     one Ajv accepts (every branch has `properties/<tag>` with `const` or
 *     `enum` of unique strings, and the tag is required). Checked on the raw
 *     source, as Ajv does.
 *   not-branch-subtraction: `allOf: [U, {not: B}]` where `U` is an
 *     `anyOf`/`oneOf` with a branch equal to `B`, and every other branch is
 *     disjoint from `B`, is `U` without that branch.
 */

const { stableStringify, jsonType } = require('./json.cjs');
const { originLabel } = require('./graph.cjs');
const { ruleKeywords } = require('./ajv.cjs');

const ALL = ['null', 'boolean', 'object', 'array', 'string', 'int', 'frac'];

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
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter(x => b.has(x)));
}

function valueSetOf(graph, id) {
  const node = graph.nodes[id];
  const plains = node.kind === 'plain' ? [node] : node.kind === 'conj' ? graph.conjMembers(node).map(m => graph.nodes[m.n]).filter(n => n.kind === 'plain') : [];
  let values = null;
  for (const p of plains) {
    let vs = null;
    if (Object.prototype.hasOwnProperty.call(p.kw, 'const')) vs = new Set([stableStringify(p.kw.const)]);
    else if (Array.isArray(p.kw.enum)) vs = new Set(p.kw.enum.map(stableStringify));
    values = intersect(values, vs);
  }
  return values;
}

/** Top-level facts about a node: possible types, values, required, property value sets. */
function facts(graph, id) {
  const node = graph.nodes[id];
  if (node.kind === 'bool') return { types: node.value ? null : new Set(), values: null, required: new Set(), props: new Map() };
  const plains = node.kind === 'plain' ? [node] : graph.conjMembers(node).map(m => graph.nodes[m.n]);
  let types = null;
  let values = null;
  const required = new Set();
  const props = new Map();
  for (const p of plains) {
    if (p.kind === 'bool') {
      if (!p.value) types = new Set();
      continue;
    }
    if (p.kind !== 'plain') continue;
    if (Array.isArray(p.kw.type)) types = intersect(types, typeSet(p.kw.type));
    if (Object.prototype.hasOwnProperty.call(p.kw, 'const')) values = intersect(values, new Set([stableStringify(p.kw.const)]));
    else if (Array.isArray(p.kw.enum)) values = intersect(values, new Set(p.kw.enum.map(stableStringify)));
    if (Array.isArray(p.kw.required)) for (const r of p.kw.required) required.add(r);
    if (p.kids.properties) {
      for (const [name, ref] of Object.entries(p.kids.properties)) {
        const vs = valueSetOf(graph, graph.kid(ref).n);
        props.set(name, intersect(props.has(name) ? props.get(name) : null, vs));
      }
    }
  }
  if (values !== null) types = intersect(types, valueKinds([...values].map(v => JSON.parse(v))));
  return { types, values, required, props };
}

function disjointSets(a, b) {
  if (a === null || b === null) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/** Returns a proof string when branches a and b are disjoint under ctx, else null. */
function disjoint(graph, a, b, ctx) {
  const fa = facts(graph, a);
  const fb = facts(graph, b);
  const t = intersect(intersect(fa.types, fb.types), ctx.types) || new Set(ALL);
  if (t.size === 0) return 'disjoint types';
  if (disjointSets(fa.values, fb.values)) return 'disjoint const/enum values';
  if ([...t].every(x => x === 'object')) {
    const reqA = new Set([...fa.required, ...ctx.required]);
    const reqB = new Set([...fb.required, ...ctx.required]);
    for (const [p, va] of fa.props) {
      if (!reqA.has(p) || !reqB.has(p) || !fb.props.has(p)) continue;
      if (disjointSets(va, fb.props.get(p))) return `required property "${p}" with disjoint const/enum values`;
    }
  }
  return null;
}

function contextOf(graph, plains) {
  let types = null;
  const required = new Set();
  for (const p of plains) {
    if (p.kind === 'bool' && !p.value) types = new Set();
    if (p.kind !== 'plain') continue;
    if (Array.isArray(p.kw.type)) types = intersect(types, typeSet(p.kw.type));
    if (Object.prototype.hasOwnProperty.call(p.kw, 'const')) types = intersect(types, valueKinds([p.kw.const]));
    else if (Array.isArray(p.kw.enum)) types = intersect(types, valueKinds(p.kw.enum));
    if (Array.isArray(p.kw.required)) for (const r of p.kw.required) required.add(r);
  }
  return { types, required };
}

function pairwiseDisjoint(graph, ids, ctx) {
  const proofs = new Set();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const proof = disjoint(graph, ids[i], ids[j], ctx);
      if (!proof) return null;
      proofs.add(proof);
    }
  }
  return [...proofs].join('; ');
}

/**
 * Ajv's discriminator mapping on the raw source, or null when Ajv would not
 * compile it. Mirrors ajv/dist/vocabularies/discriminator/index.js.
 */
function ajvDiscriminatorMapping(graph, node) {
  const raw = graph.rawAt(node.origin);
  if (!raw || typeof raw !== 'object') return null;
  const disc = raw.discriminator;
  if (!disc || typeof disc.propertyName !== 'string' || disc.mapping !== undefined || !Array.isArray(raw.oneOf)) return null;
  const tag = disc.propertyName;
  const hasReq = (s) => Array.isArray(s.required) && s.required.includes(tag);
  const topRequired = hasReq(raw);
  const seen = new Set();
  for (let i = 0; i < raw.oneOf.length; i++) {
    let sch = raw.oneOf[i];
    if (sch && typeof sch === 'object' && typeof sch.$ref === 'string' && Object.keys(sch).every(k => !isRule(k))) {
      const target = graph.rawRef({ ...node.origin, ptr: `${node.origin.ptr}/oneOf/${i}` }, sch.$ref);
      if (!target) return null;
      sch = graph.rawAt(target);
    }
    const propSch = sch && sch.properties && sch.properties[tag];
    if (!propSch || typeof propSch !== 'object') return null;
    if (!(topRequired || hasReq(sch))) return null;
    let values;
    if (propSch.const) values = [propSch.const];
    else if (propSch.enum) values = propSch.enum;
    else return null;
    for (const v of values) {
      if (typeof v !== 'string' || seen.has(v)) return null;
      seen.add(v);
    }
  }
  return { tag, values: [...seen] };
}

// Keywords Ajv counts as rules next to `$ref` (schemaHasRulesButRef).
const AJV_RULES = new Set(ruleKeywords());
function isRule(k) {
  return k !== '$ref' && AJV_RULES.has(k);
}

class Rewriter {
  constructor(graph, color) {
    this.graph = graph;
    this.color = color;
    this.log = [];
  }

  record(rule, node, proof) {
    this.log.push({ rule, side: node.origin ? node.origin.side : null, location: originLabel(node.origin), proof });
  }

  /** A plain node equal to `node` with its union keyword replaced. */
  withUnion(node, fromKey, toKey, refs) {
    const g = this.graph;
    const kids = { ...node.kids };
    const kw = { ...node.kw };
    delete kids[fromKey];
    if (fromKey === 'oneOf') delete kw.discriminator;
    if (refs.length === 1 && !kids[toKey]) {
      // A one-branch union is the branch.
      const rest = Object.keys(kids).length || Object.keys(kw).length || Object.keys(node.info).length
        ? g.addPlain(node.origin, kw, kids, node.info)
        : null;
      if (rest === null) return g.kid(refs[0]).n;
      return g.add({ kind: 'conj', origin: node.origin, members: [{ n: rest, via: '' }, { ...g.kid(refs[0]) }] });
    }
    if (kids[toKey]) {
      const rest = g.addPlain(node.origin, kw, kids, node.info);
      const other = g.addPlain(node.origin, {}, { [toKey]: refs }, {});
      g.nodes[other].srcUnion = { [toKey]: (node.srcUnion && node.srcUnion[fromKey]) || fromKey };
      return g.add({ kind: 'conj', origin: node.origin, members: [{ n: rest, via: '' }, { n: other, via: '' }] });
    }
    kids[toKey] = refs;
    const id = g.addPlain(node.origin, kw, kids, node.info);
    // Reports keep naming the keyword the source wrote.
    g.nodes[id].srcUnion = { ...(node.srcUnion || {}), [toKey]: (node.srcUnion && node.srcUnion[fromKey]) || fromKey };
    return id;
  }

  /** oneOf-to-anyOf and discriminator-to-anyOf on one plain node under ctx. Returns new id or null. */
  oneOfRule(id, ctxPlains) {
    const g = this.graph;
    const node = g.nodes[id];
    if (node.kind !== 'plain' || !node.kids.oneOf || node.kids.oneOf.length < 2) return null;
    const ctx = contextOf(g, ctxPlains);
    const branches = node.kids.oneOf.map(r => g.kid(r).n);
    if (node.kw.discriminator !== undefined) {
      const mapping = ajvDiscriminatorMapping(g, node);
      if (!mapping) return null;
      if (!ctx.types || ![...ctx.types].every(t => t === 'object') || ctx.types.size === 0) return null;
      this.record('discriminator-to-anyOf', node, `objects only; Ajv discriminator "${mapping.tag}" maps unique string values ${JSON.stringify(mapping.values)}`);
      return this.withUnion(node, 'oneOf', 'anyOf', node.kids.oneOf);
    }
    const proof = pairwiseDisjoint(g, branches, ctx);
    if (!proof) return null;
    this.record('oneOf-to-anyOf', node, `pairwise disjoint: ${proof}`);
    return this.withUnion(node, 'oneOf', 'anyOf', node.kids.oneOf);
  }

  /** not-branch-subtraction across conjunction members. Returns new member list or null. */
  notRule(members, ctx, conjNode) {
    const g = this.graph;
    const color = this.color;
    let changed = false;
    let list = members.slice();
    for (const notMember of members) {
      const N = g.nodes[notMember.n];
      if (N.kind !== 'plain' || Object.keys(N.kw).length || Object.keys(N.info).length) continue;
      const keys = Object.keys(N.kids);
      if (keys.length !== 1 || keys[0] !== 'not') continue;
      const k = g.kid(N.kids.not).n;
      const kc = color.get(k);
      if (kc === undefined) continue;
      for (const uMember of list) {
        const U = g.nodes[uMember.n];
        if (U.kind !== 'plain' || U.kw.discriminator !== undefined) continue;
        const key = U.kids.anyOf ? 'anyOf' : U.kids.oneOf ? 'oneOf' : null;
        if (!key || (U.kids.anyOf && U.kids.oneOf)) continue;
        const refs = U.kids[key];
        const hit = refs.filter(r => color.get(g.kid(r).n) === kc);
        if (hit.length === 0) continue;
        const remaining = refs.filter(r => color.get(g.kid(r).n) !== kc);
        if (remaining.length === 0) continue;
        const proofs = [];
        let ok = true;
        for (const r of remaining) {
          const p = disjoint(g, g.kid(r).n, k, ctx);
          if (!p) { ok = false; break; }
          proofs.push(p);
        }
        if (!ok) continue;
        const replacement = this.withUnion(U, key, key, remaining);
        this.record('not-branch-subtraction', conjNode, `${key} branch equal to the "not" operand removed; remaining branches disjoint from it: ${[...new Set(proofs)].join('; ')}`);
        list = list.filter(m => m !== notMember && m !== uMember);
        list.push({ n: replacement, via: uMember.via });
        changed = true;
        break;
      }
    }
    return changed ? list : null;
  }

  run() {
    const g = this.graph;
    const count = g.nodes.length;
    // Plain nodes, under their own keywords.
    for (let id = 0; id < count; id++) {
      const node = g.nodes[id];
      if (node.kind !== 'plain' || !node.kids.oneOf) continue;
      const out = this.oneOfRule(id, [node]);
      if (out !== null) node.replacedBy = out;
    }
    g._resolved = null;
    // A plain node that holds both a `not` and a union (members merged into
    // one object) is the conjunction of the two parts for not-branch-subtraction.
    for (let id = 0; id < count; id++) {
      const node = g.nodes[id];
      if (node.kind !== 'plain' || node.replacedBy !== undefined || !node.kids.not) continue;
      if (!node.kids.anyOf && !node.kids.oneOf) continue;
      const restKids = { ...node.kids };
      delete restKids.not;
      const rest = g.addPlain(node.origin, node.kw, restKids, node.info);
      const notPart = g.addPlain(node.origin, {}, { not: node.kids.not }, {});
      let members = [{ n: rest, via: '' }, { n: notPart, via: '' }];
      const afterNot = this.notRule(members, contextOf(g, [g.nodes[rest]]), node);
      if (!afterNot) continue;
      members = flatten(g, afterNot);
      node.replacedBy = members.length === 1 ? members[0].n : g.add({ kind: 'conj', origin: node.origin, members });
      g._resolved = null;
    }
    // Conjunctions, under all members' keywords.
    for (let id = 0; id < count; id++) {
      const node = g.nodes[id];
      if (node.kind !== 'conj' || node.replacedBy !== undefined) continue;
      let members = g.conjMembers(node);
      const plains = () => members.map(m => g.nodes[m.n]);
      let changed = false;
      const afterNot = this.notRule(members, contextOf(g, plains()), node);
      if (afterNot) {
        members = flatten(g, afterNot);
        changed = true;
      }
      members = members.map(m => {
        const out = this.oneOfRule(m.n, plains());
        if (out === null) return m;
        changed = true;
        return { n: out, via: m.via };
      });
      if (changed) {
        members = flatten(g, members);
        const replacement = members.length === 1 ? members[0].n : g.add({ kind: 'conj', origin: node.origin, members });
        node.replacedBy = replacement;
        g._resolved = null;
      }
    }
    g._resolved = null;
    return this.log;
  }
}

function flatten(g, members) {
  const out = [];
  const seen = new Set();
  for (const m of members) {
    const r = g.resolve(m.n);
    const node = g.nodes[r.n];
    const parts = node.kind === 'conj' ? g.conjMembers(node).map(x => ({ n: x.n, via: m.via + r.via + x.via })) : [{ n: r.n, via: m.via + r.via }];
    for (const p of parts) {
      if (p.n === g.TRUE || seen.has(p.n)) continue;
      seen.add(p.n);
      out.push(p);
    }
  }
  return out;
}

function applyRules(graph, color) {
  return new Rewriter(graph, color).run();
}

module.exports = { applyRules, disjoint, facts };
