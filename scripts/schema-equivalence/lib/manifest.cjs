'use strict';

/**
 * Delta manifests: the differences a PR intends. See ../README.md for the
 * format. A check passes only when the manifest and the actual differences
 * match exactly: an actual difference no entry covers fails, and an entry
 * that covers no actual difference fails.
 */

const fs = require('node:fs');
const yaml = require('js-yaml');
const { stableStringify } = require('./json.cjs');

// `none`: a real canonical difference whose effect another line at the same
// node masks (a removed maxLength beside a stricter pattern), so no payload
// changes verdict because of this line alone.
const DIRECTIONS = new Set(['tighten', 'loosen', 'both', 'none']);
const SIDES = new Set(['request', 'response', 'both', 'none']);
const FIELDS = new Set(['root', 'pointer', 'location', 'keyword', 'old', 'new', 'direction', 'side', 'note', 'witness']);

function normalizeRoot(root) {
  return String(root).replace(/^https?:\/\/[^/]+/, '').replace(/^\/schemas\//, '').replace(/^\/+/, '');
}

function loadManifest(file) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  return parseManifest(doc, file);
}

function parseManifest(doc, label = 'manifest') {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.changes)) {
    throw new Error(`${label}: expected a mapping with a "changes" list`);
  }
  const changes = doc.changes.map((c, i) => {
    const where = `${label}: changes[${i}]`;
    if (!c || typeof c !== 'object') throw new Error(`${where}: expected a mapping`);
    for (const k of Object.keys(c)) if (!FIELDS.has(k)) throw new Error(`${where}: unknown field "${k}"`);
    if ((c.root === undefined) === (c.location === undefined)) throw new Error(`${where}: give exactly one of "root" (with "pointer") or "location"`);
    if (c.root !== undefined && typeof c.pointer !== 'string') throw new Error(`${where}: "root" needs a "pointer"`);
    if (typeof c.keyword !== 'string') throw new Error(`${where}: "keyword" is required`);
    if (!DIRECTIONS.has(c.direction)) throw new Error(`${where}: "direction" must be one of ${[...DIRECTIONS].join(', ')}`);
    if (!SIDES.has(c.side)) throw new Error(`${where}: "side" must be one of ${[...SIDES].join(', ')}`);
    if (c.witness !== undefined) {
      for (const w of [].concat(c.witness)) {
        if (!w || typeof w !== 'object' || typeof w.root !== 'string' || !Object.prototype.hasOwnProperty.call(w, 'instance') || Object.keys(w).some(k => k !== 'root' && k !== 'instance')) {
          throw new Error(`${where}: "witness" must be { root, instance } (or a list of them)`);
        }
      }
      if (c.direction === 'none') throw new Error(`${where}: a "none" line takes no witness`);
    }
    return { ...c, index: i, root: c.root === undefined ? undefined : normalizeRoot(c.root) };
  });
  return { title: doc.title, changes, label };
}

/** Request or response side of a root, from its file name. */
function rootSide(rel) {
  const base = rel.split('/').pop();
  if (/-request\.json$/.test(base)) return 'request';
  if (/-response(-[a-z-]+)?\.json$/.test(base)) return 'response';
  return 'none';
}

function combineSides(sides) {
  const s = new Set([...sides].filter(x => x !== 'none'));
  if (s.size === 0) return 'none';
  if (s.size === 2) return 'both';
  return [...s][0];
}

function siteOf(entry) {
  return entry.head_location || entry.base_location;
}

function sameValue(entry, change, field) {
  const has = Object.prototype.hasOwnProperty.call(entry, field);
  const want = Object.prototype.hasOwnProperty.call(change, field);
  if (has !== want) return false;
  return !has || stableStringify(entry[field]) === stableStringify(change[field]);
}

function covers(change, entry) {
  if (change.keyword !== entry.keyword) return false;
  if (!sameValue(entry, change, 'old') || !sameValue(entry, change, 'new')) return false;
  if (change.root !== undefined) return change.root === entry.root && change.pointer === entry.pointer;
  return change.location === siteOf(entry);
}

const LOWER_BOUNDS = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties', 'formatMinimum', 'formatExclusiveMinimum']);
const UPPER_BOUNDS = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties', 'formatMaximum', 'formatExclusiveMaximum']);

function setRelation(oldList, newList) {
  const o = new Set(oldList.map(stableStringify));
  const n = new Set(newList.map(stableStringify));
  const sub = [...n].every(x => o.has(x));
  const sup = [...o].every(x => n.has(x));
  if (sub && sup) return 'equal';
  if (sub) return 'subset';
  if (sup) return 'superset';
  return 'other';
}

/**
 * The direction a difference provably has, or null when this function cannot
 * tell. Only keyword changes whose effect is monotone are classified.
 */
function inferDirection(e) {
  const has = (f) => Object.prototype.hasOwnProperty.call(e, f);
  const k = e.keyword;
  if (UPPER_BOUNDS.has(k) || LOWER_BOUNDS.has(k)) {
    if (!has('old')) return 'tighten';
    if (!has('new')) return 'loosen';
    if (typeof e.old !== 'number' || typeof e.new !== 'number') return null;
    const smaller = e.new < e.old;
    return UPPER_BOUNDS.has(k) === smaller ? 'tighten' : 'loosen';
  }
  if (k === 'required') {
    const rel = setRelation(has('old') ? e.old : [], has('new') ? e.new : []);
    return rel === 'superset' ? 'tighten' : rel === 'subset' ? 'loosen' : 'both';
  }
  if (k === 'enum' && has('old') && has('new')) {
    const rel = setRelation(e.old, e.new);
    return rel === 'subset' ? 'tighten' : rel === 'superset' ? 'loosen' : 'both';
  }
  if (['enum', 'const', 'pattern', 'format', 'type', 'multipleOf', 'uniqueItems', 'propertyNames', 'not', 'contains',
    'additionalProperties', 'additionalItems', 'items', 'dependencies'].includes(k)) {
    if (!has('old') && has('new') && k !== 'not') return 'tighten';
    if (has('old') && !has('new') && k !== 'not') return 'loosen';
  }
  if (k === 'anyOf' && e.pointer && /\/anyOf\/\d+$/.test(e.pointer)) {
    if (has('old') && !has('new')) return 'tighten';
    if (!has('old') && has('new')) return 'loosen';
  }
  if (k === '(schema)' && has('old') && has('new')) {
    if (e.new === false || e.old === true) return 'tighten';
    if (e.new === true || e.old === false) return 'loosen';
  }
  return null;
}

/**
 * Matches actual differences against a manifest.
 * Returns { ok, matched: [{ change, entries, side, inferred }], extra, missing, problems }.
 */
function matchManifest(entries, manifest) {
  // Several keywords changed at one node act together (a removed maxLength
  // next to an added pattern), so per-keyword direction inference only
  // applies where a single keyword changed; witnesses check the rest.
  const keywordsAtSite = new Map();
  for (const e of entries) {
    if (!keywordsAtSite.has(siteOf(e))) keywordsAtSite.set(siteOf(e), new Set());
    keywordsAtSite.get(siteOf(e)).add(e.keyword);
  }
  const covered = new Set();
  const matched = [];
  const missing = [];
  const problems = [];
  for (const change of manifest.changes) {
    const hits = entries.filter(e => covers(change, e));
    if (hits.length === 0) {
      missing.push(change);
      continue;
    }
    hits.forEach(h => covered.add(h));
    const side = combineSides(hits.map(h => rootSide(h.root)));
    if (side !== change.side) problems.push({ change, problem: `side is "${change.side}" but the affected roots are on side "${side}"` });
    const single = hits.every(h => keywordsAtSite.get(siteOf(h)).size === 1);
    const inferred = single ? [...new Set(hits.map(inferDirection).filter(Boolean))] : [];
    const inferredDir = inferred.length === 1 ? inferred[0] : inferred.length > 1 ? 'both' : null;
    // `none` claims that context masks a change that is monotone on its own;
    // the witness search checks that claim (no attributed witness).
    if (inferredDir && inferredDir !== change.direction && change.direction !== 'none') {
      problems.push({ change, problem: `direction is "${change.direction}" but the change is a "${inferredDir}"` });
    }
    matched.push({ change, entries: hits, side, inferred: inferredDir });
  }
  const extra = entries.filter(e => !covered.has(e));
  return { ok: extra.length === 0 && missing.length === 0 && problems.length === 0, matched, extra, missing, problems };
}

/** A manifest skeleton covering every difference once per site. */
function skeleton(entries) {
  const keywordsAtSite = new Map();
  for (const e of entries) {
    if (!keywordsAtSite.has(siteOf(e))) keywordsAtSite.set(siteOf(e), new Set());
    keywordsAtSite.get(siteOf(e)).add(e.keyword);
  }
  const sites = new Map();
  for (const e of entries) {
    const key = stableStringify([siteOf(e), e.keyword, e.old, e.new]);
    if (!sites.has(key)) sites.set(key, { e, roots: new Set() });
    sites.get(key).roots.add(e.root);
  }
  const changes = [...sites.values()].map(({ e, roots }) => {
    const c = { location: siteOf(e), keyword: e.keyword };
    if (Object.prototype.hasOwnProperty.call(e, 'old')) c.old = e.old;
    if (Object.prototype.hasOwnProperty.call(e, 'new')) c.new = e.new;
    c.direction = (keywordsAtSite.get(siteOf(e)).size === 1 && inferDirection(e)) || 'both';
    c.side = combineSides([...roots].map(rootSide));
    return c;
  });
  return yaml.dump({ title: 'TODO: describe the intended change', changes }, { lineWidth: 120, noRefs: true });
}

module.exports = { loadManifest, parseManifest, matchManifest, rootSide, inferDirection, skeleton, siteOf, normalizeRoot };
