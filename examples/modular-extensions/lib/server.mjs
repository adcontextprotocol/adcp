// Seller-side SDK helper: one dispatcher for kernel and module tasks and for the tasks that
// extensions contribute. A sales agent registers handlers and declares its extensions; the
// helper does the protocol work around them:
//
//  - It validates every request it receives and every response it sends: a kernel or module
//    task against the pinned core schemas, a contributed task against the request and
//    response definitions the extension registers for its `task` branch. Extension bundles
//    are registered by uri@digest, so their core $refs resolve from the same pinned core.
//  - It answers get_adcp_capabilities: one `declared_extensions` entry per declared
//    uri@digest, with the hooks the agent uses, the extension's capability fragment, and a
//    transport name for every contributed task it serves (`tasks`).
//  - It hands each handler the caller's understood_extensions, so the agent can send
//    must-understand data only to a caller that listed it (`ctx.agreed(uri)`).
//
// Apps use it through their generated layer (adcp-sdk/, lib/binding.mjs): createServer() declares the
// app's extensions, and each handler reads and writes plain attributes.
//
// In production the transport is MCP or A2A: a contributed task is one more MCP tool or A2A
// skill, named by its transport name. Here `transport.call(name, request)` is in process.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { coreUri, loadCoreSchemas } from './core-schemas.mjs';
import { refKey, sha256Digest } from './digest.mjs';
import { compareVersions } from './compat.mjs';
import { modulesMap } from './modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class SellerRejection extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Core schemas for the kernel and module tasks this example serves. */
const CORE_TASKS = {
  get_adcp_capabilities: { response: '/schemas/protocol/get-adcp-capabilities-response.json' },
  get_products: { request: '/schemas/media-buy/get-products-request.json' },
  request_proposals: { request: '/schemas/media-buy/request-proposals-request.json', response: '/schemas/media-buy/request-proposals-response.json' },
  refine_proposals: { request: '/schemas/media-buy/refine-proposals-request.json' },
  accept_proposal: { request: '/schemas/media-buy/accept-proposal-request.json' },
  get_media_buys: { response: '/schemas/media-buy/get-media-buys-response.json' },
};

/** A published version from the registry (this example's simulated https hosting): { uri, version, digest, bundle }. */
export function fromRegistry(uri, version, registry = path.join(ROOT, 'registry')) {
  const u = new URL(uri);
  const dir = path.join(registry, u.host, u.pathname);
  const { versions } = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const digest = versions[version]?.digest;
  if (!digest) throw new Error(`${uri}@${version} is not published`);
  const bytes = readFileSync(path.join(dir, `${digest.slice('sha256:'.length)}.json`));
  return { uri, version, digest, bytes };
}

/** A generated extension module (EXTENSION_URI, EXTENSION_DIGEST, EXTENSION_MODULE_DIR), or a registry version. */
function loadExtension(ext) {
  const source = ext.EXTENSION_URI
    ? { uri: ext.EXTENSION_URI, digest: ext.EXTENSION_DIGEST, version: ext.EXTENSION_VERSION, bytes: readFileSync(path.join(fileURLToPath(ext.EXTENSION_MODULE_DIR), 'dist/bundle.json')) }
    : ext;
  if (sha256Digest(source.bytes) !== source.digest) throw new SellerRejection('EXTENSION_DIGEST_MISMATCH', `${source.uri}: bundle bytes do not hash to ${source.digest}`);
  const bundle = JSON.parse(source.bytes);
  return { uri: source.uri, digest: source.digest, version: source.version ?? bundle['x-adcp-extension'].version, bundle, manifest: bundle['x-adcp-extension'] };
}

/**
 * @param options.protocols        supported_protocols in the capabilities response
 * @param options.ignoreUnderstood a misbehaving seller (conformance fixtures): every handler sees
 *                                 every declared extension as understood
 * @param options.modules          the standard modules and buying layers this agent implements
 *                                 (`buying/pricing`, `governance`; `buying` is every buying layer): the
 *                                 capabilities response lists each with its version and frozen digest
 *                                 (`modules`, lib/modules.mjs). Absent: no `modules` map, as a 3.3 agent.
 */
export function createAdcpServer({ protocols = ['media_buy'], ignoreUnderstood = false, modules } = {}) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const { id, schema } of loadCoreSchemas()) ajv.addSchema({ ...schema, $id: coreUri(id) });
  const errors = (errs) => (errs ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}`);

  const declared = []; // { uri, digest, version, manifest, points?, capabilities? }
  const handlers = new Map(); // transport name -> { handler, schemas | task }
  const served = new Map(); // uri@digest -> [{ name, task }]
  const listeners = new Set();

  /** Validate a payload against a core schema; throws INVALID_REQUEST (the caller's fault) or INVALID_RESPONSE (ours). */
  function assertCore(id, payload, side, code = 'INVALID_REQUEST') {
    if (!ajv.validate(coreUri(id), payload)) throw new SellerRejection(code, `${side} does not validate against core ${id}`, errors(ajv.errors));
  }
  function assertDefinition(key, definition, payload, side, code) {
    const v = ajv.getSchema(`${key}#/definitions/${definition}`);
    if (!v(payload)) throw new SellerRejection(code, `${side} does not validate against ${key.replace(/@sha256:(.{12}).*/, '@sha256:$1…')}#/definitions/${definition}`, errors(v.errors));
  }

  /** Handler context: who calls (identity, from the transport), what it understands, and the version of an extension to serve it. */
  function contextFor(request, identity) {
    const understood = new Set(
      ignoreUnderstood ? declared.map((d) => refKey(d.uri, d.digest)) : (request.understood_extensions ?? []).map((e) => refKey(e.uri, e.digest))
    );
    return {
      identity,
      understood,
      /** The highest declared version of `uri` the caller listed in understood_extensions, or null. */
      agreed(uri) {
        return declared.filter((d) => d.uri === uri && understood.has(refKey(d.uri, d.digest))).sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
      },
    };
  }

  function capabilities() {
    return {
      status: 'completed',
      adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      supported_protocols: protocols,
      ...(modules ? { modules: modulesMap(modules) } : {}),
      declared_extensions: declared.map((d) => {
        const tasks = served.get(refKey(d.uri, d.digest)) ?? [];
        const points = new Set(d.points ?? d.manifest.extends.map((e) => e.point).filter((p) => p !== 'task'));
        if (tasks.length) points.add('task');
        return {
          uri: d.uri,
          digest: d.digest,
          points: [...points].sort(),
          ...(d.capabilities ? { capabilities: d.capabilities } : {}),
          ...(tasks.length ? { tasks } : {}),
        };
      }),
    };
  }

  const server = {
    declared,
    assertCore,

    /**
     * Declare an extension this agent emits: a generated module, or a registry version
     * (fromRegistry). Several digests of one uri may be declared side by side.
     * @param options.points       hooks to list, when the agent uses fewer than the manifest registers
     * @param options.capabilities the extension's capability fragment (its `capabilities` hook)
     */
    declare(ext, { points, capabilities: fragment } = {}) {
      const d = { ...loadExtension(ext), ...(points ? { points } : {}), ...(fragment ? { capabilities: fragment } : {}) };
      const key = refKey(d.uri, d.digest);
      if (!ajv.getSchema(key)) ajv.addSchema({ ...d.bundle, $id: key });
      declared.push(d);
      return d;
    },

    /**
     * Register a handler. `task` is a kernel or module task name, or a contributed task
     * (a generated descriptor such as makegoodUnits.tasks.requestMakegood). A contributed task
     * is served under a transport name, `x_<task>` unless options.name says otherwise, and
     * appears in the capabilities response under its extension's declaration.
     */
    handle(task, handler, { name } = {}) {
      if (typeof task === 'string') {
        handlers.set(task, { handler, core: CORE_TASKS[task] ?? {} });
        return server;
      }
      const d = declared.find((x) => x.uri === task.uri && x.digest === task.digest);
      if (!d) throw new Error(`${task.id}: declare ${task.uri}@${task.digest} before handling its tasks`);
      const decl = d.manifest.extends.find((e) => e.point === 'task' && e.branch === task.branch);
      if (!decl) throw new Error(`${task.id}: ${task.uri}@${task.digest} registers no such task`);
      const transportName = name ?? `x_${task.branch}`;
      if (handlers.has(transportName)) throw new Error(`${transportName} is already served`);
      handlers.set(transportName, { handler, contributed: { key: refKey(d.uri, d.digest), id: task.id, decl } });
      const key = refKey(d.uri, d.digest);
      served.set(key, [...(served.get(key) ?? []), { name: transportName, task: task.id }]);
      return server;
    },

    /** The envelope { uri, digest, data } for a declared version that has no generated writer (an older digest). */
    entry(declaration, data) {
      return { uri: declaration.uri, digest: declaration.digest, data };
    },

    /** Send an account.change_recorded record on the core change feed, after validating it. */
    publish(change) {
      assertCore('/schemas/core/account-change.json', change, 'change record', 'INVALID_RESPONSE');
      for (const fn of listeners) fn(structuredClone(change));
      return change;
    },

    transport: {
      /** identity: what the transport authenticated (in production, from the MCP or A2A session), such as { tenant }. */
      async call(name, request, identity) {
        await new Promise((r) => setImmediate(r)); // a network hop: the seller finishes its current operation first
        const req = structuredClone(request);
        if (name === 'get_adcp_capabilities' && !handlers.has(name)) {
          const caps = capabilities();
          assertCore(CORE_TASKS.get_adcp_capabilities.response, caps, 'capabilities', 'INVALID_RESPONSE');
          return caps;
        }
        const h = handlers.get(name);
        if (!h) throw new SellerRejection('UNSUPPORTED_TASK', name);
        if (h.contributed) {
          const { key, id, decl } = h.contributed;
          assertDefinition(key, decl.definition, req, `${id} request`, 'INVALID_REQUEST');
          const res = await h.handler(req, contextFor(req, identity));
          assertDefinition(key, decl.response, res, `${id} response`, 'INVALID_RESPONSE');
          return structuredClone(res);
        }
        if (h.core.request) assertCore(h.core.request, req, `${name} request`);
        const res = await h.handler(req, contextFor(req, identity));
        if (h.core.response) assertCore(h.core.response, res, `${name} response`, 'INVALID_RESPONSE');
        return structuredClone(res);
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
  return server;
}
