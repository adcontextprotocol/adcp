// Module and layer versions on the wire: the optional `modules` map that an agent puts in
// get_adcp_capabilities (proposed for 3.4, in the kernel's fragment of the generated capabilities
// response; see core/patches.json, layer `_assembly`), and the buyer's check of that map against its lock.
//
//   "modules": { "buying/pricing": { "version": "1.0", "digest": "sha256:…" }, "governance": { … } }
//
// One entry per standard module and per buying layer the agent implements. A module the agent doesn't
// implement is absent: a seller that doesn't negotiate proposals leaves buying/offer out. The kernel's
// version stays where it is (adcp.supported_versions), and extensions stay in declared_extensions.
//
// The buyer's expectation comes from its lock (scripts/adcp-sdk.mjs): an app that names its modules in
// adcp.config.json pins the kernel layer and those modules, one { version, digest } each; an app that
// names none pins the whole bundle, so it expects every module at the version of that bundle.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KERNEL, KERNEL_TYPES, OPT_IN_LAYERS } from './layout.mjs';
import { loadCoreSchemas } from './core-schemas.mjs';
import { placement } from '../scripts/build-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The installed core release (core/release.json). */
export const installedRelease = () => JSON.parse(readFileSync(path.join(ROOT, 'core/release.json'), 'utf8'));

/** Layers that are modules or buying layers: not the kernel layer, an assembly, or a bridge extension's files. */
const isModuleLayer = (layer, entry) => entry.role === 'module' || entry.role === 'module-layer';

/** The standard modules and buying layers of a release, sorted. */
export function moduleLayers(release = installedRelease()) {
  return Object.entries(release.layers).filter(([l, e]) => isModuleLayer(l, e)).map(([l]) => l).sort();
}

/** Expand module names: `buying` is every buying/<layer> of the release; a layer or module name stays as is. */
export function expandModules(names, release = installedRelease()) {
  const out = new Set();
  for (const n of names) {
    const layers = n.includes('/') ? [n] : Object.keys(release.layers).filter((l) => l === n || l.startsWith(`${n}/`));
    if (!layers.length) throw new Error(`module ${n} is not in core ${release.adcp_version}`);
    for (const l of layers) {
      if (!isModuleLayer(l, release.layers[l])) throw new Error(`${l} is a ${release.layers[l].role} layer, not a module or a buying layer`);
      out.add(l);
    }
  }
  return [...out].sort();
}

const entry = (release, layer) => ({ version: release.layers[layer].version, digest: release.layers[layer].digest });

/** The `modules` map an agent emits for the modules and buying layers it implements: name -> { version, digest }. */
export function modulesMap(names, release = installedRelease()) {
  return Object.fromEntries(expandModules(names, release).map((l) => [l, entry(release, l)]));
}

/** What an app's lock pins when it names its modules: the kernel layer (core, kernel types) and those modules. */
export function modulePins(names, release = installedRelease()) {
  return Object.fromEntries([KERNEL, KERNEL_TYPES, ...expandModules(names, release)].map((l) => [l, entry(release, l)]));
}

/**
 * What the app expects of each module, from its lock: the module pins, or, for a lock that pins the whole
 * bundle, every module of the release that bundle is (the client checked the bundle digest already).
 */
export function expectedModules(lock, release = installedRelease()) {
  if (lock?.core?.modules) {
    return Object.fromEntries(Object.entries(lock.core.modules).filter(([l]) => release.layers[l] && isModuleLayer(l, release.layers[l])));
  }
  return Object.fromEntries(moduleLayers(release).map((l) => [l, entry(release, l)]));
}

const major = (v) => String(v).split('.')[0];
const minor = (v) => Number(String(v).split('.')[1] ?? 0);

/**
 * Check a seller's `modules` map against what the app expects.
 * Per module the app expects:
 *   same              same version and digest
 *   seller-newer      same major, the seller is a minor ahead: additive; it omits fields the app's minor lacks
 *   seller-older      same major, the seller is a minor behind: the app sends nothing the seller's minor lacks
 *   not-offered       the seller doesn't list it, so the app can't call that module's tasks there
 *   MODULE_MAJOR_MISMATCH   another major: the app can't use the module with this seller
 *   MODULE_DIGEST_MISMATCH  the same version with another digest: one of the two isn't the published module
 * A module the seller lists and the app doesn't expect is reported as `not-used` and never fails.
 * @returns {{ ok: boolean, entries: { name, app, seller, status }[], errors: { code, name, message }[] }}
 */
export function checkModules(sellerMap, expected) {
  const entries = [];
  const errors = [];
  const short = (d) => (d ? `${d.slice(0, 19)}…` : d);
  for (const name of [...new Set([...Object.keys(expected), ...Object.keys(sellerMap ?? {})])].sort()) {
    const app = expected[name];
    const seller = sellerMap?.[name];
    let status;
    if (!app) status = 'not-used';
    else if (!seller) status = 'not-offered';
    else if (major(app.version) !== major(seller.version)) {
      status = 'MODULE_MAJOR_MISMATCH';
      errors.push({ code: status, name, message: `${name}: the seller implements ${seller.version}, this app was built for ${app.version}` });
    } else if (app.version === seller.version) {
      if (app.digest === seller.digest) status = 'same';
      else {
        status = 'MODULE_DIGEST_MISMATCH';
        errors.push({ code: status, name, message: `${name} ${app.version}: the seller's digest ${short(seller.digest)} is not this app's ${short(app.digest)}` });
      }
    } else status = minor(seller.version) > minor(app.version) ? 'seller-newer' : 'seller-older';
    entries.push({ name, app: app ? app.version : null, seller: seller ? seller.version : null, status });
  }
  return { ok: errors.length === 0, entries, errors };
}

/**
 * The schemas the client validates for each core task (lib/client.mjs): the request it sends, and the
 * response it reads.
 */
export const TASK_SCHEMAS = {
  get_products: ['/schemas/media-buy/get-products-request.json', '/schemas/core/product.json'],
  request_proposals: ['/schemas/media-buy/request-proposals-request.json', '/schemas/media-buy/request-proposals-response.json'],
  refine_proposals: ['/schemas/media-buy/refine-proposals-request.json', '/schemas/core/canonical-proposal.json'],
  accept_proposal: ['/schemas/media-buy/accept-proposal-request.json', '/schemas/core/canonical-proposal.json'],
  get_media_buys: ['/schemas/media-buy/get-media-buys-response.json'],
};

let taskModulesCache = null;
/**
 * The layers each core task needs on the seller's side: every buying layer whose schemas the task's
 * request or response reaches through $ref. The walk stops at an assembly and at a bridge extension's
 * files (a bridge is negotiated as an extension), and an opt-in layer (catalogs, offer) counts only when
 * the task itself belongs to it: a seller that sells from no catalog still serves request_proposals.
 * @returns {{ [task: string]: string[] }}
 */
export function taskModules() {
  if (taskModulesCache) return taskModulesCache;
  const owner = placement();
  const byId = new Map(loadCoreSchemas().map((x) => [x.id, x.schema]));
  const layerOf = (id) => owner[id.replace(/^\/schemas\//, '')];
  const reach = (root) => {
    const seen = new Set();
    const todo = [root];
    while (todo.length) {
      const id = todo.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const l = layerOf(id);
      if (id !== root && (l.startsWith('_') || l.startsWith('x-'))) continue;
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (typeof n.$ref === 'string' && !n.$ref.startsWith('#')) {
          const file = n.$ref.split('#')[0];
          const target = file.startsWith('/') ? file : new URL(file, `https://core${id}`).pathname;
          if (byId.has(target)) todo.push(target);
        }
        for (const v of Object.values(n)) walk(v);
      };
      walk(byId.get(id));
    }
    return seen;
  };
  taskModulesCache = Object.fromEntries(
    Object.entries(TASK_SCHEMAS).map(([task, roots]) => {
      const own = new Set(roots.map(layerOf));
      const layers = new Set();
      for (const r of roots) for (const id of reach(r)) {
        const l = layerOf(id);
        if (!l.startsWith('buying/')) continue;
        if (OPT_IN_LAYERS.includes(l.slice('buying/'.length)) && !own.has(l)) continue;
        layers.add(l);
      }
      return [task, [...layers].sort()];
    })
  );
  return taskModulesCache;
}
