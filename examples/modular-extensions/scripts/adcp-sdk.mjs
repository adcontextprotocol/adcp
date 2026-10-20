#!/usr/bin/env node
// "Give me this app's typed AdCP layer = core + these extensions": the generated binding.
//
//   node scripts/adcp-sdk.mjs <appDir> [--core <version>] [--check]
//
// Reads <appDir>/adcp.config.json:
//   { "core": "3.3.0",
//     "modules": ["governance"],                  (optional)
//     "extensions": { "<attribute>": "<extension uri>@<version range | sha256:digest>" } }
//
// `modules` names the standard modules and buying layers the app uses (`buying` is every buying layer).
// With it, the lock pins the kernel layer and those modules, one { version, digest } each, and the layer
// covers only the messages those modules own, so a release of any other module changes nothing in the
// app. Without it, the lock pins the whole core bundle.
//
// Each key is the attribute the app reads and writes (snake_case): proposal.commercial_terms.<attribute>.
// Two keys may name two versions of one uri; each version is its own attribute, keyed by uri@digest.
// For each extension it:
//   1. reads the registry index for the uri (version -> digest, requires),
//   2. picks the highest version in range that is compatible with the chosen core
//      (lib/compat.mjs), and says why it skipped the others,
//   3. fetches the bundle and verifies its digest,
//   4. uses an installed package that claims that exact uri@digest (it has the extension
//      author's check code, which the client loader verifies against the digest's
//      docs.reference_code before running it), or else generates a schema-only module into
//      <appDir>/adcp-sdk/ext/<attribute>/ (lock: code "schema-only"; the loader accepts only the
//      SDK's fixed stub there).
// Then it writes <appDir>/adcp.lock.json (what the runtime loads) and the app's typed layer,
// <appDir>/adcp-sdk/ (scripts/generated-binding.mjs): bindings.ts, types.ts, index.ts, bundles/,
// GENERATED.json. The core package and the SDK are never written.
//
// --check writes nothing and exits 1 when the layer or the lock is stale against the config (the CI gate).
// With --core <version> other than the installed core it only resolves (a dry run): it shows what
// would and would not be compatible with that core.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompat, compareVersions, satisfies } from '../lib/compat.mjs';
import { refKey, sha256Digest } from '../lib/digest.mjs';
import { SCHEMA_ONLY_CHECK } from '../lib/buyer-validator.mjs';
import { coreBundleDigest } from './build-core.mjs';
import { modulePins } from '../lib/modules.mjs';
import { extensionPackages, registryPath } from './build-extensions.mjs';
import { coreTypeNameFromCore, generateExtensionTs, hookInfo } from './codegen-lib.mjs';
import { generateBinding } from './generated-binding.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function coreReleases() {
  const installed = readJson(path.join(ROOT, 'core/release.json'));
  const dir = path.join(ROOT, 'compat/core-releases');
  const simulated = readdirSync(dir).map((f) => ({ ...readJson(path.join(dir, f)), simulated: true }));
  return [{ ...installed, installed: true }, ...simulated.filter((r) => r.adcp_version !== installed.adcp_version)];
}

/** "https://host/path@^1.1" -> { uri, range } ; "...@sha256:<hex>" -> { uri, digest } */
export function parseSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at < 'https://'.length) return { uri: spec, range: '*' };
  const uri = spec.slice(0, at);
  const pin = spec.slice(at + 1);
  return pin.startsWith('sha256:') ? { uri, digest: pin } : { uri, range: pin };
}

/** Resolve one extension spec against a core release. */
export function resolveExtension(spec, release) {
  const { uri, range, digest } = parseSpec(spec);
  const indexFile = path.join(path.dirname(registryPath(uri, 'sha256:x')), 'index.json');
  if (!existsSync(indexFile)) return { uri, ok: false, reasons: [`${uri}: not found in the registry`] };
  const { versions } = readJson(indexFile);
  const candidates = Object.entries(versions)
    .filter(([v, meta]) => (digest ? meta.digest === digest : range === '*' || satisfies(v, range)))
    .sort(([a], [b]) => compareVersions(b, a));
  const skipped = [];
  for (const [version, meta] of candidates) {
    const compat = checkCompat({ requires: meta.requires }, release);
    if (compat.ok) return { uri, version, digest: meta.digest, ok: true, skipped };
    skipped.push({ version, reasons: compat.reasons });
  }
  const wanted = digest ? `digest ${digest.slice(0, 19)}...` : `range ${range}`;
  return { uri, ok: false, skipped, reasons: [`no version of ${uri} in ${wanted} is compatible with core ${release.adcp_version}`] };
}

/** An installed package (here: packages/*, in an app: node_modules) that ships exactly uri@digest. */
function installedPackage(uri, digest) {
  for (const dir of extensionPackages()) {
    const lock = readJson(path.join(dir, 'extension.lock.json'));
    if (lock.uri === uri && lock.digest === digest) return { dir, name: readJson(path.join(dir, 'package.json')).name };
  }
  return null;
}

/** Every file under dir, relative to base, with its bytes. */
function filesUnder(dir, base) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) for (const [k, v] of filesUnder(full, base)) out.set(k, v);
    else out.set(path.relative(base, full).split(path.sep).join('/'), readFileSync(full));
  }
  return out;
}

export async function buildSdk(appDir, { coreVersion, check = false } = {}) {
  const config = readJson(path.join(appDir, 'adcp.config.json'));
  const want = coreVersion ?? config.core;
  const release = coreReleases().find((r) => r.adcp_version === want);
  if (!release) throw new Error(`core ${want} is not a known core release`);

  const resolved = Object.entries(config.extensions ?? {}).map(([alias, spec]) => ({ alias, spec, ...resolveExtension(spec, release) }));
  const failed = resolved.filter((r) => !r.ok);
  if (!release.installed || failed.length) return { release, resolved, written: false, modules: config.modules };

  const sdkDir = path.join(appDir, 'adcp-sdk');
  const hooks = hookInfo();
  const files = new Map(); // path relative to appDir -> bytes
  const core = config.modules
    ? { version: release.adcp_version, modules: modulePins(config.modules, release) }
    : { version: release.adcp_version, bundle_digest: coreBundleDigest() };
  const lock = { core, extensions: {} };

  for (const r of resolved) {
    const bytes = readFileSync(registryPath(r.uri, r.digest));
    if (sha256Digest(bytes) !== r.digest) throw new Error(`${r.uri}@${r.version}: registry bytes do not match ${r.digest}`);
    r.bytes = bytes;
    const pkg = installedPackage(r.uri, r.digest);
    let moduleDir;
    let source;
    if (pkg) {
      moduleDir = pkg.dir;
      source = `package ${pkg.name}`;
    } else {
      moduleDir = path.join(sdkDir, 'ext', r.alias);
      source = 'registry (schema-only)';
      const extLock = { uri: r.uri, version: r.version, digest: r.digest, code: 'schema-only' };
      const ext = (f) => path.relative(appDir, path.join(moduleDir, f)).split(path.sep).join('/');
      files.set(ext('dist/bundle.json'), bytes);
      files.set(ext('extension.lock.json'), JSON.stringify(extLock, null, 2) + '\n');
      files.set(ext('index.mjs'), SCHEMA_ONLY_CHECK);
      const ts = await generateExtensionTs({
        bundle: JSON.parse(bytes),
        lock: extLock,
        coreTypeName: coreTypeNameFromCore(),
        hooks,
        coreImport: path.relative(path.join(moduleDir, 'src'), path.join(ROOT, 'packages/core/src/index.ts')).split(path.sep).join('/'),
      });
      files.set(ext('src/index.ts'), ts);
    }
    r.typesFile = path.join(moduleDir, 'src/index.ts');
    lock.extensions[r.alias] = { uri: r.uri, version: r.version, digest: r.digest, source, module: path.relative(appDir, moduleDir).split(path.sep).join('/') };
  }
  const layer = generateBinding({ appDir, release, core, resolved, hooks });
  for (const [name, data] of layer) files.set(`adcp-sdk/${name}`, data);
  files.set('adcp.lock.json', JSON.stringify(lock, null, 2) + '\n');

  const want_ = new Map([...files].map(([k, v]) => [k, Buffer.from(v)]));
  const current = filesUnder(sdkDir, appDir);
  if (existsSync(path.join(appDir, 'adcp.lock.json'))) current.set('adcp.lock.json', readFileSync(path.join(appDir, 'adcp.lock.json')));
  const stale = [...new Set([...want_.keys(), ...current.keys()])].sort().filter((k) => !want_.has(k) || !current.has(k) || !want_.get(k).equals(current.get(k)));
  const layerFiles = [...layer.keys()];
  if (check) return { release, resolved, lock, written: false, checked: true, stale, layerFiles, modules: config.modules };
  for (const k of current.keys()) if (!want_.has(k)) rmSync(path.join(appDir, k));
  for (const [k, data] of want_) {
    if (current.get(k)?.equals(data)) continue;
    mkdirSync(path.dirname(path.join(appDir, k)), { recursive: true });
    writeFileSync(path.join(appDir, k), data);
  }
  return { release, resolved, lock, written: true, stale, layerFiles, modules: config.modules };
}

export function printResult({ release, resolved, lock, written, checked, stale = [], layerFiles = [] }, log = console.log) {
  const tag = release.installed ? 'installed' : 'simulated';
  log(`core ${release.adcp_version} (${tag})`);
  for (const [layer, pin] of Object.entries(lock?.core.modules ?? {})) log(`  module ${layer.padEnd(22)} ${pin.version.padEnd(5)} ${pin.digest.slice(0, 19)}...`);
  const w = Math.max(22, ...resolved.map((r) => r.alias.length)) + 1;
  for (const r of resolved) {
    if (r.ok) log(`  ${r.alias.padEnd(w)} ${r.uri.replace('https://', '')}@${r.version}  ${r.digest.slice(0, 19)}...`);
    else log(`  ${r.alias.padEnd(w)} NOT COMPATIBLE: ${r.reasons.join('; ')}`);
    for (const s of r.skipped ?? []) log(`  ${''.padEnd(w)} skipped ${s.version}: ${s.reasons.join('; ')}`);
  }
  if (checked) {
    if (stale.length) log(`  STALE against adcp.config.json; run npm run sdk:\n${stale.map((k) => `    ${k}`).join('\n')}`);
    else log('  -> adcp.lock.json and adcp-sdk/ are up to date');
  } else if (written) log(`  -> wrote adcp.lock.json and adcp-sdk/ (${layerFiles.filter((f) => !f.startsWith('bundles/')).join(', ')}, bundles/)`);
  else if (!release.installed) log('  (dry run: this core is not installed)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appDir = path.resolve(process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--core') ?? 'examples/buyer-app');
  const i = process.argv.indexOf('--core');
  const result = await buildSdk(appDir, { coreVersion: i > 0 ? process.argv[i + 1] : undefined, check: process.argv.includes('--check') });
  printResult(result);
  if (result.resolved.some((r) => !r.ok) || (result.checked && result.stale.length)) process.exitCode = 1;
}

export { refKey };
