#!/usr/bin/env node
// packages/<ext>/{extension.json, schema.json, spec.md, conformance/*.yaml}
//   -> packages/<ext>/dist/bundle.json     (JCS bytes; this is what is served at the uri)
//   -> packages/<ext>/extension.lock.json  ({uri, version, digest})
//   -> registry/<host>/<path>/<hex>.json   (simulated hosting, addressed by uri@digest)
//   -> registry/<host>/<path>/<hex>/...    (the spec, storyboards, and reference code that digest pins)
//   -> registry/<host>/<path>/index.json   (version -> digest; metadata outside any digest)
//
// The manifest gains `docs: {spec: {path, sha256}, conformance: [{path, sha256}],
// reference_code: {path, sha256}}` before the digest is computed, so the digest pins the exact
// rules and the exact reference code (index.mjs) as well as the fields: editing the prose or
// the code is a new digest, and the registry refuses it under an unchanged version. The build
// also lints the spec: every MUST or SHOULD sits in a rule with an id, every x-adcp-validation
// constraint is cited by a rule, and every rule id a storyboard cites exists.
//
// The build also fills in requires.core_types from the bundle's core $refs and
// refuses an extension that is not compatible with the pinned core release.
// Published versions are immutable: rebuilding a version with different bytes fails.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jcs, sha256Digest } from '../lib/digest.mjs';
import { CORE_ORIGIN, coreIdFromUri } from '../lib/core-schemas.mjs';
import { checkCompat, compareVersions, typeMajor } from '../lib/compat.mjs';
import { annotatedHooks } from './build-core.mjs';
import { docFiles, docsManifest, lintSpec, parseSpec, parseStoryboard, referenceCodeFile } from '../lib/extension-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = path.join(ROOT, 'packages');
const REGISTRY = path.join(ROOT, 'registry');

export function extensionPackages() {
  return readdirSync(PACKAGES)
    .map((d) => path.join(PACKAGES, d))
    .filter((d) => existsSync(path.join(d, 'extension.json')));
}

function* refsOf(node, at = '') {
  if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* refsOf(v, `${at}/${i}`);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref') yield { ref: v, at };
      else yield* refsOf(v, `${at}/${k}`);
    }
}

/**
 * The sandbox rule this example proposes for extension bundles:
 *   - intra-document refs (#/definitions/...) must resolve;
 *   - core refs use https://adcontextprotocol.org + the core $id and must name
 *     a schema in the buyer's pinned core bundle (resolved locally, never fetched);
 *   - anything else is rejected (no cross-origin fetches from a bundle).
 */
export function lintExtensionRefs(schema, coreIds) {
  const problems = [];
  for (const { ref, at } of refsOf(schema)) {
    if (ref.startsWith('#/definitions/')) {
      if (!schema.definitions?.[ref.slice('#/definitions/'.length)]) problems.push(`${at}: dangling ${ref}`);
    } else if (ref.startsWith(CORE_ORIGIN + '/schemas/')) {
      if (!coreIds.has(coreIdFromUri(ref))) problems.push(`${at}: ${ref} is not in the pinned core bundle`);
    } else {
      problems.push(`${at}: ${ref} is neither intra-document nor core`);
    }
  }
  return problems;
}

export const coreRelease = () => JSON.parse(readFileSync(path.join(ROOT, 'core/release.json'), 'utf8'));

/** Core types a schema $refs, with their major in the given core release. */
export function coreTypesOf(schema, release) {
  const ids = [...refsOf(schema)].filter(({ ref }) => ref.startsWith(CORE_ORIGIN + '/schemas/')).map(({ ref }) => coreIdFromUri(ref));
  return Object.fromEntries([...new Set(ids)].sort().map((id) => [id, typeMajor(release, id)]));
}

/** The hooks core declares, by name: { kind: 'extension-point' | 'union', value } (from the annotations, not from a list). */
export const coreHooks = () => Object.fromEntries(annotatedHooks().map((h) => [h.name, h]));

export function buildBundle(dir, release = coreRelease(), hooks = coreHooks()) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'extension.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(path.join(dir, 'schema.json'), 'utf8'));
  for (const e of manifest.extends) {
    const at = `${manifest.name}: extends ${e.point}${e.branch ? `#${e.branch}` : ''}`;
    if (!schema.definitions?.[e.definition]) throw new Error(`${at} -> missing definition ${e.definition}`);
    if (e.response !== undefined && !schema.definitions?.[e.response]) throw new Error(`${at} -> missing response definition ${e.response}`);
    if (manifest.requires?.points?.[e.point] === undefined) throw new Error(`${at} but requires.points does not name it`);
    const hook = hooks[e.point];
    if (!hook) throw new Error(`${at}: core declares no such hook`);
    if (Boolean(e.branch) !== (hook.kind === 'union')) throw new Error(`${at}: ${e.point} is ${hook.kind === 'union' ? 'an open union; register a branch' : 'an extension point; it takes no branch'}`);
    // The union's owner sets what a branch registration must say (for pricing_model: reports_as;
    // for the kernel's task union: response, the definition that types the task's response).
    for (const key of hook.value.branch_requires ?? []) if (e[key] === undefined) throw new Error(`${at}: the ${e.point} union requires ${key}`);
  }
  // The rules: spec.md and the storyboards, linted against the schema and each other.
  const files = docFiles(dir);
  const spec = parseSpec(files[0].bytes.toString('utf8'));
  const storyboards = files.slice(1).map((f) => ({ file: f.path, doc: parseStoryboard(f.bytes, f.path) }));
  for (const { file, doc } of storyboards) {
    if (doc.extension !== manifest.name) throw new Error(`${manifest.name}: ${file} is a storyboard for ${doc.extension}`);
  }
  const problems = lintSpec(spec, { schema, storyboards, name: `${manifest.name}/spec.md` });
  if (problems.length) throw new Error(`${manifest.name}: spec lint failed\n  ${problems.join('\n  ')}`);

  // One document: a valid JSON Schema (fetch contract) whose manifest is covered by the digest.
  // requires.core_types is computed, so the digest also pins which core schemas it was built against;
  // docs is computed, so it also pins the exact spec, conformance suite, and reference code.
  const code = referenceCodeFile(dir);
  const { id, ...meta } = manifest;
  meta.requires = { ...meta.requires, core_types: coreTypesOf(schema, release) };
  meta.docs = docsManifest(files, code);
  const bundle = { ...schema, $id: id, 'x-adcp-extension': meta };
  const bytes = Buffer.from(jcs(bundle), 'utf8');
  return { manifest, bundle, bytes, digest: sha256Digest(bytes), docs: [...files, code] };
}

export function registryPath(uri, digest, registry = REGISTRY) {
  const u = new URL(uri);
  return path.join(registry, u.host, u.pathname, `${digest.slice('sha256:'.length)}.json`);
}

/** Where the registry keeps the documents a digest pins: next to the bundle, keyed by the same digest. */
export const registryDocsDir = (uri, digest, registry = REGISTRY) => registryPath(uri, digest, registry).replace(/\.json$/, '');

/** Publish a bundle and the documents and code it pins. */
export function publish({ manifest, bytes, digest, docs }, registry = REGISTRY) {
  const target = registryPath(manifest.id, digest, registry);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  const docsDir = registryDocsDir(manifest.id, digest, registry);
  for (const f of docs) {
    mkdirSync(path.dirname(path.join(docsDir, f.path)), { recursive: true });
    writeFileSync(path.join(docsDir, f.path), f.bytes);
  }
  return target;
}

/** Rebuild <host>/<path>/index.json from the bundles present; a version maps to exactly one digest. */
export function writeRegistryIndex(uri, registry = REGISTRY) {
  const dir = path.dirname(registryPath(uri, 'sha256:x', registry));
  const versions = {};
  for (const f of readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
    const meta = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))['x-adcp-extension'];
    const digest = 'sha256:' + f.slice(0, 64);
    if (versions[meta.version] && versions[meta.version].digest !== digest) {
      throw new Error(`${uri}: version ${meta.version} already published with ${versions[meta.version].digest}; bump the version`);
    }
    versions[meta.version] = { digest, requires: meta.requires };
  }
  const sorted = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => compareVersions(a, b)));
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ uri, versions: sorted }, null, 2) + '\n');
  return sorted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const coreIds = new Set(JSON.parse(readFileSync(path.join(ROOT, 'core/schemas-index.json'), 'utf8')));
  const release = coreRelease();
  if (process.argv.includes('--clean-registry')) rmSync(REGISTRY, { recursive: true, force: true });
  let failed = false;
  for (const dir of extensionPackages()) {
    let built;
    try {
      built = buildBundle(dir, release);
    } catch (e) {
      failed = true;
      console.error(e.message);
      continue;
    }
    const { manifest, bundle, bytes, digest } = built;
    const problems = lintExtensionRefs(bundle, coreIds);
    if (problems.length) {
      failed = true;
      console.error(`${manifest.name}: ref lint failed\n  ${problems.join('\n  ')}`);
      continue;
    }
    const compat = checkCompat(bundle['x-adcp-extension'], release);
    if (!compat.ok) {
      failed = true;
      console.error(`${manifest.name}: not compatible with core ${release.adcp_version}\n  ${compat.reasons.join('\n  ')}`);
      continue;
    }
    // Published versions are immutable: changed bytes (schema, manifest, spec, or storyboards) need a new version.
    const indexFile = path.join(path.dirname(registryPath(manifest.id, digest)), 'index.json');
    const published = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).versions[manifest.version] : null;
    if (published && published.digest !== digest) {
      failed = true;
      console.error(`${manifest.name}: version ${manifest.version} already published with ${published.digest}; these bytes hash to ${digest}. Bump the version.`);
      continue;
    }
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist/bundle.json'), bytes);
    writeFileSync(
      path.join(dir, 'extension.lock.json'),
      JSON.stringify({ uri: manifest.id, version: manifest.version, digest }, null, 2) + '\n'
    );
    publish(built);
    writeRegistryIndex(manifest.id);
    const { docs } = bundle['x-adcp-extension'];
    console.log(`${manifest.name.padEnd(24)} ${manifest.version.padEnd(6)} ${manifest.id}@${digest.slice(0, 19)}...  spec + ${docs.conformance.length} storyboard(s) + ${docs.reference_code.path}`);
  }
  if (failed) process.exit(1);
}
