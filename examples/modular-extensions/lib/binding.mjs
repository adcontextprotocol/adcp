// The runtime of a generated binding: what an app's generated typed layer (adcp-sdk/, written by
// scripts/adcp-sdk.mjs from adcp.config.json) imports.
//
// The app declares its extensions once, generates its typed layer, and reads and writes extension
// data as plain attributes at the extension points and open unions the core declares:
//
//   proposal.commercial_terms.makegood_units.rules[0].max_units      (wire: commercial_terms.extensions[i].data)
//   mediaBuy.makegood_units.issued                                     (wire: media_buys[j].extensions_state[i].data)
//   option.linear_tv_indexed_cpp.base_price                             (wire: pricing_model "<uri>#indexed_cpp" + extension_model.data)
//
// The wire stays the extension envelope { uri, digest, must_understand?, data }. This module maps
// between the two forms:
//
//  - decode(message): wire -> attributes. An entry binds to the attribute of the exact uri@digest
//    the app generated for; several versions of one uri are separate attributes. An unknown
//    must-understand entry is refused at its wire location (…/extensions/1); an unknown optional
//    entry is kept out of sight and written back on encode, so a parsed object re-encodes to the
//    same bytes (and the same terms_digest).
//  - encode(value): attributes -> wire. Entries are ordered as the extension point says, and each
//    attribute's data is validated against the pinned bundle; errors point at wire locations
//    (…/extensions/0/data/rules/0/max_units), never at the attribute path the peer never sees.
//  - requireUnderstood(): a seller sends must-understand data only to a caller that listed its
//    exact uri@digest in understood_extensions.
//  - wireSchema(): the JSON Schema a peer writes against is the wire schema (extensions[], not
//    attributes), annotated with the uri@digest set this build understands.
//
// It holds no state. Every function takes the generated, frozen binding (BINDING in
// adcp-sdk/bindings.ts) as an argument; nothing registers anything at parse time. The generated
// layer is per app and is the superset of extensions the app may use; per-tenant enablement is
// data, checked at the boundary after the tenant resolves (createBoundServer, `tenants`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createAdcpClient } from './client.mjs';
import { CORE_ORIGIN, coreUri, loadCoreSchemas } from './core-schemas.mjs';
import { refKey, sha256Digest, termsDigest } from './digest.mjs';
import { SellerRejection, createAdcpServer } from './server.mjs';

/** Discriminator value of an extension branch (core/extension-branch-id.json). */
const BRANCH_ID_RE = /^https:\/\/[^\s#@]+#[a-z][a-z0-9_]*$/;

/**
 * Wire state that the attributes don't hold (per-entry must_understand flags, ignorable entries
 * this build doesn't know, their order), kept on the decoded host under a non-enumerable symbol.
 * JSON and spreads don't see it; encode() reads it back.
 */
export const WIRE_STATE = Symbol.for('adcp.binding.wire-state');

export class BindingError extends Error {
  /** @param issues [{ code, path, message }]; path is a JSON pointer into the wire message */
  constructor(issues, what = 'message') {
    super(`${what}: ${issues.map((i) => `${i.path || '/'} ${i.code}: ${i.message}`).join('; ')}`);
    this.code = issues[0]?.code ?? 'BINDING_ERROR';
    this.issues = issues;
  }
}

const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const ptr = (segs) => segs.map((s) => `/${esc(s)}`).join('');

/** Call fn(node, segments) for every node at `path` (a list of keys; '*' is every array item). */
function eachAt(root, path, fn, segs = []) {
  if (root === null || typeof root !== 'object') return;
  if (!path.length) return fn(root, segs);
  const [head, ...rest] = path;
  if (head === '*') {
    if (Array.isArray(root)) root.forEach((item, i) => eachAt(item, rest, fn, [...segs, i]));
    return;
  }
  if (Object.hasOwn(root, head)) eachAt(root[head], rest, fn, [...segs, head]);
}

function nodeAt(root, segs) {
  let node = root;
  for (const s of segs) node = node?.[s];
  return node;
}

function stateOf(node, hook) {
  return node?.[WIRE_STATE]?.[hook];
}
function setState(node, hook, state) {
  const all = { ...(node[WIRE_STATE] ?? {}), [hook]: state };
  Object.defineProperty(node, WIRE_STATE, { value: all, enumerable: false, configurable: true, writable: true });
}

const at = (b, hook) => b.hooks?.[hook];
const branchAt = (b, hook) => b.branches?.[hook];
const label = (b) => `${b.name} ${b.version} (${b.uri}@${b.digest})`;

function notUnderstood(hook, entry, known) {
  if (!known.length) {
    return `${hook} carries must-understand extension ${entry.uri}@${entry.digest}, which this build does not include. Add it to adcp.config.json and run npm run sdk; until then the enclosing object is rejected`;
  }
  return `${hook} carries ${entry.uri}@${entry.digest}, but this build was generated for ${known.map(label).join(', ')}. Pin the received version in adcp.config.json and run npm run sdk; until then the enclosing object is rejected`;
}

/** A message carries one entry per uri: two attributes for versions of one uri may not both be set. */
function versionIssues(node, list, path) {
  const out = [];
  const byUri = new Map();
  for (const b of list) if (node[b.attribute] !== undefined) byUri.set(b.uri, [...(byUri.get(b.uri) ?? []), b.attribute]);
  for (const [uri, attrs] of byUri) {
    if (attrs.length > 1) out.push({ code: 'EXTENSION_VERSIONS', path, message: `${attrs.join(', ')} are versions of ${uri}; a message carries one` });
  }
  return out;
}

// ------------------------------------------------------------------ wire -> attributes

function decodePoint(node, segs, host, extensions, issues) {
  const { hook, container } = host;
  const list = extensions.filter((b) => at(b, hook));
  const here = ptr(segs);
  for (const b of list) {
    if (Object.hasOwn(node, b.attribute)) issues.push({ code: 'EXTENSION_WIRE_CONFLICT', path: `${here}/${esc(b.attribute)}`, message: `${hook}: ${b.attribute} is an attribute of this build, not a wire field; send it in ${container}[]` });
  }
  const entries = node[container];
  if (!Array.isArray(entries)) return;
  if (host.order === 'uri') {
    const uris = entries.map((e) => e?.uri);
    if (uris.join('\n') !== [...new Set(uris)].sort().join('\n')) {
      issues.push({ code: 'EXTENSION_ORDER', path: `${here}/${container}`, message: `${hook}: entries must be unique by uri and ordered by uri` });
      return;
    }
  }
  const flags = {};
  const unknown = [];
  const order = [];
  entries.forEach((entry, i) => {
    const b = list.find((x) => x.uri === entry.uri && x.digest === entry.digest);
    const required = host.must_understand === 'always' || (host.must_understand === 'flag' && entry.must_understand === true);
    if (!b) {
      if (required) {
        const known = list.filter((x) => x.uri === entry.uri);
        issues.push({ code: known.length ? 'EXTENSION_VERSION_NOT_UNDERSTOOD' : 'EXTENSION_NOT_UNDERSTOOD', path: `${here}/${container}/${i}`, message: notUnderstood(hook, entry, known) });
      } else {
        unknown.push(entry);
        order.push(`#${unknown.length - 1}`);
      }
      return;
    }
    node[b.attribute] = entry.data;
    if (entry.must_understand !== undefined) flags[b.attribute] = entry.must_understand;
    order.push(b.attribute);
  });
  delete node[container];
  issues.push(...versionIssues(node, list, `${here}/${container}`));
  setState(node, hook, { flags, unknown, order });
}

function decodeBranch(node, segs, host, extensions, issues) {
  const { hook, discriminator, body } = host;
  const id = node[discriminator];
  if (typeof id !== 'string' || !BRANCH_ID_RE.test(id)) return; // a core model: nothing to bind
  const list = extensions.filter((b) => branchAt(b, hook));
  const entry = node[body];
  const here = ptr(segs);
  for (const b of list) {
    if (Object.hasOwn(node, b.attribute)) issues.push({ code: 'EXTENSION_WIRE_CONFLICT', path: `${here}/${esc(b.attribute)}`, message: `${hook}: ${b.attribute} is an attribute of this build, not a wire field` });
  }
  const b = list.find((x) => branchAt(x, hook).id === id && entry?.uri === x.uri && entry?.digest === x.digest);
  if (!b) {
    const known = list.filter((x) => branchAt(x, hook).id === id);
    issues.push({ code: known.length ? 'EXTENSION_VERSION_NOT_UNDERSTOOD' : 'EXTENSION_NOT_UNDERSTOOD', path: `${here}/${body}`, message: notUnderstood(`${hook} branch ${id}`, entry ?? { uri: id, digest: '?' }, known) });
    return;
  }
  node[b.attribute] = entry.data;
  delete node[body];
  setState(node, hook, { flags: entry.must_understand !== undefined ? { [b.attribute]: entry.must_understand } : {} });
}

/**
 * Wire -> attributes. `hosts` is the generated layout of one message (BINDING.layout[key].hosts).
 * Returns a copy; throws BindingError with wire locations.
 */
export function decode(message, hosts, extensions, what) {
  const out = structuredClone(message);
  const issues = [];
  for (const host of hosts) {
    eachAt(out, host.path, (node, segs) => (host.kind === 'point' ? decodePoint : decodeBranch)(node, segs, host, extensions, issues));
  }
  if (issues.length) throw new BindingError(issues, what);
  return out;
}

// ------------------------------------------------------------------ attributes -> wire

function encodePoint(node, target, segs, host, extensions, validate, issues) {
  const { hook, container } = host;
  const list = extensions.filter((b) => at(b, hook));
  const present = list.filter((b) => node[b.attribute] !== undefined);
  const state = stateOf(node, hook);
  const here = ptr(segs);
  if (!present.length && !state?.unknown?.length) return;
  if (target[container] !== undefined) {
    issues.push({ code: 'EXTENSION_WIRE_CONFLICT', path: `${here}/${container}`, message: `${hook}: set extension data as attributes (${present.map((b) => b.attribute).join(', ')}), not also as ${container}[]` });
    return;
  }
  const versions = versionIssues(node, list, here);
  if (versions.length) return void issues.push(...versions);
  const rank = (key) => {
    const i = state?.order?.indexOf(key) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const entries = [
    ...present.map((b) => {
      const data = target[b.attribute];
      delete target[b.attribute];
      const flag = state?.flags?.[b.attribute];
      return { key: b.attribute, b, entry: { uri: b.uri, digest: b.digest, ...(flag !== undefined ? { must_understand: flag } : {}), data } };
    }),
    ...(state?.unknown ?? []).map((entry, i) => ({ key: `#${i}`, entry: structuredClone(entry) })),
  ];
  if (host.order === 'uri') entries.sort((x, y) => (x.entry.uri < y.entry.uri ? -1 : x.entry.uri > y.entry.uri ? 1 : 0));
  else entries.sort((x, y) => rank(x.key) - rank(y.key));
  entries.forEach(({ b, entry }, i) => {
    if (!b) return;
    for (const e of validate(b, at(b, hook).definition, entry.data)) issues.push({ code: 'EXTENSION_DATA_INVALID', path: `${here}/${container}/${i}/data${e.instancePath}`, message: `${e.message} (${b.name} ${b.version}, definitions.${at(b, hook).definition})` });
  });
  target[container] = entries.map((x) => x.entry);
}

function encodeBranch(node, target, segs, host, extensions, validate, issues) {
  const { hook, discriminator, body } = host;
  const b = extensions.find((x) => branchAt(x, hook) && node[x.attribute] !== undefined);
  if (!b) return;
  const here = ptr(segs);
  const branch = branchAt(b, hook);
  if (target[discriminator] !== branch.id) {
    issues.push({ code: 'EXTENSION_BRANCH_MISMATCH', path: `${here}/${discriminator}`, message: `${b.attribute} is the ${hook} branch ${branch.id}; set ${discriminator} to it` });
    return;
  }
  const flag = stateOf(node, hook)?.flags?.[b.attribute];
  const data = target[b.attribute];
  delete target[b.attribute];
  target[body] = { uri: b.uri, digest: b.digest, ...(flag !== undefined ? { must_understand: flag } : {}), data };
  for (const e of validate(b, branch.definition, data)) issues.push({ code: 'EXTENSION_DATA_INVALID', path: `${here}/${body}/data${e.instancePath}`, message: `${e.message} (${b.name} ${b.version}, definitions.${branch.definition})` });
}

/**
 * Attributes -> wire. Returns a copy; throws BindingError with wire locations. `validate(binding,
 * definition, data)` returns ajv errors for the data against the pinned bundle (bindingValidator()).
 */
export function encode(value, hosts, extensions, validate = () => [], what) {
  const out = structuredClone(value);
  const issues = [];
  // Deepest hosts first: an outer host's container never holds an inner host here, but this keeps it safe.
  for (const host of [...hosts].sort((a, b) => b.path.length - a.path.length)) {
    eachAt(value, host.path, (node, segs) => {
      const target = nodeAt(out, segs);
      (host.kind === 'point' ? encodePoint : encodeBranch)(node, target, segs, host, extensions, validate, issues);
    });
  }
  if (issues.length) throw new BindingError(issues, what);
  return out;
}

/**
 * Must-understand data the caller did not agree to: an attribute at a must-understand hook whose
 * uri@digest is not in `agreed` (the caller's understood_extensions, as uri@digest keys).
 */
export function requireUnderstood(agreed, value, hosts, extensions) {
  const issues = [];
  for (const host of hosts) {
    eachAt(value, host.path, (node, segs) => {
      const list = extensions.filter((b) => (host.kind === 'point' ? at(b, host.hook) : branchAt(b, host.hook)) && node[b.attribute] !== undefined);
      for (const b of list) {
        const required = host.kind === 'union' || host.must_understand === 'always' || (host.must_understand === 'flag' && stateOf(node, host.hook)?.flags?.[b.attribute] === true);
        if (!required || agreed.has(refKey(b.uri, b.digest))) continue;
        issues.push({ code: 'EXTENSION_NOT_AGREED', path: `${ptr(segs)}/${esc(b.attribute)}`, message: `the caller did not list ${b.uri}@${b.digest} (${b.name} ${b.version}) in understood_extensions; omit ${b.attribute} (ctx.understands('${b.attribute}'))` });
      }
    });
  }
  return issues;
}

// ------------------------------------------------------------------ pinned bundles

/** The bundles the generated layer ships (adcp-sdk/bundles/), digest-checked, in one ajv with the pinned core. */
export function bindingValidator(binding) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const { id, schema } of loadCoreSchemas()) ajv.addSchema({ ...schema, $id: coreUri(id) });
  for (const b of binding.extensions) {
    const bytes = readFileSync(fileURLToPath(new URL(b.bundle, binding.bundles)));
    const digest = sha256Digest(bytes);
    if (digest !== b.digest) throw new BindingError([{ code: 'EXTENSION_DIGEST_MISMATCH', path: '', message: `${b.bundle} hashes to ${digest}; the generated layer pins ${b.digest}` }], 'generated layer');
    ajv.addSchema({ ...JSON.parse(bytes), $id: refKey(b.uri, b.digest) });
  }
  return (b, definition, data) => {
    const v = ajv.getSchema(`${refKey(b.uri, b.digest)}#/definitions/${definition}`);
    return v(data) ? [] : (v.errors ?? []).slice(0, 5);
  };
}

// ------------------------------------------------------------------ the advertised JSON Schema

function coreRefs(node, base, out) {
  if (Array.isArray(node)) return node.forEach((n) => coreRefs(n, base, out));
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string') {
    const file = node.$ref.split('#')[0];
    if (file) out.add(file.startsWith('/') ? file : new URL(file, `${CORE_ORIGIN}${base}`).pathname);
  }
  for (const v of Object.values(node)) coreRefs(v, base, out);
}

/**
 * The JSON Schema a peer writes against for one message: the pinned core schemas (the wire form,
 * with extensions[] and extension_model), self-contained, with each hook annotated by the uri@digest
 * set this build understands (`x-adcp-extensions`). It never lists the attributes.
 */
export function wireSchema(binding, key) {
  const message = binding.layout[key];
  if (!message) throw new Error(`no message ${key} in this binding; known: ${Object.keys(binding.layout).join(', ')}`);
  const byId = new Map(loadCoreSchemas().map((s) => [s.id, s.schema]));
  const ids = new Set();
  const queue = message.roots.map(([, id]) => id);
  while (queue.length) {
    const id = queue.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    const found = new Set();
    coreRefs(byId.get(id), id, found);
    queue.push(...found);
  }
  const copies = new Map([...ids].sort().map((id) => [id, structuredClone(byId.get(id))]));
  for (const host of message.hosts) {
    const refs = binding.extensions.filter((b) => (host.kind === 'point' ? at(b, host.hook) : branchAt(b, host.hook))).map((b) => refKey(b.uri, b.digest));
    for (const { id, pointer } of host.schemas) {
      let node = copies.get(id);
      for (const s of pointer.split('/').slice(1)) node = node[s.replace(/~1/g, '/').replace(/~0/g, '~')];
      const target = host.kind === 'point' ? node.properties[host.container] : node;
      target['x-adcp-extensions'] = refs;
    }
  }
  const wrap = (prefix, id) => prefix.reduceRight((inner, k) => (k === '*' ? { type: 'array', items: inner } : { type: 'object', properties: { [k]: inner } }), { $ref: coreUri(id) });
  const [first] = message.roots;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `${CORE_ORIGIN}/schemas/_generated/${binding.app}/${key}.json`,
    title: `${key} (wire form; generated binding of ${binding.app})`,
    ...(message.roots.length === 1 ? wrap(...first) : { allOf: message.roots.map((r) => wrap(...r)) }),
    'x-adcp-extensions': binding.extensions.map((b) => refKey(b.uri, b.digest)),
    definitions: Object.fromEntries([...copies].map(([id, s]) => [id, { ...s, $id: coreUri(id) }])),
  };
}

// ------------------------------------------------------------------ the typed client and server

const keysOf = (binding) => binding.extensions.map((b) => refKey(b.uri, b.digest));

function taskDescriptor(b, branch, t) {
  return { id: t.id, uri: b.uri, digest: b.digest, branch, request: t.request, response: t.response };
}

/** wire terms_digest of commercial_terms given as attributes (the data is validated when the message is encoded) */
export function boundTermsDigest(binding, terms) {
  return termsDigest(encode(terms, binding.layout.commercial_terms.hosts, binding.extensions, undefined, 'commercial_terms'));
}

/**
 * The app's buyer client: the SDK client underneath (wire validation, must-understand,
 * understood_extensions, terms_digest, the module checks), with every response decoded to
 * attributes and every proposal encoded back before it is accepted. One method per task the
 * app's extensions contribute.
 */
export async function createBoundClient(binding, { transport, onViolation } = {}) {
  const wire = await createAdcpClient({ transport, lockfile: binding.lockfile, onViolation });
  const validate = bindingValidator(binding);
  const X = binding.extensions;
  const dec = (key) => (res) => decode(res, binding.layout[key].hosts, X, key);
  const client = {
    /** The wire-level SDK client under this layer. */
    wire,
    get lastReport() {
      return wire.lastReport;
    },
    get lastReports() {
      return wire.lastReports;
    },
    get sellerCapabilities() {
      return wire.sellerCapabilities;
    },
    get lastTaskCall() {
      return wire.lastTaskCall;
    },
    understoodExtensions: () => X.map(({ uri, digest }) => ({ uri, digest })),
    capabilities: () => wire.capabilities(),
    getProducts: (request) => wire.getProducts(request).then(dec('get_products.response')),
    requestProposals: (request) => wire.requestProposals(request).then(dec('request_proposals.response')),
    refineProposals: (request) => wire.refineProposals(request).then(dec('refine_proposals.response')),
    getMediaBuys: (request) => wire.getMediaBuys(request).then(dec('get_media_buys.response')),
    acceptProposal: ({ proposal, ...request }) => wire.acceptProposal({ ...request, proposal: encode(proposal, binding.layout.proposal.hosts, X, validate, 'proposal') }),
    onChange: (handler) => wire.onChange(handler),
  };
  for (const b of X) for (const [branch, t] of Object.entries(b.tasks ?? {})) client[t.method] = (request) => wire.callTask(taskDescriptor(b, branch, t), request);
  return client;
}

/**
 * The app's seller server: the SDK server underneath (dispatch, core and task validation,
 * capabilities), declaring the app's extensions, with every core task's request decoded to
 * attributes and every response encoded to the wire. A handler sees `ctx.understands(attribute)`:
 * true when the caller listed that uri@digest and the tenant enabled it.
 *
 * @param options.tenants per-tenant enablement: { tenant: [attribute, ...] }. The layer is the
 *   superset; a call through transportFor(tenant) sees only that tenant's extensions in
 *   capabilities, in ctx.understands(), and in contributed tasks. Without `tenants`, every
 *   extension of the layer is enabled.
 */
export function createBoundServer(binding, { protocols, tenants } = {}) {
  const inner = createAdcpServer({ protocols });
  const validate = bindingValidator(binding);
  const X = binding.extensions;
  for (const b of X) {
    inner.declare({ uri: b.uri, digest: b.digest, version: b.version, bytes: readFileSync(fileURLToPath(new URL(b.bundle, binding.bundles))) });
  }
  const enabledFor = (identity) => {
    if (!tenants) return new Set(X.map((b) => b.attribute));
    return new Set(tenants[identity?.tenant] ?? []);
  };
  const context = (ctx) => {
    const enabled = enabledFor(ctx.identity);
    const agreed = new Set(X.filter((b) => enabled.has(b.attribute) && ctx.understood.has(refKey(b.uri, b.digest))).map((b) => refKey(b.uri, b.digest)));
    return {
      understood: ctx.understood,
      identity: ctx.identity,
      enabled,
      agreed,
      /** Send this extension's must-understand data to this caller? (it listed the exact uri@digest, and the tenant enabled it) */
      understands: (attribute) => X.some((b) => b.attribute === attribute && agreed.has(refKey(b.uri, b.digest))),
    };
  };
  const contributed = new Map(); // transport name -> extension binding
  const server = {
    binding,
    declared: inner.declared,
    handle(task, handler, options = {}) {
      const owner = X.find((b) => b.tasks?.[task]);
      if (owner) {
        const t = owner.tasks[task];
        contributed.set(options.name ?? `x_${task}`, owner);
        inner.handle(taskDescriptor(owner, task, t), (request, ctx) => {
          const c = context(ctx);
          if (!c.enabled.has(owner.attribute)) throw new SellerRejection('EXTENSION_NOT_ENABLED', `${t.id}: ${owner.name} is not enabled for this tenant`);
          return handler(request, c);
        }, options);
        return server;
      }
      const requestLayout = binding.layout[`${task}.request`];
      const responseLayout = binding.layout[`${task}.response`];
      inner.handle(task, async (request, ctx) => {
        const c = context(ctx);
        const app = requestLayout ? decode(request, requestLayout.hosts, X, `${task} request`) : request;
        if (requestLayout) {
          const off = requireUnderstood(new Set(X.filter((b) => c.enabled.has(b.attribute)).map((b) => refKey(b.uri, b.digest))), app, requestLayout.hosts, X);
          if (off.length) throw new SellerRejection('EXTENSION_NOT_ENABLED', `${task} request carries extension data this tenant has not enabled`, off);
        }
        const res = await handler(app, c);
        if (!responseLayout) return res;
        // The must-not-send rule applies where the caller negotiated: its request lists understood_extensions.
        const refused = requestLayout?.negotiates ? requireUnderstood(c.agreed, res, responseLayout.hosts, X) : [];
        if (refused.length) throw new SellerRejection('EXTENSION_NOT_AGREED', `${task} response: ${refused.map((i) => `${i.path} ${i.message}`).join('; ')}`, refused);
        try {
          return encode(res, responseLayout.hosts, X, validate, `${task} response`);
        } catch (e) {
          if (e instanceof BindingError) throw new SellerRejection('INVALID_RESPONSE', e.message, e.issues);
          throw e;
        }
      });
      return server;
    },
    /** wire terms_digest of commercial_terms given as attributes (what the seller signs) */
    termsDigest: (terms) => boundTermsDigest(binding, terms),
    publish: (change) => inner.publish(change),
    transport: inner.transport,
    /** The transport a caller of `tenant` reaches: the boundary resolves the tenant, then gates. */
    transportFor(tenant) {
      const identity = { tenant };
      const enabled = new Set(X.filter((b) => enabledFor(identity).has(b.attribute)).map((b) => refKey(b.uri, b.digest)));
      return {
        async call(name, request) {
          const owner = contributed.get(name);
          if (owner && !enabled.has(refKey(owner.uri, owner.digest))) throw new SellerRejection('UNSUPPORTED_TASK', name);
          const res = await inner.transport.call(name, request, identity);
          if (name === 'get_adcp_capabilities') res.declared_extensions = res.declared_extensions.filter((d) => !keysOf(binding).includes(refKey(d.uri, d.digest)) || enabled.has(refKey(d.uri, d.digest)));
          return res;
        },
        subscribe: inner.transport.subscribe,
      };
    },
  };
  return server;
}
