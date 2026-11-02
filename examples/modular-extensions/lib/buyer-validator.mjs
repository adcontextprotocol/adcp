// Buyer-side validation: core schema first, then every piece of extension data
// found at a hook that a core (kernel or module) schema declares.
//
// Rules implemented (the proposal's hook design):
//  1. Core is validated against the buyer's pinned core bundle. Hooks are found
//     by two annotations, wherever they occur:
//       x-adcp-extension-point  an extension point: an array of ExtensionEntry (or, with
//                               identity "enclosing", the data of the extension
//                               the enclosing declaration names);
//       x-adcp-open-union       a host object whose discriminator may be an
//                               extension branch id (<uri>#<branch>); the body property
//                               carries the branch's ExtensionEntry, or, with identity
//                               "enclosing", the enclosing declaration names the
//                               extension (the kernel's task union).
//  2. The hook's annotation sets the must-understand policy: always (binding,
//     e.g. under terms_digest), flag (the entry's must_understand), never
//     (readback). An open-union branch is must-understand unless its union says
//     never (a task a seller offers). No hook name is hard-coded here: the kernel
//     knows the mechanism, not the modules' hooks.
//  3. An entry is understood only if the buyer has an installed module for the
//     exact uri@digest. Schema-only knowledge is not understanding.
//  4. Unknown must-understand data => reject (fail closed). Unknown optional
//     entry => ignore (optionally schema-check it from a bundled/fetched copy).
//     Exception set by the union's owner: with `unknown_in_list: drop_option`,
//     an unknown branch on a host that is an array item (one pricing option of a
//     product) drops that item with a warning; the rest of the message stays
//     usable. A host that is not an array item (the pricing of a purchase in
//     signed terms) is still rejected, and so is a list whose every item drops.
//  5. Digest mismatch (bytes do not hash to the declared digest) or divergent
//     digests for one uri in one message => that uri is unresolved; fail closed.
//     Declarations (capability fragments, task bindings) may list several digests of one uri.
//  6. An extension point with order "uri" must hold unique entries in ascending uri order.
//  7. A module may report `violations` at a readback hook: the message is valid,
//     but the seller acted outside what the buyer accepted.
//  8. A module is loaded only if it is compatible with the pinned core release
//     (lib/compat.mjs): same hook majors, same core-type majors.
//  9. A module's code (index.mjs) runs only if it hashes to the reference code the
//     extension digest pins (docs.reference_code); otherwise EXTENSION_CODE_MISMATCH.
// 10. A contributed task's request and response are validated against the definitions
//     the module registers for its `task` branch (validateTask); the module's check()
//     then runs on the response.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { DIGEST_RE, digestOfValue, refKey, sha256Digest } from './digest.mjs';
import { coreUri, loadCoreSchemas } from './core-schemas.mjs';
import { checkCompat } from './compat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pinnedCoreRelease = () => JSON.parse(readFileSync(path.join(ROOT, 'core/release.json'), 'utf8'));

/** Discriminator value of an extension branch in an open union (core/extension-branch-id.json). */
export const BRANCH_ID_RE = /^https:\/\/[^\s#@]+#[a-z][a-z0-9_]*$/;
export const splitBranchId = (id) => ({ uri: id.slice(0, id.lastIndexOf('#')), branch: id.slice(id.lastIndexOf('#') + 1) });

/** The manifest entry an extension registers for a hook (and, for an open union, a branch). */
export const declFor = (manifest, point, branch) => manifest?.extends?.find((e) => e.point === point && (e.branch ?? null) === (branch ?? null));

/** Objects along a JSON pointer, root first, so a module can see the host (for example the product of a pricing option). */
function ancestorsOf(root, pointer) {
  const chain = [root];
  let node = root;
  for (const raw of pointer.split('/').slice(1)) {
    node = node?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
    chain.push(node);
  }
  return chain;
}

export class ExtensionLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The check() the SDK generates for an extension it understands by schema only (no package
 * that ships the pinned reference code is installed). Its bytes are fixed, so the loader can
 * tell it from any other code: a lock entry marked `code: "schema-only"` must carry exactly this.
 */
export const SCHEMA_ONLY_CHECK = `// Generated by adcp-sdk: no code was published for this extension, so the SDK
// understands it by schema only. Add semantic checks here, or install the
// author's package if one exists.
export function check() {
  return { errors: [], warnings: [] };
}
`;

/**
 * The code half of loading a module: index.mjs must be the exact file the extension digest
 * pins (docs.reference_code), or, for a module the SDK generated, the fixed schema-only stub.
 * Checked before the code is imported, so code that does not match never runs.
 * Fails closed with EXTENSION_CODE_MISMATCH (bytes differ) or EXTENSION_CODE_UNPINNED (the
 * bundle pins no code and the lock does not say schema-only).
 */
export function verifyReferenceCode(lock, manifest, codeBytes) {
  const actual = sha256Digest(codeBytes);
  if (lock.code === 'schema-only') {
    const stub = sha256Digest(Buffer.from(SCHEMA_ONLY_CHECK, 'utf8'));
    if (actual !== stub) throw new ExtensionLoadError('EXTENSION_CODE_MISMATCH', `${lock.uri}@${lock.version}: index.mjs hashes to ${actual}; a schema-only module must carry the SDK stub ${stub}`);
    return 'schema-only';
  }
  const pin = manifest?.docs?.reference_code;
  if (!pin) throw new ExtensionLoadError('EXTENSION_CODE_UNPINNED', `${lock.uri}@${lock.version}: the bundle pins no reference code (docs.reference_code); refusing to run unpinned index.mjs`);
  if (actual !== pin.sha256) {
    throw new ExtensionLoadError('EXTENSION_CODE_MISMATCH', `${lock.uri}@${lock.version}: ${pin.path} hashes to ${actual}, the extension digest pins ${pin.sha256}`);
  }
  return 'reference-code';
}

/**
 * Load an installed extension module (an npm package directory).
 * The digest is re-verified from the bytes on disk: a tampered or corrupted
 * bundle is refused, exactly like a fetched one. Then index.mjs is checked
 * against the sha256 the bundle pins, and imported only if it matches.
 */
export async function loadModule(dir) {
  const lock = JSON.parse(readFileSync(path.join(dir, 'extension.lock.json'), 'utf8'));
  const bytes = readFileSync(path.join(dir, 'dist/bundle.json'));
  const mod = moduleFromBytes(lock, bytes);
  const codeFile = path.join(dir, 'index.mjs');
  const understanding = verifyReferenceCode(lock, mod.manifest, readFileSync(codeFile));
  const code = await import(pathToFileURL(codeFile).href);
  return { ...mod, understanding, check: code.check };
}

export function moduleFromBytes(lock, bytes, code) {
  const actual = sha256Digest(bytes);
  if (actual !== lock.digest) {
    throw new ExtensionLoadError('EXTENSION_DIGEST_MISMATCH', `${lock.uri}: bundle hashes to ${actual}, lock says ${lock.digest}`);
  }
  const bundle = JSON.parse(bytes);
  if (bundle.$id !== lock.uri) throw new ExtensionLoadError('EXTENSION_ID_MISMATCH', `${lock.uri}: bundle $id is ${bundle.$id}`);
  return { uri: lock.uri, digest: lock.digest, version: lock.version, bundle, manifest: bundle['x-adcp-extension'], check: code?.check };
}

/** Simulated https fetch of uri@digest from the local registry/ directory. */
export function registryFetcher(registryDir) {
  return (uri, digest) => {
    const u = new URL(uri);
    try {
      return readFileSync(path.join(registryDir, u.host, u.pathname, `${digest.slice(7)}.json`));
    } catch {
      return null;
    }
  };
}

export function createBuyerValidator({ modules = [], fetcher = null, coreRelease = pinnedCoreRelease() } = {}) {
  for (const m of modules) {
    const compat = checkCompat(m.manifest, coreRelease);
    if (!compat.ok) {
      throw new ExtensionLoadError('EXTENSION_CORE_INCOMPATIBLE', `${m.uri}@${m.version}: ${compat.reasons.join('; ')}`);
    }
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  // Collects hook instances during core validation. Both keywords are annotations.
  let sink = null;
  for (const [keyword, kind] of [['x-adcp-extension-point', 'extension-point'], ['x-adcp-open-union', 'union']]) {
    ajv.addKeyword({
      keyword,
      schemaType: 'object',
      errors: false,
      validate(hook, data, _parentSchema, cxt) {
        sink?.push({ kind, hook, data, enclosing: cxt.parentData, path: cxt.instancePath, root: cxt.rootData });
        return true;
      },
    });
  }

  // Core: host-relative $ids made absolute, so extension bundles can $ref them.
  for (const { id, schema } of loadCoreSchemas()) ajv.addSchema({ ...schema, $id: coreUri(id) });

  // Installed modules, keyed by uri@digest. Each bundle is registered under that key.
  const installed = new Map();
  const addDefinitions = (key, bundle) => {
    if (!ajv.getSchema(key)) ajv.addSchema({ ...bundle, $id: key });
  };
  for (const m of modules) {
    const key = refKey(m.uri, m.digest);
    installed.set(key, m);
    addDefinitions(key, m.bundle);
  }
  const knownUris = new Set(modules.map((m) => m.uri));

  const ajvErrors = (errs) => (errs ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);

  function validateDefinition(key, definition, data) {
    const v = ajv.getSchema(`${key}#/definitions/${definition}`);
    return v(data) ? [] : ajvErrors(v.errors);
  }

  /** Get an uninstalled definition from the message bundle or the fetcher; verify its digest. */
  function resolveUninstalled(uri, digest, bundled) {
    const key = refKey(uri, digest);
    if (bundled[key]) return { bundle: bundled[key] }; // already verified in step 2
    const bytes = fetcher?.(uri, digest);
    if (!bytes) return null;
    if (sha256Digest(bytes) !== digest) return { mismatch: true };
    return { bundle: JSON.parse(bytes) };
  }

  /**
   * @param schemaId core $id of the payload, e.g. /schemas/media-buy/commercial-terms.json
   * @param payload  the message
   * @param options.bundledExtensions definitions shipped with the message, keyed uri@digest
   *                 (the get_products `extensions` map)
   */
  function validate(schemaId, payload, { bundledExtensions = {} } = {}) {
    const report = { ok: false, errors: [], warnings: [], violations: [], extensions: [], dropped: [] };

    // 1. Core.
    sink = [];
    const coreValid = ajv.validate(coreUri(schemaId), payload);
    const found = sink;
    sink = null;
    if (!coreValid) {
      report.errors.push(...ajvErrors(ajv.errors).map((m) => ({ code: 'CORE_SCHEMA_INVALID', message: m })));
      return report;
    }

    // 2. Bundled definitions must hash to the digest in their key.
    const unresolved = new Map(); // uri -> code
    for (const [key, value] of Object.entries(bundledExtensions)) {
      const at = key.lastIndexOf('@');
      if (digestOfValue(value) !== key.slice(at + 1)) unresolved.set(key.slice(0, at), 'EXTENSION_DIGEST_MISMATCH');
    }

    // 3. Flatten hooks into entries; dedupe by path (an annotation can be visited by several oneOf branches).
    const items = new Map();
    const structural = (code, at, message) => report.errors.push({ code, path: at, message });
    for (const f of found) {
      const base = { point: f.hook.name, policy: f.hook.must_understand, root: f.root };
      if (f.kind === 'union') {
        const value = f.data?.[f.hook.discriminator];
        if (typeof value !== 'string' || !BRANCH_ID_RE.test(value)) continue; // a closed value: core validated it
        const { uri, branch } = splitBranchId(value);
        const policy = f.hook.must_understand ?? 'always';
        if (f.hook.identity === 'enclosing') {
          // The nearest enclosing object that names an extension (a declaration) identifies the branch.
          const owner = ancestorsOf(f.root, f.path).slice(0, -1).reverse().find((a) => a && typeof a === 'object' && !Array.isArray(a) && a.uri && a.digest);
          const at = `${f.path}/${f.hook.discriminator}`;
          if (!owner) structural('EXTENSION_BRANCH_MISMATCH', at, `${value}: no enclosing object names the extension`);
          else if (owner.uri !== uri) structural('EXTENSION_BRANCH_MISMATCH', at, `${f.hook.discriminator} names ${uri}, but the enclosing declaration is ${owner.uri}`);
          else items.set(at, { ...base, path: at, branch, policy, declaration: true, item: { uri, digest: owner.digest, data: f.data }, enclosing: f.data, hostPath: f.path, structuralOnly: true });
          continue;
        }
        const at = `${f.path}/${f.hook.body}`;
        const body = f.data[f.hook.body];
        if (!body) structural('EXTENSION_BRANCH_BODY_MISSING', at, `${value}: ${f.hook.body} is required for an extension branch`);
        else if (body.uri !== uri) structural('EXTENSION_BRANCH_MISMATCH', at, `${f.hook.discriminator} names ${uri}, but ${f.hook.body} carries ${body.uri}`);
        else {
          // unknown_in_list applies only when the host is an item of an array.
          const list = Array.isArray(f.enclosing) ? { path: f.path.slice(0, f.path.lastIndexOf('/')), length: f.enclosing.length } : null;
          items.set(at, { ...base, path: at, branch, policy, item: body, enclosing: f.data, hostPath: f.path, list, unknownInList: f.hook.unknown_in_list ?? 'reject' });
        }
      } else if (f.hook.identity === 'enclosing') {
        const { uri, digest } = f.enclosing ?? {};
        if (f.data && uri && digest) items.set(f.path, { ...base, path: f.path, declaration: true, item: { uri, digest, data: f.data }, enclosing: f.enclosing, hostPath: f.path });
      } else if (Array.isArray(f.data)) {
        if (f.hook.order === 'uri' && f.data.some((t, i) => i > 0 && !(f.data[i - 1].uri < t.uri))) {
          structural('EXTENSION_ORDER_INVALID', f.path, `${f.hook.name}: entries must be unique by uri and in ascending uri order`);
        }
        f.data.forEach((item, i) => {
          items.set(`${f.path}/${i}`, { ...base, path: `${f.path}/${i}`, item, enclosing: f.enclosing, hostPath: f.path });
        });
      }
    }

    // 4. Divergent digests for one uri in one message (declarations may list several).
    const digestsByUri = new Map();
    for (const { item, declaration } of items.values()) {
      if (!declaration) digestsByUri.set(item.uri, (digestsByUri.get(item.uri) ?? new Set()).add(item.digest));
    }
    for (const [uri, digests] of digestsByUri) if (digests.size > 1) unresolved.set(uri, 'EXTENSION_DIGEST_DIVERGENT');

    // 5. Each entry.
    const droppedFrom = new Map(); // list path -> { length, dropped }
    for (const { path: at, point, branch, policy, item, enclosing, root, hostPath, declaration, list, unknownInList, structuralOnly } of items.values()) {
      const mustUnderstand = policy === 'always' || (policy === 'flag' && item.must_understand === true);
      const row = { path: at, point, ...(branch ? { branch } : {}), uri: item.uri, digest: item.digest, must_understand: mustUnderstand, warnings: [] };
      report.extensions.push(row);
      const reject = (code, message) => {
        row.status = 'rejected';
        row.code = code;
        report.errors.push({ code, path: at, message });
      };
      const ignore = (note) => {
        row.status = 'ignored';
        if (note) row.note = note;
      };
      const key = refKey(item.uri, item.digest);

      if (!DIGEST_RE.test(item.digest)) {
        reject('EXTENSION_INVALID_REF', `${item.uri}: malformed digest`);
        continue;
      }
      if (unresolved.has(item.uri) && !declaration) {
        const code = unresolved.get(item.uri);
        if (mustUnderstand || code === 'EXTENSION_DIGEST_DIVERGENT') reject(code, `${item.uri}: unresolved (${code})`);
        else {
          ignore(`unresolved (${code})`);
          report.warnings.push({ code, path: at, message: `${item.uri}: unresolved, ignored` });
        }
        continue;
      }

      const mod = installed.get(key);
      if (!mod) {
        if (mustUnderstand) {
          const code = knownUris.has(item.uri) ? 'EXTENSION_VERSION_NOT_UNDERSTOOD' : 'EXTENSION_NOT_UNDERSTOOD';
          if (branch && list && unknownInList === 'drop_option') {
            row.status = 'dropped';
            row.code = code;
            report.dropped.push(hostPath);
            const d = droppedFrom.get(list.path) ?? { length: list.length, dropped: 0 };
            droppedFrom.set(list.path, { ...d, dropped: d.dropped + 1 });
            report.warnings.push({ code: 'EXTENSION_OPTION_DROPPED', path: hostPath, message: `${key} is not understood at ${point}#${branch}; dropped ${hostPath} and kept the other items of ${list.path || '/'}` });
            continue;
          }
          reject(code, `${key} is must-understand at ${branch ? `${point}#${branch}` : point} and no installed module handles it`);
          continue;
        }
        if (structuralOnly) {
          ignore('no module for this extension');
          continue;
        }
        const def = resolveUninstalled(item.uri, item.digest, bundledExtensions);
        if (def?.mismatch) {
          ignore('fetched definition failed digest check');
          report.warnings.push({ code: 'EXTENSION_DIGEST_MISMATCH', path: at, message: `${item.uri}: fetched bytes do not match digest; ignored` });
        } else if (def) {
          addDefinitions(key, def.bundle);
          const decl = declFor(def.bundle['x-adcp-extension'], point, branch);
          const problems = decl ? validateDefinition(key, decl.definition, item.data) : ['no definition for this point'];
          ignore(problems.length ? `schema-invalid (${problems[0]}), not interpreted` : 'schema-valid, not interpreted (no module)');
        } else ignore('unknown optional extension');
        continue;
      }

      const decl = declFor(mod.manifest, point, branch);
      if (!decl) {
        const where = branch ? `${point}#${branch}` : point;
        if (mustUnderstand) reject('EXTENSION_POINT_NOT_DECLARED', `${key} does not attach at ${where}`);
        else ignore(`module does not attach at ${where}`);
        continue;
      }
      if (structuralOnly) {
        // A task binding: the module registers the branch, so the caller can call it.
        row.status = 'understood';
        continue;
      }
      if (decl.must_understand === 'required' && !mustUnderstand) {
        reject('EXTENSION_MUST_UNDERSTAND_MISMATCH', `${key} is must-understand at ${point} per its definition, but the entry is marked optional`);
        continue;
      }
      const problems = validateDefinition(key, decl.definition, item.data);
      if (problems.length) {
        if (mustUnderstand) reject('EXTENSION_DATA_INVALID', `${key}: ${problems.join('; ')}`);
        else {
          ignore('data invalid');
          report.warnings.push({ code: 'EXTENSION_DATA_INVALID', path: at, message: problems.join('; ') });
        }
        continue;
      }
      const result = mod.check(point, item.data, {
        enclosing,
        branch,
        decl,
        self: { uri: mod.uri, digest: mod.digest },
        ancestors: ancestorsOf(root, hostPath),
      });
      row.warnings.push(...result.warnings);
      if (result.violations?.length) {
        row.violations = result.violations;
        report.violations.push(...result.violations.map((message) => ({ code: 'EXTENSION_DATA_VIOLATED', path: at, uri: item.uri, message })));
      }
      if (result.errors.length) {
        if (mustUnderstand) reject('EXTENSION_SEMANTIC_ERROR', `${key}: ${result.errors.join('; ')}`);
        else ignore(`semantic errors: ${result.errors.join('; ')}`);
        continue;
      }
      row.status = 'understood';
      if (result.evaluation) row.evaluation = result.evaluation;
    }

    // A list whose every item was dropped leaves the enclosing object with nothing to act on.
    for (const [listPath, { length, dropped }] of droppedFrom) {
      if (dropped === length) {
        report.errors.push({ code: 'EXTENSION_NOT_UNDERSTOOD', path: listPath, message: `every item of ${listPath || '/'} carries an extension branch this receiver does not understand` });
      }
    }

    report.ok = report.errors.length === 0;
    return report;
  }

  /**
   * A contributed task's request or response, against the definitions the module registers for
   * its `task` branch: `definition` types the request, `response` the response. The module's
   * check('task', response, { branch, request }) then runs on a response.
   * @param task { uri, digest, branch }  (a generated task descriptor has these)
   * @param side 'request' | 'response'
   */
  function validateTask(task, side, payload, { request } = {}) {
    const report = { ok: false, errors: [], warnings: [], violations: [], extensions: [], dropped: [] };
    const key = refKey(task.uri, task.digest);
    const at = '/';
    const row = { path: at, point: 'task', branch: task.branch, side, uri: task.uri, digest: task.digest, must_understand: true, warnings: [] };
    report.extensions.push(row);
    const reject = (code, message) => {
      row.status = 'rejected';
      row.code = code;
      report.errors.push({ code, path: at, message });
      return report;
    };
    const mod = installed.get(key);
    if (!mod) return reject(knownUris.has(task.uri) ? 'EXTENSION_VERSION_NOT_UNDERSTOOD' : 'EXTENSION_NOT_UNDERSTOOD', `${key}: no installed module handles task ${task.branch}`);
    const decl = declFor(mod.manifest, 'task', task.branch);
    if (!decl) return reject('EXTENSION_POINT_NOT_DECLARED', `${key} registers no task ${task.branch}`);
    const problems = validateDefinition(key, side === 'request' ? decl.definition : decl.response, payload);
    if (problems.length) return reject('EXTENSION_DATA_INVALID', `${key}#${task.branch} ${side}: ${problems.join('; ')}`);
    if (side === 'response') {
      const result = mod.check('task', payload, { branch: task.branch, decl, request, self: { uri: mod.uri, digest: mod.digest } });
      row.warnings.push(...result.warnings);
      if (result.errors.length) return reject('EXTENSION_SEMANTIC_ERROR', `${key}#${task.branch}: ${result.errors.join('; ')}`);
    }
    row.status = 'understood';
    report.ok = true;
    return report;
  }

  return { validate, validateTask, installed };
}

/** A copy of payload without the array items the report dropped (unknown_in_list: drop_option). */
export function pruneDropped(payload, dropped) {
  const out = structuredClone(payload);
  const decode = (t) => t.replace(/~1/g, '/').replace(/~0/g, '~');
  // Highest index first, so earlier removals do not shift later pointers.
  const sorted = [...dropped].sort((a, b) => Number(b.split('/').at(-1)) - Number(a.split('/').at(-1)));
  for (const pointer of sorted) {
    const tokens = pointer.split('/').slice(1).map(decode);
    const index = Number(tokens.pop());
    let parent = out;
    for (const t of tokens) parent = parent[t];
    parent.splice(index, 1);
  }
  return out;
}

/**
 * Capability negotiation. sellerDeclared = get_adcp_capabilities.declared_extensions.
 * A pair is usable only on an exact uri@digest match. `tasks` maps each task id
 * (<uri>#<task>) of a usable declaration to the transport name the seller serves it under.
 */
export function negotiate(sellerDeclared, modules) {
  const buyer = new Map(modules.map((m) => [refKey(m.uri, m.digest), m]));
  const seller = new Map(sellerDeclared.map((d) => [refKey(d.uri, d.digest), d]));
  const usable = [...seller.keys()].filter((k) => buyer.has(k));
  const sellerOnly = [...seller.keys()].filter((k) => !buyer.has(k));
  const buyerOnly = [...buyer.keys()].filter((k) => !seller.has(k));
  const versionSkew = sellerDeclared
    .filter((d) => !buyer.has(refKey(d.uri, d.digest)) && modules.some((m) => m.uri === d.uri))
    .map((d) => d.uri);
  const tasks = {};
  for (const key of usable) {
    const d = seller.get(key);
    for (const t of d.tasks ?? []) tasks[t.task] = { name: t.name, uri: d.uri, digest: d.digest };
  }
  return { usable, sellerOnly, buyerOnly, versionSkew, tasks };
}
