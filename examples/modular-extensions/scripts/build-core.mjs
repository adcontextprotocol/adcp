#!/usr/bin/env node
// core/upstream/ (verbatim adcp-main) + core/patches.json  ->  core/schemas/
//
// The core bundle is cut into layers (core/placement.json, the final layout; see
// lib/layout.mjs): the kernel (`core`), kernel types, the standard modules
// (creative, governance, reporting, accounts, signals, identity,
// sponsored-intelligence, trusted-match; plus the compliance-testing leaf),
// buying's eight layers (`buying/targeting` ... `buying/delivery`), each its own
// layer, the generated `_assembly`, and `x-<name>` for a file the layout places in
// an extension. Each patch belongs to the layer that owns the file it changes, so
// the kernel can't open a hook on a module's object, a module can't change the
// kernel, and one buying layer can't change another.
//
// core/release.json is the published contract: per layer a version, the hooks
// it declares (with their contract majors), and a frozen digest; plus core type
// majors and the digest of the whole bundle. The build FAILS if a layer no
// longer hashes to its digest, or if the hooks annotated in a layer differ from
// the ones its release entry lists. So extension work that would need a kernel
// or module change cannot slip in. `--freeze` re-stamps the digests (a release
// of the layers that moved, not an extension change).
//
// A re-stamp is also gated: within a layer's major, every change since the layer's last release must be
// additive (lib/additive.mjs). core/release-baseline.json records, per layer, the patches that were in
// force at its last release; `--freeze` rebuilds that previous state, compares each moved layer file by
// file, and refuses with NOT ADDITIVE when a change would break a reader on the previous minor (a newly
// required property, a removed one, a narrowed type, bound, or enum). Edited or removed released patches
// are refused too (RELEASED PATCH CHANGED). A new major starts a new baseline.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoreSchemas } from '../lib/core-schemas.mjs';
import { digestOfValue } from '../lib/digest.mjs';
import { additiveLayerDiff } from '../lib/additive.mjs';
import { KERNEL, KERNEL_TYPES, BUYING_DIRECT_DEPS, buyingLayerOf, roleOf } from '../lib/layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = path.join(ROOT, 'core/upstream');
const OUT = path.join(ROOT, 'core/schemas');
export { KERNEL };

export const readPatches = () => JSON.parse(readFileSync(path.join(ROOT, 'core/patches.json'), 'utf8')).layers;
/** Module registries whose fields the kernel types with an open id: registry $id -> kernel type $id. */
export const readRegistries = () => JSON.parse(readFileSync(path.join(ROOT, 'core/patches.json'), 'utf8')).registries ?? {};
const upstreamPlacement = () => JSON.parse(readFileSync(path.join(ROOT, 'core/placement.json'), 'utf8')).layers;

/** file (relative to core/schemas) -> owning layer, including files the patches create. */
export function placement(layers = readPatches()) {
  const out = { ...upstreamPlacement() };
  for (const l of layers) for (const p of l.patches) if (p.op === 'create') out[p.file] = l.layer;
  return out;
}

function resolve(doc, pointer) {
  const tokens = pointer.split('/').slice(1);
  const key = tokens.pop();
  let node = doc;
  for (const t of tokens) node = node[t];
  return { node, key };
}

const isKernelLayerName = (layer) => layer === KERNEL || layer === KERNEL_TYPES;

/**
 * compose: the 3.4 registry composition, at one $ref. The source schema types the field with a kernel open id
 * or core (registries: module registry $id -> kernel type $id), and the build composes the module-owned
 * definition, the registry's known values, into the published schema:
 *   { $ref: R, ...rest }  ->  { ...rest, allOf: [{ $ref: K }, <R inlined>], "x-adcp-registry": R }
 * A $ref with no kernel type (a wrapper the host module owns, such as indicator-bearing) is inlined as
 *   { ...rest, allOf: [<R inlined>], "x-adcp-composed-from": R }.
 * Inside an inlined definition, every $ref outside the kernel layer is composed the same way, so the
 * result refers only to the kernel layer. The inlined copy is the referenced schema without $schema and
 * $id, and the kernel type is a superset of it, so the field accepts exactly what it accepted before.
 */
function composeRef(node, ctx, stack) {
  const { $ref: ref, ...rest } = node;
  if (typeof ref !== 'string' || !ref.startsWith('/schemas/')) throw new Error(`compose: ${ref} is not a core $ref`);
  if (stack.includes(ref)) throw new Error(`compose: cycle ${[...stack, ref].join(' -> ')}`);
  if (rest.allOf) throw new Error(`compose: ${ref} already has allOf siblings`);
  const [fileId, frag] = ref.split('#');
  const rel = fileId.slice('/schemas/'.length);
  let body = ctx.read(rel);
  if (frag) for (const t of frag.split('/').slice(1)) body = body[t.replace(/~1/g, '/').replace(/~0/g, '~')];
  body = structuredClone(body);
  delete body.$schema;
  delete body.$id;
  const inline = (n) => {
    if (!n || typeof n !== 'object') return; // arrays too: their entries are keyed by index
    for (const [k, v] of Object.entries(n)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$ref === 'string') {
        if (v.$ref.startsWith('#')) throw new Error(`compose: ${ref} has a local $ref ${v.$ref}`);
        const target = ctx.owner[v.$ref.split('#')[0].slice('/schemas/'.length)];
        n[k] = isKernelLayerName(target) ? v : composeRef(v, ctx, [...stack, ref]);
        if (n[k] !== v) continue;
      }
      inline(n[k]);
    }
  };
  if (typeof body.$ref === 'string' && !isKernelLayerName(ctx.owner[body.$ref.split('#')[0].slice('/schemas/'.length)])) {
    body = composeRef(body, ctx, [...stack, ref]);
  } else inline(body);
  const kernelType = !frag && ctx.registries[ref];
  return kernelType
    ? { ...rest, allOf: [{ $ref: kernelType }, body], 'x-adcp-registry': ref }
    : { ...rest, allOf: [body], 'x-adcp-composed-from': ref };
}

/**
 * Apply every layer's patches. Returns Map(file -> patched document).
 * Throws if a patch touches a file another layer owns, or if an op is neither additive nor wire-preserving.
 */
export function applyPatches(readUpstream, layers = readPatches(), registries = readRegistries()) {
  const owner = placement(layers);
  const changed = new Map();
  const ctx = { owner, registries, read: (f) => changed.get(f) ?? readUpstream(f) };
  for (const { layer, patches } of layers) {
    for (const p of patches) {
      const at = `${layer}: ${p.op} ${p.file}${p.pointer ?? ''}`;
      if (owner[p.file] !== layer) throw new Error(`${at}: the file belongs to layer ${owner[p.file]}`);
      if (p.op === 'create') {
        if (changed.has(p.file)) throw new Error(`${at}: file exists`);
        changed.set(p.file, structuredClone(p.value));
        continue;
      }
      const doc = changed.get(p.file) ?? readUpstream(p.file);
      const { node, key } = resolve(doc, p.pointer);
      if (p.op === 'add') {
        if (key in node) throw new Error(`${at}: target exists`);
        node[key] = structuredClone(p.value);
      } else if (p.op === 'append') {
        if (!Array.isArray(node[key])) throw new Error(`${at}: target is not an array`);
        node[key].push(structuredClone(p.value));
      } else if (p.op === 'widen') {
        // Pure widening: the old schema is the first anyOf branch, untouched.
        if (!node[key] || typeof node[key] !== 'object') throw new Error(`${at}: no schema to widen`);
        node[key] = { anyOf: [node[key], structuredClone(p.value)], ...(p.annotate ?? {}) };
      } else if (p.op === 'compose') {
        // Wire-preserving: the field accepts exactly what it accepted before (see composeRef).
        if (node[key]?.$ref !== p.ref) throw new Error(`${at}: expected a $ref to ${p.ref}, found ${node[key]?.$ref}`);
        node[key] = composeRef(node[key], ctx, []);
      } else {
        throw new Error(`${at}: unsupported op (only create, add, append, widen, compose)`);
      }
      changed.set(p.file, doc);
    }
  }
  return changed;
}

/** Every hook annotation in core: { name, kind: 'extension-point' | 'union', value, id, layer }. */
export function annotatedHooks(schemas = loadCoreSchemas(), owner = placement()) {
  const found = [];
  for (const { id, schema } of schemas) {
    const layer = owner[id.replace(/^\/schemas\//, '')];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n)) {
        if (k === 'x-adcp-extension-point') found.push({ name: v.name, kind: 'extension-point', value: v, id, layer });
        else if (k === 'x-adcp-open-union') found.push({ name: v.name, kind: 'union', value: v, id, layer });
        else walk(v);
      }
    };
    walk(schema);
  }
  return found;
}

/** { layer: { hook: true } } from the annotations, after checking one owner per hook. */
export function hooksByLayer(hooks = annotatedHooks()) {
  const out = {};
  const ownerOf = new Map();
  for (const h of hooks) {
    const prev = ownerOf.get(h.name);
    if (prev && (prev.layer !== h.layer || prev.kind !== h.kind)) {
      throw new Error(`hook ${h.name} is declared by ${prev.layer} (${prev.kind}) and ${h.layer} (${h.kind}); a hook has one owner`);
    }
    if (prev && JSON.stringify(prev.value) !== JSON.stringify(h.value)) {
      throw new Error(`hook ${h.name}: ${prev.id} and ${h.id} annotate it differently`);
    }
    ownerOf.set(h.name, h);
    (out[h.layer] ??= {})[h.name] = true;
  }
  return out;
}

/** Digest of one layer: JCS of { $id: schema } over the files it owns. */
export function layerDigests(schemas = loadCoreSchemas(), owner = placement()) {
  const byLayer = {};
  for (const s of schemas) {
    const layer = owner[s.id.replace(/^\/schemas\//, '')];
    if (!layer) throw new Error(`${s.id}: no layer in core/placement.json`);
    (byLayer[layer] ??= {})[s.id] = s.schema;
  }
  return Object.fromEntries(Object.entries(byLayer).sort(([a], [b]) => (a < b ? -1 : 1)).map(([l, docs]) => [l, digestOfValue(docs)]));
}

/** Digest of the whole pinned core bundle: JCS of { $id: schema }. */
export function coreBundleDigest(schemas = loadCoreSchemas()) {
  return digestOfValue(Object.fromEntries(schemas.map((s) => [s.id, s.schema])));
}

export { KERNEL_TYPES };
// The kernel layer and the assembly carry the AdCP version; modules and buying layers start at 1.0,
// except the opt-in offer layer, which starts at 0.x (the final layout, 4.0 migration item 9); extensions at 0.1.
const defaultVersion = (layer, release) =>
  layer === KERNEL || layer === KERNEL_TYPES || layer.startsWith('_')
    ? release.adcp_version.split('.').slice(0, 2).join('.')
    : layer.startsWith('x-') || layer === 'buying/offer'
      ? '0.1'
      : '1.0';

const BASELINE = path.join(ROOT, 'core/release-baseline.json');
const majorOf = (v) => String(v).split('.')[0];

/**
 * The additive gate for a re-stamp: for each layer whose digest moved and whose major didn't, compare its
 * files now with the files its last release had (upstream plus the released patches). Returns problems.
 */
export function releaseGate(release, digests, layers = readPatches(), readUpstream = (f) => JSON.parse(readFileSync(path.join(UPSTREAM, f), 'utf8'))) {
  if (!existsSync(BASELINE)) return [];
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).layers;
  const problems = [];
  const released = layers.map((l) => {
    const b = baseline[l.layer] ?? { patches: 0, digest: digestOfValue([]) };
    const prefix = l.patches.slice(0, b.patches);
    if (b.patches && (prefix.length < b.patches || digestOfValue(prefix) !== b.digest)) problems.push(`RELEASED PATCH CHANGED: ${l.layer}: a patch in force at ${l.layer} ${b.version} was edited or removed; add a new patch instead`);
    return { ...l, patches: prefix };
  });
  if (problems.length) return problems;
  const before = applyPatches(readUpstream, released);
  const owner = placement(layers);
  const now = applyPatches(readUpstream, layers);
  for (const [layer, digest] of Object.entries(digests)) {
    const entry = release.layers?.[layer];
    const b = baseline[layer];
    if (!entry || !b || entry.digest === digest || majorOf(entry.version) !== majorOf(b.version)) continue;
    const files = Object.keys(owner).filter((f) => owner[f] === layer);
    const read = (m, f) => (m.has(f) ? m.get(f) : existsSync(path.join(UPSTREAM, f)) ? readUpstream(f) : undefined);
    const prev = new Map(files.filter((f) => read(before, f) !== undefined).map((f) => [f, read(before, f)]));
    const next = new Map(files.map((f) => [f, read(now, f)]));
    const diff = additiveLayerDiff(prev, next);
    for (const c of diff.changes.filter((x) => !x.additive)) problems.push(`NOT ADDITIVE: ${layer} ${b.version} -> ${entry.version}: ${c.file}#${c.pointer}: ${c.change}; this needs ${layer} ${Number(majorOf(b.version)) + 1}.0`);
  }
  return problems;
}

/** Record the patches in force at this release, per layer (written by --freeze). */
function writeBaseline(release, layers = readPatches()) {
  const out = {};
  for (const layer of Object.keys(release.layers)) {
    const patches = layers.find((l) => l.layer === layer)?.patches ?? [];
    out[layer] = { version: release.layers[layer].version, patches: patches.length, digest: digestOfValue(patches) };
  }
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        $comment: 'Per layer, the core/patches.json entries in force at its last release (count and JCS digest), written by build-core.mjs --freeze. The next re-stamp rebuilds that state and refuses any non-additive change within the same major.',
        layers: Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))),
      },
      null,
      2
    ) + '\n'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(OUT, { recursive: true, force: true });
  cpSync(UPSTREAM, OUT, { recursive: true });
  const changed = applyPatches((f) => JSON.parse(readFileSync(path.join(UPSTREAM, f), 'utf8')));
  const owner = placement();
  for (const [file, doc] of changed) {
    const target = path.join(OUT, file);
    mkdirSync(path.dirname(target), { recursive: true });
    const isNew = !existsSync(path.join(UPSTREAM, file));
    writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
    console.log(`${isNew ? 'created ' : 'patched '} ${owner[file].padEnd(10)} core/schemas/${file}`);
  }
  const schemas = loadCoreSchemas();
  const ids = schemas.map((s) => s.id);
  writeFileSync(path.join(ROOT, 'core/schemas-index.json'), JSON.stringify(ids, null, 2) + '\n');

  const digests = layerDigests(schemas, owner);
  const hooks = hooksByLayer(annotatedHooks(schemas, owner));
  const releaseFile = path.join(ROOT, 'core/release.json');
  const release = JSON.parse(readFileSync(releaseFile, 'utf8'));
  const problems = [];
  for (const layer of new Set([...Object.keys(digests), ...Object.keys(release.layers ?? {})])) {
    const entry = release.layers?.[layer];
    const annotated = Object.keys(hooks[layer] ?? {}).sort();
    const listed = Object.keys(entry?.hooks ?? {}).sort();
    if (JSON.stringify(annotated) !== JSON.stringify(listed)) {
      problems.push(`HOOKS DIFFER: ${layer} annotates [${annotated}] but core/release.json lists [${listed}]`);
    }
    if (!process.argv.includes('--freeze') && entry?.digest !== digests[layer]) {
      problems.push(`LAYER MOVED: ${layer} ${entry?.version ?? '(new)'} hashes to ${digests[layer]}, core/release.json says ${entry?.digest}`);
    }
  }
  const bundle = coreBundleDigest(schemas);
  if (process.argv.includes('--freeze')) {
    const gate = releaseGate(release, digests);
    if (gate.length) {
      console.error(gate.join('\n'));
      console.error('nothing re-stamped');
      process.exit(1);
    }
    const layers = {};
    for (const [layer, digest] of Object.entries(digests)) {
      const prev = release.layers?.[layer] ?? {};
      const hookMajors = Object.fromEntries(Object.keys(hooks[layer] ?? {}).sort().map((h) => [h, prev.hooks?.[h] ?? 1]));
      const buying = buyingLayerOf(layer);
      layers[layer] = {
        role: roleOf(layer),
        version: prev.version ?? defaultVersion(layer, release),
        ...(buying ? { depends_on: BUYING_DIRECT_DEPS[buying].map((l) => `buying/${l}`) } : {}),
        ...(Object.keys(hookMajors).length ? { hooks: hookMajors } : {}),
        ...(prev.contributors ? { contributors: prev.contributors } : {}),
        digest,
      };
    }
    writeFileSync(releaseFile, JSON.stringify({ ...release, layers, bundle_digest: bundle }, null, 2) + '\n');
    writeBaseline({ ...release, layers });
    for (const [layer, l] of Object.entries(layers)) console.log(`frozen ${layer.padEnd(26)} ${l.role.padEnd(8)} ${l.version.padEnd(5)} ${l.digest.slice(0, 19)}...`);
    console.log(`core ${release.adcp_version} frozen: bundle ${bundle}`);
  } else {
    if (release.bundle_digest !== bundle) problems.push(`CORE MOVED: bundle hashes to ${bundle}, core/release.json says ${release.bundle_digest}`);
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    const n = Object.keys(digests).length;
    console.log(`core bundle: ${ids.length} schemas in ${n} layers, ${bundle.slice(0, 19)}... (every layer unchanged since the ${release.adcp_version} freeze)`);
  }
}
