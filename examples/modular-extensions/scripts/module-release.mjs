#!/usr/bin/env node
// A module minor release, run for real on a scratch copy of this example:
//
//   node scripts/module-release.mjs [core/releases/buying-pricing-1.1.json]      (npm run release:pricing)
//
// The release file names one layer, its old and new version, and the patches the release makes. On the
// scratch copy, the script:
//   1. adds the patches to the layer's group in core/patches.json (the build refuses a patch on a file
//      another layer owns) and runs the core build, which fails with LAYER MOVED for every layer whose
//      files changed: the release must move its own layer and nothing else;
//   2. runs the additive check (lib/additive.mjs) over every file the layer owns, before and after;
//   3. sets the layer's new version and re-stamps the release (build-core.mjs --freeze), then builds again;
//   4. compares core/release.json before and after: one layer moved, every other layer is identical;
//   5. rebuilds every extension against the new release: the same digests, all still compatible;
//   6. regenerates two apps: the governance-only app (it pins the kernel layer and governance) keeps a
//      byte-identical lock and generated layer; the buyer app (it pins the whole bundle) sees the bundle move;
//   7. shows the creator network's modules map at the new release, checked against both apps.
// Then it runs the release's `refused` patches on a second scratch copy: the additive check refuses
// them; the core build's own gate (build-core.mjs --freeze) refuses the re-stamp too, and nothing is
// re-stamped. The example itself never changes. Exit 1 unless the release passes
// and the refused edit is refused.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { additiveLayerDiff } from '../lib/additive.mjs';
import { checkCompat } from '../lib/compat.mjs';
import { checkModules, expectedModules, modulesMap } from '../lib/modules.mjs';
import { CREATOR_NETWORK_MODULES } from '../lib/mock-seller.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const short = (d) => `${d.slice(0, 19)}…`;
const APPS = ['test/apps/governance-only', 'examples/buyer-app'];

/** A scratch copy of this example: everything but node_modules (symlinked) and the generated docs site. */
function scratchCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-release-'));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[/\\](node_modules|docs-site)([/\\]|$)/.test(path.relative(ROOT, src) ? `/${path.relative(ROOT, src)}` : '') });
  if (existsSync(path.join(ROOT, 'node_modules'))) symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

const node = (cwd, ...args) => {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};

/** The schemas a layer owns: Map(file -> schema), from a core/schemas tree and its placement. */
function layerFiles(dir, layer) {
  const owner = readJson(path.join(dir, 'core/placement.json')).layers;
  for (const l of readJson(path.join(dir, 'core/patches.json')).layers) for (const p of l.patches) if (p.op === 'create') owner[p.file] = l.layer;
  return new Map(Object.entries(owner).filter(([, l]) => l === layer).map(([f]) => [f, readJson(path.join(dir, 'core/schemas', f))]).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Every file under dir, relative to base, with its bytes. */
function filesUnder(dir, base = dir, out = new Map()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, base, out);
    else out.set(path.relative(base, full).split(path.sep).join('/'), readFileSync(full));
  }
  return out;
}

function changedFiles(a, b) {
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => !a.has(k) || !b.has(k) || !a.get(k).equals(b.get(k)));
}

/** Apply a list of patches to the layer's group of core/patches.json in dir. */
function addPatches(dir, layer, patches) {
  const file = path.join(dir, 'core/patches.json');
  const doc = readJson(file);
  let group = doc.layers.find((l) => l.layer === layer);
  if (!group) doc.layers.push((group = { layer, patches: [] }));
  group.patches.push(...structuredClone(patches));
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

/** LAYER MOVED lines -> layer names. */
const movedLayers = (out) => [...out.matchAll(/^LAYER MOVED: (\S+)/gm)].map((m) => m[1]);

/**
 * Run one release (or its refused patches) on a scratch copy.
 * @returns a structured result and the log lines the CLI prints
 */
export function runRelease(specFile = path.join(ROOT, 'core/releases/buying-pricing-1.1.json'), { refused = false, keep = false } = {}) {
  const spec = readJson(specFile);
  const patches = refused ? spec.refused : spec.patches;
  const log = [];
  const dir = scratchCopy();
  try {
    const before = {
      release: readJson(path.join(dir, 'core/release.json')),
      files: layerFiles(dir, spec.layer),
      locks: Object.fromEntries(readdirSync(path.join(dir, 'packages')).filter((p) => existsSync(path.join(dir, 'packages', p, 'extension.lock.json'))).map((p) => [p, readJson(path.join(dir, 'packages', p, 'extension.lock.json'))])),
      apps: Object.fromEntries(APPS.map((a) => [a, filesUnder(path.join(dir, a))])),
    };
    if (before.release.layers[spec.layer]?.version !== spec.from) throw new Error(`${spec.layer} is ${before.release.layers[spec.layer]?.version}, the release starts from ${spec.from}`);
    log.push(`release ${spec.layer} ${spec.from} -> ${spec.to}${refused ? ' (refused edit)' : ''}: ${patches.length} patch${patches.length === 1 ? '' : 'es'}`);
    for (const p of patches) log.push(`  ${p.op} ${p.file}#${p.pointer}${p.op === 'append' ? ` ${JSON.stringify(p.value)}` : ''}`);

    // 1. Build with the patches and the old stamps: which layers moved?
    addPatches(dir, spec.layer, patches);
    const build = node(dir, 'scripts/build-core.mjs');
    if (/belongs to layer/.test(build.out)) throw new Error(build.out.split('\n').find((l) => /belongs to layer/.test(l)));
    const moved = movedLayers(build.out);
    log.push('build with the old stamps:');
    for (const l of build.out.split('\n').filter((x) => /^(LAYER|CORE) MOVED/.test(x))) log.push(`  ${l.replace(/(sha256:[0-9a-f]{12})[0-9a-f]{52}/g, '$1…')}`);

    // 2. The additive check over the layer's files.
    const after = layerFiles(dir, spec.layer);
    const diff = additiveLayerDiff(before.files, after);
    log.push(`additive check over the ${after.size} files ${spec.layer} owns: ${diff.additive ? 'pass' : 'REFUSED'}`);
    for (const c of diff.changes) log.push(`  ${c.additive ? 'additive    ' : 'not additive'}  ${c.file}#${c.pointer}: ${c.change}${c.note ? ` (${c.note})` : ''}`);
    const result = { spec, refused, moved, additive: diff, log };
    if (!diff.additive || moved.length !== 1 || moved[0] !== spec.layer) {
      if (moved.length !== 1 || moved[0] !== spec.layer) log.push(`REFUSED: the release must move ${spec.layer} alone; it moved ${moved.join(', ') || 'nothing'}`);
      else log.push(`REFUSED: ${spec.layer} ${spec.to} is not additive; a change like this needs ${spec.layer} ${Number(spec.from.split('.')[0]) + 1}.0, served beside ${spec.from.split('.')[0]}.x`);
      // The core build applies the same gate to any re-stamp, so a release that skips this script is refused too.
      const releaseFile = path.join(dir, 'core/release.json');
      const rel = readJson(releaseFile);
      rel.layers[spec.layer].version = spec.to;
      writeFileSync(releaseFile, JSON.stringify(rel, null, 2) + '\n');
      const gate = node(dir, 'scripts/build-core.mjs', '--freeze');
      log.push(`re-stamp anyway (build-core.mjs --freeze, ${spec.layer} ${spec.to}): ${gate.status === 0 ? 'ACCEPTED' : 'refused by the core build'}`);
      for (const l of gate.out.split('\n').filter((x) => /^(NOT ADDITIVE|RELEASED PATCH CHANGED|nothing re-stamped)/.test(x))) log.push(`  ${l}`);
      return { ...result, released: false, gateRefused: gate.status !== 0 };
    }

    // 3. Stamp the new version and re-freeze; then the plain build must pass.
    const releaseFile = path.join(dir, 'core/release.json');
    const rel = readJson(releaseFile);
    rel.layers[spec.layer].version = spec.to;
    writeFileSync(releaseFile, JSON.stringify(rel, null, 2) + '\n');
    const freeze = node(dir, 'scripts/build-core.mjs', '--freeze');
    const check = node(dir, 'scripts/build-core.mjs');
    if (freeze.status !== 0 || check.status !== 0) throw new Error(`re-stamp failed:\n${freeze.out}\n${check.out}`);
    const next = readJson(releaseFile);

    // 4. The release, layer by layer.
    const layers = Object.keys(before.release.layers).sort();
    const changed = layers.filter((l) => JSON.stringify(before.release.layers[l]) !== JSON.stringify(next.layers[l]));
    log.push(`core/release.json after the re-stamp: ${changed.length} of ${layers.length} layers changed`);
    for (const l of layers) {
      const a = before.release.layers[l];
      const b = next.layers[l];
      if (changed.includes(l)) log.push(`  ${l.padEnd(24)} ${a.version.padEnd(4)} ${short(a.digest)}  ->  ${b.version.padEnd(4)} ${short(b.digest)}`);
    }
    for (const l of ['core', 'kernel-types', 'governance', 'buying/commitment']) {
      const a = before.release.layers[l];
      log.push(`  ${l.padEnd(24)} ${a.version.padEnd(4)} ${short(a.digest)}  =  unchanged`);
    }
    log.push(`  … ${layers.length - changed.length - 4} more layers unchanged`);
    log.push(`  bundle_digest            ${short(before.release.bundle_digest)}  ->  ${short(next.bundle_digest)}  (it hashes every layer)`);

    // 5. Extensions: rebuild against the new release.
    const ext = node(dir, 'scripts/build-extensions.mjs');
    if (ext.status !== 0) throw new Error(`extensions no longer build:\n${ext.out}`);
    const locks = Object.fromEntries(Object.keys(before.locks).map((p) => [p, readJson(path.join(dir, 'packages', p, 'extension.lock.json'))]));
    const extensions = Object.keys(before.locks).sort().map((p) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'packages', p, 'dist/bundle.json')))['x-adcp-extension'];
      return { name: manifest.name, version: locks[p].version, digest: locks[p].digest, same: locks[p].digest === before.locks[p].digest, compatible: checkCompat(manifest, next).ok };
    });
    log.push(`extensions rebuilt against the new release: ${extensions.filter((e) => e.same).length} of ${extensions.length} digests identical, ${extensions.filter((e) => e.compatible).length} of ${extensions.length} compatible`);
    for (const e of extensions) log.push(`  ${e.name.padEnd(24)} ${e.version}  ${short(e.digest)}  ${e.same ? 'same digest' : 'DIGEST MOVED'}, ${e.compatible ? 'compatible' : 'NOT COMPATIBLE'}`);

    // 6. Apps: regenerate and compare.
    const apps = {};
    log.push('apps regenerated (npm run sdk):');
    for (const a of APPS) {
      const sdk = node(dir, 'scripts/adcp-sdk.mjs', a);
      if (sdk.status !== 0) throw new Error(`${a}: ${sdk.out}`);
      const files = changedFiles(before.apps[a], filesUnder(path.join(dir, a)));
      const lock = readJson(path.join(dir, a, 'adcp.lock.json'));
      apps[a] = { changed: files, pins: lock.core.modules ? Object.keys(lock.core.modules) : 'bundle' };
      const pins = lock.core.modules ? `pins ${Object.keys(lock.core.modules).join(', ')}` : 'pins the whole bundle';
      log.push(`  ${a.padEnd(26)} ${pins}: ${files.length ? `${files.length} files changed (${files.join(', ')})` : 'adcp.lock.json and adcp-sdk/ byte-identical'}`);
    }

    // 7. The creator network's modules map at the new release, checked against both apps.
    const map = modulesMap(CREATOR_NETWORK_MODULES, next);
    log.push(`creator network capabilities at the new release: modules["${spec.layer}"] = ${JSON.stringify({ version: map[spec.layer].version, digest: short(map[spec.layer].digest) })}`);
    const checks = {};
    for (const a of APPS) {
      const lock = readJson(path.join(ROOT, a, 'adcp.lock.json')); // the app as shipped, built for the old release
      const c = checkModules(map, expectedModules(lock, before.release));
      checks[a] = c;
      const e = c.entries.find((x) => x.name === spec.layer);
      log.push(`  ${a.padEnd(26)} ${spec.layer}: ${e.status}${e.app ? ` (app ${e.app}, seller ${e.seller})` : ''}; ok: ${c.ok}`);
    }
    return { ...result, released: true, changed, before: before.release, after: next, extensions, apps, checks };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const specFile = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'core/releases/buying-pricing-1.1.json'));
  const release = runRelease(specFile);
  console.log(release.log.join('\n'));
  console.log('');
  const refused = runRelease(specFile, { refused: true });
  console.log(refused.log.join('\n'));
  const ok = release.released && !refused.released;
  console.log(`\n${ok ? 'ok' : 'FAILED'}: the release ${release.released ? 'shipped' : 'did not ship'}; the refused edit ${refused.released ? 'SHIPPED' : 'was refused'}`);
  if (!ok) process.exitCode = 1;
}
