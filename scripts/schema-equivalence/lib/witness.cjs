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
const { refTarget, readDoc } = require('./graph.cjs');
const { getPointer, unescapePointer, stableStringify } = require('./json.cjs');
const { sampleRegex } = require('./sample-regex.cjs');
const { siteOf } = require('./manifest.cjs');
const { VALUE, SINGLE } = require('./keywords.cjs');

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

/** An instance of raw schema `s` (in document `doc`), guided along pointer segments `segs`. */
function synth(tree, doc, s, segs, depth = 0, choice = 0, props0 = {}) {
  if (depth > MAX_DEPTH) return segs.length ? FAIL : null;
  // Properties declared next to a combinator apply inside its members too
  // (a branch that only says `required: [x]` takes x's schema from here).
  const ctxProps = isObj(s) && isObj(s.properties) ? { ...props0, ...s.properties } : props0;
  if (s === true || s === undefined) return segs.length ? FAIL : {};
  if (s === false || !isObj(s)) return FAIL;
  // The pointer comes from one side; skip combinator steps the other side's
  // schema does not have here (an inline subschema where the head has a $ref).
  while (segs.length) {
    if (segs[0] === '$ref' && typeof s.$ref !== 'string') segs = segs.slice(1);
    else if (segs[0] === 'allOf' && !Array.isArray(s.allOf)) segs = segs.slice(2);
    else if ((segs[0] === 'anyOf' || segs[0] === 'oneOf') && !Array.isArray(s.anyOf) && !Array.isArray(s.oneOf)) segs = segs.slice(2);
    else break;
  }
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
    const parts = s.allOf.map((m, j) => synth(tree, doc, m, j === guided ? segs.slice(2) : [], depth + 1, choice, ctxProps));
    if (parts.some(p => p === FAIL && guided >= 0)) return FAIL;
    const rest = synth(tree, doc, without(s, ['allOf']), guided >= 0 ? [] : segs, depth + 1, choice, ctxProps);
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
    return o;
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

function lengthVariants(cur, lengths) {
  const base = typeof cur === 'string' && cur.length ? cur : 'a';
  return lengths.filter(n => Number.isInteger(n) && n >= 0 && n < 20000).map(n => base.repeat(Math.ceil((n + 1) / base.length)).slice(0, n));
}

/** Candidate values (or edits) at the instance location for one difference entry. */
function candidates(entry, ctx) {
  const k = entry.keyword;
  const o = entry.old;
  const n = entry.new;
  const out = [];
  const cur = ctx.current;
  const nums = [o, n].filter(x => typeof x === 'number');
  const around = [...new Set(nums.flatMap(x => [x - 1, x, x + 1, x + 0.5]).concat(nums.length === 2 ? [(nums[0] + nums[1]) / 2] : []))].sort((p, q) => p - q);
  if (['maxLength', 'minLength'].includes(k)) out.push(...lengthVariants(cur, around));
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
    for (const entry of entries) {
      const hybrid = revertedHead(trees, entry);
      if (!hybrid.tree) {
        reasons.push(`cannot attribute: ${hybrid.reason}`);
        break;
      }
      // One hybrid per entry, compiled lazily (only what the root reaches).
      const hv = new TreeValidator(hybrid.tree, { lazy: true });
      const h = await hv.get(`${entry.root}#`);
      if (typeof h !== 'function') continue;
      for (const dir of ['tighten', 'loosen']) {
        if (found[dir]) continue;
        const accept = dir === 'tighten' ? 'base' : 'head';
        const reject = dir === 'tighten' ? 'head' : 'base';
        // Reverting the line restores the base verdict.
        const attributed = (p) => (dir === 'tighten' ? h(p) : !h(p));
        found[dir] = await search(entry, accept, reject, ctx, attributed);
      }
      if (found.tighten && found.loosen) break;
    }
    const observed = ['tighten', 'loosen'].filter(d => found[d]);
    const declared = change.direction === 'both' ? ['tighten', 'loosen'] : change.direction === 'none' ? [] : [change.direction];
    res.observed = observed;
    res.payloads = observed.map(d => payloadRecord(d, found[d]));
    const missing = declared.filter(d => !found[d]);
    const extra = observed.filter(d => !declared.includes(d));
    if (missing.length && !reasons.length) reasons.push(`no ${missing.join('/')} witness attributed to this line in ${entries.length} root(s)`);
    else if (missing.length) reasons.push(`no ${missing.join('/')} witness`);
    if (extra.length) reasons.push(`a ${extra.join('/')} witness is attributed to this line, which declares ${change.direction}`);
    if (!missing.length && !extra.length) reasons.length = 0;
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
    root: found.root,
    payload: found.payload,
    at: found.at.length ? `/${found.at.map(x => String(x).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '',
    value: getAt(found.payload, found.at),
    base: dir === 'tighten' ? 'valid' : 'invalid',
    head: dir === 'tighten' ? 'invalid' : 'valid',
  };
}

/**
 * The head tree with one difference entry reverted at its site: the entry's
 * keyword at head_location gets the base value back, or is removed when the
 * base lacks it. Returns { tree }, or { reason } when the keyword as the
 * source writes it cannot be mapped back (it came from a normalization).
 */
function revertedHead(trees, entry) {
  const loc = parseLocation(entry.head_location);
  if (!loc || !loc.doc.startsWith('src:')) return { reason: `site ${entry.head_location} is not a source schema` };
  const rel = loc.doc.slice(4);
  const doc = structuredClone(trees.head.files.get(rel));
  const raw = getPointer(doc, loc.ptr);
  if (!isObj(raw)) return { reason: `no schema object at ${entry.head_location}` };
  const baseRaw = rawAt(trees.base, parseLocation(entry.base_location));
  const kw = entry.keyword;
  const has = (f) => Object.prototype.hasOwnProperty.call(entry, f);
  const written = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const segs = entry.pointer.split('/').map(unescapePointer);
  const last = segs[segs.length - 1];
  const UNIONS = ['anyOf', 'oneOf', 'allOf'];
  const branch = /^\d+$/.test(last) && UNIONS.includes(segs[segs.length - 2]) && UNIONS.includes(kw);
  if (branch) {
    const key = segs[segs.length - 2];
    const idx = Number(last);
    if (has('new') && !has('old')) {
      if (!Array.isArray(raw[key]) || raw[key][idx] === undefined) return { reason: `${key}/${idx} is not written at ${entry.head_location}` };
      raw[key].splice(idx, 1);
    } else if (has('old') && !has('new')) {
      const b = isObj(baseRaw) && Array.isArray(baseRaw[key]) ? baseRaw[key][idx] : undefined;
      if (b === undefined) return { reason: `${key}/${idx} is not written at ${entry.base_location}` };
      raw[key] = [...(Array.isArray(raw[key]) ? raw[key] : []), structuredClone(b)];
    } else return { reason: `cannot revert a ${key} branch change` };
  } else if (kw === 'properties' || kw === 'patternProperties' || kw === 'dependencies') {
    if (has('new') && !has('old')) {
      if (!isObj(raw[kw]) || raw[kw][last] === undefined) return { reason: `${kw}/${last} is not written at ${entry.head_location}` };
      delete raw[kw][last];
    } else {
      const b = isObj(baseRaw) && isObj(baseRaw[kw]) ? baseRaw[kw][last] : undefined;
      if (b === undefined) return { reason: `${kw}/${last} is not written at ${entry.base_location}` };
      raw[kw] = { ...(isObj(raw[kw]) ? raw[kw] : {}), [last]: structuredClone(b) };
    }
  } else if (VALUE.has(kw)) {
    // `const` may be written as a one-value `enum`.
    const oneValueEnum = kw === 'const' && Array.isArray(raw.enum) && raw.enum.length === 1;
    if (has('new') && !written(kw) && !oneValueEnum) return { reason: `${kw} at ${entry.head_location} comes from a normalization, not the source` };
    if (oneValueEnum) delete raw.enum;
    if (kw === 'enum' && written('const')) delete raw.const;
    if (has('old')) raw[kw] = structuredClone(entry.old);
    else delete raw[kw];
  } else if (SINGLE.has(kw) || kw === 'items') {
    if (has('new') && !written(kw)) return { reason: `${kw} at ${entry.head_location} comes from a normalization, not the source` };
    if (has('old')) {
      const b = isObj(baseRaw) ? baseRaw[kw] : undefined;
      if (b === undefined) return { reason: `${kw} is not written at ${entry.base_location}` };
      raw[kw] = structuredClone(b);
    } else delete raw[kw];
  } else {
    return { reason: `no revert for keyword ${kw}` };
  }
  const files = new Map(trees.head.files);
  files.set(rel, doc);
  return { tree: { label: `${trees.head.label} with ${kw} reverted at ${entry.head_location}`, commit: null, files, readDist: trees.head.readDist } };
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

  const seeds = [];
  if (corpus) for (const b of corpus.bound) if (b.schema === location) seeds.push(b.instance);
  for (const side of [accept, reject]) {
    const doc = `src:${entry.root}`;
    const root = rawAt(trees[side], { doc, ptr: '' });
    for (const choice of [0, 1, 2, 3, 4, 5]) {
      const guided = synth(trees[side], doc, root, path.segs, 0, choice);
      if (guided !== FAIL) seeds.push(guided);
    }
    const plain = synth(trees[side], doc, root, [], 0, 0);
    if (plain !== FAIL) seeds.push(plain);
  }
  const synthesized = [];
  const patterns = [];
  for (const [side, label] of [['base', entry.base_location], ['head', entry.head_location]]) {
    const loc = parseLocation(label);
    let raw = rawAt(trees[side], loc);
    if (raw === undefined) continue;
    if (branchEntry) {
      const idx = Number(entry.pointer.split('/').pop());
      const key = entry.keyword;
      raw = isObj(raw) && Array.isArray(raw[key]) ? raw[key][idx] : undefined;
    } else if (entry.keyword === 'properties') {
      const name = unescapePointer(entry.pointer.split('/').pop());
      raw = isObj(raw) && isObj(raw.properties) ? raw.properties[name] : undefined;
    }
    if (raw === undefined) continue;
    if (isObj(raw) && typeof raw.pattern === 'string') patterns.push(raw.pattern);
    // What a `not` excludes is a candidate on its own.
    if (isObj(raw) && isObj(raw.not)) {
      const v = synth(trees[side], loc.doc, raw.not, [], 0, 0);
      if (v !== FAIL) synthesized.push(v);
    }
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
    const ctx = { current, synthesized, patterns, corpusStrings };
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
