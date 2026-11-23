#!/usr/bin/env node
/**
 * Keeps each object concept to one definition.
 *
 * Two inline object schemas that stand for the same concept are one
 * definition: one references the other, or one composes the other and states
 * what it adds. The lint compares object schemas in their written form, where
 * annotations don't count and each `$ref` is a leaf that names the schema it
 * resolves to, so two schemas that reference different named definitions stay
 * apart. Sites inside `if`, `then`, `else`, and `not` are conditions, not
 * declarations, and a member of `allOf`, `anyOf`, or `oneOf` with no `type`
 * states part of its parent, so the lint skips both.
 *
 * It fails on:
 *
 *   1. Exact repeats. An inline object schema (not a document root or a
 *      `definitions` entry) with at least one property whose written form
 *      equals another object schema's.
 *   2. Near-duplicates. Two object schemas share a concept when they have the
 *      same `title`, the same `x-entity`, or the same set of two or more
 *      property names (`allOf` members merged). Each such pair must be one of:
 *      a. a declared refinement: one composes the other, through `allOf` or a
 *         `$ref` with keywords beside it, directly or through other
 *         definitions; or one composes a definition that passes against the
 *         other by b or c;
 *      b. parallel: the same property names, each written the same, except a
 *         union tag (a `const` property both require). Only object-level
 *         keywords may differ: `required`, `not`, `if`/`then`/`else`,
 *         `dependencies`, `additionalProperties`, `minProperties`,
 *         `maxProperties`, and combinator members that state only those. A
 *         request and a response variant, or a union branch with its guard,
 *         is parallel. A field written as the other's own field (a `$ref` to
 *         it), nullable or not, is the same field;
 *      c. distinct by reference: the same property names, and a property
 *         that names a different definition on each side tells them apart: a
 *         `$ref` to a different named schema (directly, through `allOf`, or as
 *         the array's items), a different `format`, or a union tag (`const`)
 *         against anything else;
 *      d. different concepts: both have a `title`, the titles differ, and so
 *         do the property names.
 *
 * There is no allowlist. A pair that means the same thing becomes one
 * definition; a pair that doesn't says so in the schema.
 *
 *   node scripts/lint-schema-near-duplicates.cjs [--schemas-dir DIR] [--json FILE] [--parallels]
 *
 * --parallels lists the parallel pairs whose object-level keywords differ,
 * the role variants and guards rule b lets through.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');

const ANNOTATION_KEYS = new Set([
  '$id', '$schema', '$comment', 'title', 'description', 'examples', 'example',
  'default', 'deprecated', 'readOnly', 'writeOnly', 'enumDescriptions', 'enumMetadata',
]);
const OBJECT_LEVEL_KEYS = new Set([
  'required', 'not', 'if', 'then', 'else', 'dependencies', 'dependentRequired', 'dependentSchemas',
  'additionalProperties', 'unevaluatedProperties', 'minProperties', 'maxProperties',
]);
const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf'];
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', 'dependencies', 'dependentSchemas'];
const DEFINITION_KEYS = ['definitions', '$defs'];
const SCHEMA_SINGLE_KEYS = [
  'additionalItems', 'additionalProperties', 'contains', 'items', 'propertyNames',
  'unevaluatedItems', 'unevaluatedProperties',
];
const CONDITION_KEYS = ['if', 'then', 'else', 'not'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAnnotation = (key) => ANNOTATION_KEYS.has(key) || key.startsWith('x-');
const escapePointer = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
const unescapePointer = (segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function loadDocuments(schemasDir) {
  const documents = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'bundled' && entry.name !== 'mcp') walk(full);
      } else if (entry.name.endsWith('.json')) {
        const file = path.relative(schemasDir, full).split(path.sep).join('/');
        if (file === 'index.json') continue;
        documents.set(file, JSON.parse(fs.readFileSync(full, 'utf8')));
      }
    }
  })(schemasDir);
  return documents;
}

function getPointer(node, pointer) {
  if (pointer === '') return node;
  let current = node;
  for (const raw of pointer.slice(1).split('/')) {
    const segment = unescapePointer(raw);
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isObject(current)) current = current[segment];
    else return undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

/** The `file#pointer` a `$ref` written in `file` resolves to. */
function resolveRef(file, ref) {
  const hash = ref.indexOf('#');
  const resource = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  let target;
  if (resource === '') target = file;
  else if (resource.startsWith('/schemas/')) target = resource.slice('/schemas/'.length);
  else if (/^https?:\/\//.test(resource)) {
    const index = resource.indexOf('/schemas/');
    target = index === -1 ? resource : resource.slice(index + '/schemas/'.length).replace(/^(\d+\.\d+(\.\d+)?|latest)\//, '');
  } else target = path.posix.normalize(path.posix.join(path.posix.dirname(file), resource));
  return `${target}#${fragment}`;
}

/** The written form: annotations dropped, each $ref a leaf naming its target. */
function written(node, file) {
  if (!isObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (isAnnotation(key) || DEFINITION_KEYS.includes(key)) continue;
    if (key === '$ref' && typeof value === 'string') out.$ref = resolveRef(file, value);
    else if (key === 'type') out.type = [...new Set(Array.isArray(value) ? value : [value])].sort();
    else if (key === 'required' && Array.isArray(value)) {
      if (value.length) out.required = [...new Set(value)].sort();
    } else if (key === 'enum' && Array.isArray(value)) {
      out.enum = [...new Map(value.map((v) => [stableStringify(v), v])).entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
    } else if (key === 'additionalProperties' && value === true) continue;
    else if (SCHEMA_MAP_KEYS.includes(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [
        name, Array.isArray(child) ? [...child].sort() : written(child, file),
      ]));
    } else if (COMPOSITION_KEYS.includes(key) && Array.isArray(value)) {
      out[key] = value.map((child) => written(child, file)).sort((a, b) => {
        const x = stableStringify(a);
        const y = stableStringify(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    } else if ((SCHEMA_SINGLE_KEYS.includes(key) || CONDITION_KEYS.includes(key)) && (isObject(value) || typeof value === 'boolean')) {
      out[key] = written(value, file);
    } else if (key === 'items' && Array.isArray(value)) {
      out.items = value.map((child) => written(child, file));
    } else out[key] = value;
  }
  return out;
}

/** Every schema position, with where it sits. */
function collectSites(documents) {
  const sites = [];
  function visit(node, file, pointer, context) {
    if (!isObject(node)) return;
    sites.push({ file, pointer, node, ...context });
    const child = (value, segment, extra = {}) => visit(value, file, `${pointer}/${segment}`, {
      conditional: context.conditional || extra.conditional || false,
      fragment: extra.fragment || false,
    });
    for (const key of [...SCHEMA_MAP_KEYS, ...DEFINITION_KEYS]) {
      if (!isObject(node[key])) continue;
      for (const [name, value] of Object.entries(node[key])) child(value, `${key}/${escapePointer(name)}`);
    }
    for (const key of SCHEMA_SINGLE_KEYS) if (isObject(node[key])) child(node[key], key);
    if (Array.isArray(node.items)) node.items.forEach((value, i) => child(value, `items/${i}`));
    for (const key of CONDITION_KEYS) if (isObject(node[key])) child(node[key], key, { conditional: true });
    for (const key of COMPOSITION_KEYS) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((value, i) => child(value, `${key}/${i}`, { fragment: isObject(value) && value.type === undefined }));
    }
  }
  for (const [file, schema] of documents) visit(schema, file, '', { conditional: false, fragment: false });
  return sites;
}

function checkTree(documents) {
  const sites = collectSites(documents);
  const byKey = new Map(sites.map((site) => [`${site.file}#${site.pointer}`, site]));
  const siteAt = (key) => {
    if (byKey.has(key)) return byKey.get(key);
    const hash = key.indexOf('#');
    const doc = documents.get(key.slice(0, hash));
    const node = doc === undefined ? undefined : getPointer(doc, key.slice(hash + 1));
    return isObject(node) ? { file: key.slice(0, hash), pointer: key.slice(hash + 1), node } : null;
  };
  const writtenOf = (site) => {
    if (site.writtenForm === undefined) site.writtenForm = written(site.node, site.file);
    return site.writtenForm;
  };

  /** The definitions a site composes: its `$ref` beside keywords, and `$ref` members of its `allOf`. */
  const basesOf = (site) => {
    const bases = [];
    if (typeof site.node.$ref === 'string') bases.push(resolveRef(site.file, site.node.$ref));
    for (const member of Array.isArray(site.node.allOf) ? site.node.allOf : []) {
      if (isObject(member) && typeof member.$ref === 'string') bases.push(resolveRef(site.file, member.$ref));
    }
    return bases;
  };
  const ancestors = new Map();
  const composes = (site) => {
    const key = `${site.file}#${site.pointer}`;
    if (ancestors.has(key)) return ancestors.get(key);
    const out = new Set();
    ancestors.set(key, out);
    for (const base of basesOf(site)) {
      out.add(base);
      const target = siteAt(base);
      if (target) for (const a of composes(target)) out.add(a);
    }
    return out;
  };

  /** Property names, with `allOf` members merged through their `$ref`s. */
  const namesCache = new Map();
  const propertyNames = (node, file, seen = new Set()) => {
    const out = new Set();
    if (!isObject(node)) return out;
    if (isObject(node.properties)) for (const name of Object.keys(node.properties)) out.add(name);
    const refs = [];
    if (typeof node.$ref === 'string') refs.push(resolveRef(file, node.$ref));
    for (const member of Array.isArray(node.allOf) ? node.allOf : []) {
      if (!isObject(member)) continue;
      if (typeof member.$ref === 'string' && Object.keys(member).filter((k) => !isAnnotation(k)).length === 1) {
        refs.push(resolveRef(file, member.$ref));
      } else for (const name of propertyNames(member, file, seen)) out.add(name);
    }
    for (const ref of refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (!namesCache.has(ref)) {
        const target = siteAt(ref);
        namesCache.set(ref, target ? propertyNames(target.node, target.file, seen) : new Set());
      }
      for (const name of namesCache.get(ref)) out.add(name);
    }
    return out;
  };

  const isRefOnly = (site) => {
    const keys = Object.keys(site.node).filter((key) => !isAnnotation(key));
    if (keys.length === 1 && keys[0] === 'allOf' && Array.isArray(site.node.allOf) && site.node.allOf.length === 1
      && isObject(site.node.allOf[0]) && typeof site.node.allOf[0].$ref === 'string'
      && Object.keys(site.node.allOf[0]).every((key) => key === '$ref' || isAnnotation(key))) return true;
    if (typeof site.node.$ref !== 'string') return false;
    const target = siteAt(resolveRef(site.file, site.node.$ref));
    return Object.keys(site.node).every((key) => key === '$ref' || isAnnotation(key)
      || (target && stableStringify(written({ [key]: site.node[key] }, site.file))
        === stableStringify(written({ [key]: target.node[key] }, target.file))));
  };
  const types = (node) => (node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type]);

  const objects = [];
  for (const site of sites) {
    if (site.conditional || site.fragment || isRefOnly(site)) continue;
    const names = propertyNames(site.node, site.file);
    const isObjectSchema = types(site.node).includes('object') || isObject(site.node.properties)
      || (Array.isArray(site.node.allOf) && names.size > 0);
    if (!isObjectSchema || names.size === 0) continue;
    site.names = [...names].sort();
    site.key = `${site.file}#${site.pointer}`;
    site.title = typeof site.node.title === 'string' ? site.node.title.trim().toLowerCase().replace(/\s+/g, ' ') : null;
    site.entity = typeof site.node['x-entity'] === 'string' ? site.node['x-entity'] : null;
    objects.push(site);
  }

  const objectByKey = new Map(objects.map((site) => [site.key, site]));
  /** The definitions a site composes directly: its `$ref` beside keywords and its `allOf` `$ref`s. */
  const directBases = (site) => basesOf(site);
  /**
   * The property names a site states itself or through its other composed
   * definitions: its body inside the definition `base`.
   */
  const bodyNames = (site, base) => {
    const target = siteAt(base);
    if (!target) return null;
    const around = propertyNames(target.node, target.file);
    if (around.size === 0) return null;
    const body = [...propertyNames(site.node, site.file, new Set([base]))].sort();
    // A body that the definition already declares refines it; it isn't wrapped.
    return body.every((name) => around.has(name)) ? null : body;
  };

  // 1. Exact repeats.
  const byForm = new Map();
  for (const site of objects) {
    const form = stableStringify(writtenOf(site));
    if (!byForm.has(form)) byForm.set(form, []);
    byForm.get(form).push(site);
  }
  const isNamed = (site) => site.pointer === '' || /^\/(definitions|\$defs)\/[^/]+$/.test(site.pointer);
  const repeats = [...byForm.values()].filter((group) => group.length >= 2 && group.some((site) => !isNamed(site)));

  // 2. Near-duplicates.
  const groups = new Map();
  const addTo = (label, site) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(site);
  };
  for (const site of objects) {
    if (site.title) addTo(`title "${site.node.title.trim()}"`, site);
    if (site.entity) addTo(`x-entity ${site.entity}`, site);
    if (site.names.length >= 2) addTo(`properties ${site.names.join(', ')}`, site);
    // An object that composes a definition around a body of its own joins the
    // group of that body, so a restated body is paired with its definition.
    for (const base of isNamed(site) ? directBases(site) : []) {
      const body = bodyNames(site, base);
      if (body && body.length >= 2) addTo(`body ${body.join(', ')}`, site);
    }
  }

  // A body group also holds the objects whose own property names are that body.
  for (const [label, members] of groups) {
    if (!label.startsWith('body ')) continue;
    const names = label.slice('body '.length);
    for (const site of objects) {
      if (site.names.join(', ') === names && !members.includes(site)) members.push(site);
    }
  }

  const isTag = (a, b, name) => {
    const pa = a.node.properties && a.node.properties[name];
    const pb = b.node.properties && b.node.properties[name];
    const constOf = (p) => (isObject(p) && (p.const !== undefined || (Array.isArray(p.enum) && p.enum.length === 1)));
    const req = (s) => (Array.isArray(s.node.required) && s.node.required.includes(name));
    return constOf(pa) && constOf(pb) && req(a) && req(b);
  };
  const isGuard = (member) => isObject(member) && Object.keys(member).every((k) => OBJECT_LEVEL_KEYS.has(k));
  /** The written form without object-level keywords, guard members, or properties. */
  const isRefLeaf = (form) => isObject(form) && Object.keys(form).length === 1 && typeof form.$ref === 'string';

  /**
   * The contract a site states, with what it composes through `allOf` (and a
   * `$ref` beside keywords) merged in: each property's written forms, and each
   * other keyword's. Object-level keywords and guard members are left out; the
   * definitions in `skip` (bases both sides share) are not merged.
   */
  function effective(site, skip) {
    const props = new Map();
    const keys = new Map();
    const add = (map, key, value) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(stableStringify(value));
    };
    const seen = new Set();
    const visit = (node, file) => {
      if (!isObject(node)) return;
      const form = written(node, file);
      for (const [key, value] of Object.entries(form)) {
        if (key === 'properties') {
          // A property that only annotates (a description beside a composed
          // definition) adds nothing to the contract.
          for (const [name, schema] of Object.entries(value)) {
            if (isObject(schema) && Object.keys(schema).length === 0 && props.has(name)) continue;
            add(props, name, schema);
          }
        } else if (OBJECT_LEVEL_KEYS.has(key) || key === '$ref' || key === 'allOf') {
          continue;
        } else if (key === 'anyOf' || key === 'oneOf') {
          const kept = value.filter((member) => !isGuard(member));
          if (kept.length) add(keys, key, kept);
        } else add(keys, key, value);
      }
      const refs = [];
      if (typeof node.$ref === 'string') refs.push(resolveRef(file, node.$ref));
      for (const member of Array.isArray(node.allOf) ? node.allOf : []) {
        if (!isObject(member)) continue;
        if (typeof member.$ref === 'string') refs.push(resolveRef(file, member.$ref));
        visit(Object.fromEntries(Object.entries(member).filter(([key]) => key !== '$ref')), file);
      }
      for (const ref of refs) {
        if (skip.has(ref) || seen.has(ref)) continue;
        seen.add(ref);
        const target = siteAt(ref);
        if (target) visit(target.node, target.file);
      }
    };
    visit(site.node, site.file);
    for (const set of props.values()) if (set.size > 1) set.delete('{}');
    return { props, keys };
  }
  const setText = (set) => (set ? [...set].sort().join(' & ') : 'none');
  /** Two written forms that pin a property to different `const` values: a union tag. */
  const constsOf = (set) => new Set([...(set || [])].map((text) => JSON.parse(text))
    .filter((form) => isObject(form) && form.const !== undefined).map((form) => stableStringify(form.const)));
  const differentTags = (a, b) => {
    const ca = constsOf(a);
    const cb = constsOf(b);
    return ca.size > 0 && cb.size > 0 && ![...ca].some((value) => cb.has(value));
  };

  /**
   * x composes a definition around a body whose property names are y's: x
   * restates y inside that definition unless a field of the body names a
   * different definition. The fix is for x to compose y.
   */
  function restatedBody(x, y) {
    if (!isNamed(x) || !isNamed(y) || composes(x).has(y.key) || composes(y).has(x.key)) return null;
    for (const envelope of directBases(x)) {
      if (envelope === y.key || composes(y).has(envelope)) continue;
      const body = bodyNames(x, envelope);
      if (!body || body.length < 2 || body.join(',') !== y.names.join(',')) continue;
      // Two refinements of a definition that declares the whole body restate nothing.
      const shared = new Set();
      for (const base of composes(x)) {
        if (!composes(y).has(base)) continue;
        const target = siteAt(base);
        if (target) for (const name of propertyNames(target.node, target.file)) shared.add(name);
      }
      if (body.every((name) => shared.has(name))) continue;
      const ex = effective(x, new Set([envelope]));
      const ey = effective(y, new Set());
      // Bodies whose union tags differ are different concepts.
      if (body.some((name) => differentTags(ex.props.get(name), ey.props.get(name)))) return { ok: true };
      const diffs = [];
      for (const name of body) {
        const px = setText(ex.props.get(name));
        const py = setText(ey.props.get(name));
        if (px === py) continue;
        const one = (set) => (set && set.size === 1 ? JSON.parse([...set][0]) : undefined);
        const named = (form) => (isObject(form) && (isRefLeaf(form) || isRefLeaf(form.items)) ? stableStringify(form) : null);
        const nx = named(one(ex.props.get(name)));
        const ny = named(one(ey.props.get(name)));
        if (nx && ny && nx !== ny) return { ok: true };
        diffs.push(`${name}: ${brief(px)} here, ${brief(py)} there`);
      }
      return {
        ok: false,
        why: `restates ${y.key} inside ${envelope}${diffs.length ? ', with drift' : ''}`,
        diffs: diffs.length ? diffs : [`compose it: allOf: [{"$ref": "${envelope}"}, {"$ref": "${y.key}"}]`],
      };
    }
    return null;
  }

  function comparePair(a, b, depth = 0) {
    if (composes(a).has(b.key) || composes(b).has(a.key)) return { ok: true };
    if (depth === 0) {
      const wrapped = restatedBody(a, b) || restatedBody(b, a);
      if (wrapped) return wrapped;
    }
    if (depth === 0) {
      for (const [x, y] of [[a, b], [b, a]]) {
        for (const base of composes(x)) {
          // The definition must pass against y on its contract: that y also
          // composes it says nothing about what x adds.
          if (composes(y).has(base)) continue;
          const target = objectByKey.get(base);
          if (target && target !== y && comparePair(target, y, 1).ok) return { ok: true };
        }
      }
    }
    // Two refinements of one definition share its properties; what each adds
    // is what they are compared on.
    const common = [...composes(a)].filter((base) => composes(b).has(base));
    let names = a.names;
    if (common.length) {
      const inherited = new Set();
      for (const base of common) {
        const target = siteAt(base);
        if (target) for (const name of propertyNames(target.node, target.file)) inherited.add(name);
      }
      const ra = a.names.filter((n) => !inherited.has(n));
      const rb = b.names.filter((n) => !inherited.has(n));
      // What both inherit is not their concept: two refinements share one
      // only when what they add is the same two or more property names.
      if (ra.length < 2 || ra.join(',') !== rb.join(',')) return { ok: true };
      names = ra;
    }
    const sameNames = a.names.join(',') === b.names.join(',');
    if (!sameNames) {
      if (a.title && b.title && a.title !== b.title) return { ok: true };
      return { ok: false, why: 'different properties, and no distinct titles', diffs: nameDiff(a, b) };
    }
    const skip = new Set(common);
    const ea = effective(a, skip);
    const eb = effective(b, skip);
    const diffs = [];
    let parallel = true;
    let byReference = false;
    const one = (set) => (set && set.size === 1 ? JSON.parse([...set][0]) : undefined);
    // The named schema a written form refers to: a $ref leaf, or an allOf that
    // composes one (a declared refinement of it).
    const refName = (form) => {
      if (isRefLeaf(form)) return form.$ref;
      if (isObject(form) && Array.isArray(form.allOf)) {
        const refs = form.allOf.filter(isRefLeaf);
        if (refs.length === 1) return refs[0].$ref;
      }
      return null;
    };
    const names_ = (form) => {
      if (refName(form)) return `ref ${refName(form)}`;
      if (isObject(form) && refName(form.items)) return `items ref ${refName(form.items)}`;
      if (isObject(form) && form.const !== undefined) return `const ${stableStringify(form.const)}`;
      if (isObject(form) && typeof form.format === 'string') return `format ${form.format}`;
      return null;
    };
    // A request variant can write a field as the other site's own field, made
    // nullable so that null clears it: that is the same field.
    const sameField = (set, other, name) => {
      if (!set) return set;
      const out = new Set();
      for (const text of set) {
        let form = JSON.parse(text);
        for (const key of ['anyOf', 'oneOf']) {
          if (isObject(form) && Object.keys(form).length === 1 && Array.isArray(form[key]) && form[key].length === 2) {
            const rest = form[key].filter((m) => stableStringify(m) !== stableStringify({ type: ['null'] }));
            if (rest.length === 1) form = rest[0];
          }
        }
        if (isRefLeaf(form) && form.$ref === `${other.key}/properties/${name}`) {
          const target = siteAt(form.$ref);
          if (target) form = written(target.node, target.file);
        }
        out.add(stableStringify(form));
      }
      return out;
    };
    for (const name of names) {
      const pa = sameField(ea.props.get(name), b, name);
      const pb = sameField(eb.props.get(name), a, name);
      if (setText(pa) === setText(pb)) continue;
      if (isTag(a, b, name) || differentTags(pa, pb)) { byReference = true; continue; }
      parallel = false;
      const na = names_(one(pa));
      const nb = names_(one(pb));
      if (na && nb && na !== nb) byReference = true;
      diffs.push(one(pa) !== undefined && one(pb) !== undefined
        ? propertyDiff(name, one(pa), one(pb))
        : `${name}: ${setText(pa)} here, ${setText(pb)} there`);
    }
    for (const key of new Set([...ea.keys.keys(), ...eb.keys.keys()])) {
      if (setText(ea.keys.get(key)) === setText(eb.keys.get(key))) continue;
      parallel = false;
      diffs.push(`${key}: ${brief(setText(ea.keys.get(key)))} here, ${brief(setText(eb.keys.get(key)))} there`);
    }
    if (parallel) {
      const fa = writtenOf(a);
      const fb = writtenOf(b);
      const roles = [];
      for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
        if (key === 'properties' || !OBJECT_LEVEL_KEYS.has(key)) continue;
        if (stableStringify(fa[key]) !== stableStringify(fb[key])) roles.push(key);
      }
      return { ok: true, parallel: roles };
    }
    if (byReference) return { ok: true };
    return { ok: false, why: 'same properties, different contract', diffs };
  }
  function nameDiff(a, b) {
    const sa = new Set(a.names);
    const sb = new Set(b.names);
    return [`properties only here: ${a.names.filter((n) => !sb.has(n)).join(', ') || 'none'}; only there: ${b.names.filter((n) => !sa.has(n)).join(', ') || 'none'}`];
  }
  function brief(value) {
    if (value === undefined) return 'none';
    const text = typeof value === 'string' ? value : stableStringify(value);
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  }
  function propertyDiff(name, pa, pb) {
    if (!isObject(pa) || !isObject(pb)) return `${name}: ${brief(pa)} here, ${brief(pb)} there`;
    const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    const parts = [];
    for (const key of keys) {
      if (stableStringify(pa[key]) !== stableStringify(pb[key])) parts.push(`${name} ${key}: ${brief(pa[key])} here, ${brief(pb[key])} there`);
    }
    return parts.join('; ');
  }

  const failures = [];
  const parallels = [];
  const seenPairs = new Set();
  for (const [label, members] of groups) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = [members[i], members[j]].sort((x, y) => (x.key < y.key ? -1 : 1));
        const pair = `${a.key} ${b.key}`;
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        // A site is not a copy of a part of itself.
        if (a.file === b.file && (b.pointer.startsWith(`${a.pointer}/`) || a.pointer.startsWith(`${b.pointer}/`))) continue;
        const result = label.startsWith('body ')
          ? (restatedBody(a, b) || restatedBody(b, a) || { ok: true })
          : comparePair(a, b);
        if (!result.ok) failures.push({ label, a, b, ...result });
        else if (result.parallel && result.parallel.length) parallels.push({ label, a, b, keys: result.parallel });
      }
    }
  }
  return { objects, repeats, failures, parallels };
}

function report({ repeats, failures, parallels }) {
  const lines = [];
  for (const group of repeats) {
    lines.push([
      `Exact repeat: ${group.length} object schemas with the same contract:`,
      ...group.map((site) => `    ${site.key}`),
      '  Fix: keep one definition (a definitions entry, or a titled document under core/ when other documents use it) and replace the others with a $ref to it.',
    ].join('\n'));
  }
  for (const f of failures) {
    lines.push([
      `${f.a.key} and ${f.b.key}: same concept (${f.label}), ${f.why}:`,
      ...f.diffs.map((d) => `    ${d}`),
      '  Fix: replace one with a $ref to the other, or compose it: allOf: [{"$ref": <the definition>}, {<what it adds>}].',
      '  If they are role variants (request and response, a union branch and its guard), state each shared field the same way, by $ref to one definition.',
      '  If they mean different things, give both a distinct title and reference a distinct named definition where their fields differ.',
    ].join('\n'));
  }
  const sites = new Set();
  for (const group of repeats) for (const site of group) sites.add(site.key);
  for (const f of failures) { sites.add(f.a.key); sites.add(f.b.key); }
  const info = parallels.map((p) => `    ${p.a.key} | ${p.b.key}: ${p.keys.join(', ')}`);
  return { lines, sites, info };
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas-dir', DEFAULT_SCHEMAS_DIR));
  const result = checkTree(loadDocuments(schemasDir));
  const { lines, sites, info } = report(result);
  if (args.includes('--json')) {
    const out = readArg(args, '--json');
    fs.writeFileSync(out, JSON.stringify({
      repeats: result.repeats.map((g) => g.map((s) => s.key)),
      failures: result.failures.map((f) => ({ label: f.label, a: f.a.key, b: f.b.key, why: f.why, diffs: f.diffs })),
      parallels: result.parallels.map((p) => ({ a: p.a.key, b: p.b.key, keys: p.keys })),
    }, null, 1));
  }
  if (args.includes('--parallels') && info.length) {
    console.log(`Parallel variants that differ only in object-level keywords (role variants, guards):\n${info.join('\n')}\n`);
  }
  if (lines.length > 0) {
    console.error(`Schema near-duplicate lint: ${result.repeats.length} exact repeat group(s), ${result.failures.length} near-duplicate pair(s), ${sites.size} site(s)\n\n${lines.join('\n\n')}`);
    process.exit(1);
  }
  console.log(`✓ schema near-duplicate lint: ${result.objects.length} object schemas, one definition per concept, ${result.parallels.length} parallel role variants`);
}

if (require.main === module) main();

module.exports = { checkTree, collectSites, loadDocuments, report, resolveRef, written };
