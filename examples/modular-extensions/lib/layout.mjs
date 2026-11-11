// The final layout as this example uses it: layer names, roles, and the rules the
// layering test checks. Source: the final layout in analysis/final ("The rules").
//
//   core, kernel-types        the kernel layer (kernel + kernel types)
//   <module>                  a standard module, or the compliance-testing leaf
//   buying/<layer>            one of buying's eight layers, each with its own version and digest
//   _assembly                 generated assembly files
//   _compat                   the 3.x compatibility assembly: legacy formats that 4.0 already slates for removal
//   x-<extension>             a file the layout places in an extension (a bridge or an older extension)

export const KERNEL = 'core';
export const KERNEL_TYPES = 'kernel-types';
export const ASSEMBLY = '_assembly';
export const COMPAT = '_compat';
/** An assembly composes modules by definition: the generated `_assembly`, and the 3.x compatibility assembly `_compat`. */
export const isAssembly = (layer) => layer.startsWith('_');

export const STANDARD_MODULES = ['buying', 'creative', 'governance', 'reporting', 'accounts', 'signals', 'identity', 'sponsored-intelligence', 'trusted-match'];
export const LEAF = 'compliance-testing';

// Buying's layers, bottom up, and the layers each one may $ref (direct and below).
// Pricing and catalogs are siblings, and so are offer and execution.
export const BUYING_LAYERS = ['targeting', 'pricing', 'catalogs', 'commitment', 'supply', 'offer', 'execution', 'delivery'];
export const BUYING_DIRECT_DEPS = {
  targeting: [],
  pricing: ['targeting'],
  catalogs: ['targeting'],
  commitment: ['pricing'],
  supply: ['commitment', 'catalogs'],
  offer: ['supply'],
  execution: ['supply'],
  delivery: ['execution'],
};
export const SIBLINGS = [
  ['pricing', 'catalogs'],
  ['offer', 'execution'],
];
/** Opt-in layers: a seller may leave them undeclared. */
export const OPT_IN_LAYERS = ['catalogs', 'offer'];

/** Every layer below `layer`, transitively. */
export function buyingDeps(layer) {
  const out = new Set();
  const stack = [...(BUYING_DIRECT_DEPS[layer] ?? [])];
  while (stack.length) {
    const l = stack.pop();
    if (out.has(l)) continue;
    out.add(l);
    stack.push(...BUYING_DIRECT_DEPS[l]);
  }
  return BUYING_LAYERS.filter((l) => out.has(l));
}

export const isKernelLayer = (layer) => layer === KERNEL || layer === KERNEL_TYPES;
export const buyingLayerOf = (layer) => (layer?.startsWith('buying/') ? layer.slice('buying/'.length) : null);
/** The module a layer belongs to: `buying/pricing` -> `buying`; null for the kernel layer, the assembly, and extensions. */
export const moduleOf = (layer) =>
  isKernelLayer(layer) || isAssembly(layer) || layer.startsWith('x-') ? null : layer.split('/')[0];

export const roleOf = (layer) =>
  layer === KERNEL ? 'kernel' : layer === KERNEL_TYPES ? 'kernel-types' : isAssembly(layer) ? 'assembly' : layer.startsWith('x-') ? 'extension' : buyingLayerOf(layer) ? 'module-layer' : 'module';

/** A readable owner label: `core` -> `kernel (core)`, `buying/pricing` -> `buying (pricing layer)`. */
export const ownerLabel = (layer) =>
  layer === KERNEL ? 'kernel (core)' : buyingLayerOf(layer) ? `buying (${buyingLayerOf(layer)} layer)` : layer;

// The 14 bridge extensions: id -> [name, declaring module, other module]. Only the bridge $refs both modules,
// and it fills its extension points under the existing property names, so the bytes don't change.
export const BRIDGES = {
  C1: ['governance-checks-on-buying', 'governance', 'buying'],
  C2a: ['reliable-reporting-account-attachments', 'accounts', 'reporting'],
  C2b: ['reliable-reporting-delivery-revision', 'buying', 'reporting'],
  C3: ['creative-approvals-on-packages', 'buying', 'creative'],
  C4: ['format-declarations-on-products', 'buying', 'creative'],
  C5: ['creative-signal-fanout', 'creative', 'signals'],
  C6: ['audience-evidence-on-products', 'buying', 'signals'],
  C7a: ['content-artifacts-for-creative-evaluation', 'creative', 'governance'],
  C7b: ['content-artifacts-for-context-match', 'trusted-match', 'governance'],
  C8: ['account-details-on-buys', 'buying', 'accounts'],
  C9: ['account-details-on-creatives', 'creative', 'accounts'],
  C10: ['creative-delivery-metrics', 'creative', 'buying'],
  C11: ['format-snapshots-for-context-match', 'trusted-match', 'buying'],
  C12: ['creative-manifests-for-context-match', 'trusted-match', 'creative'],
};
// Older extensions and the module whose extension point each one fills.
export const OTHER_EXTENSIONS = {
  'response-signing-jws': ['identity'],
  'spot-lifecycle': ['buying'],
  'adcp-ext-namespace': ['buying'],
  'aao-verification-token': [],
};
/** Modules an extension layer (`x-<name>`) may $ref: both ends of a bridge, or the module an older extension extends. */
export function extensionEnds(layer) {
  const name = layer.slice('x-'.length);
  const bridge = Object.values(BRIDGES).find(([n]) => n === name);
  return bridge ? [bridge[1], bridge[2]] : OTHER_EXTENSIONS[name] ?? [];
}

// ------------------------------------------------------------------ $ref occurrences and the layout checks

/** JSON pointer -> readable property path: /properties/a/items/properties/b -> a[].b (as analysis/final prints it). */
export function propPath(ptr) {
  const parts = ptr === '/' || ptr === '' ? [] : ptr.replace(/^\//, '').split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if ((p === 'properties' || p === 'patternProperties') && i + 1 < parts.length) {
      out.push(parts[++i].replace(/~1/g, '/').replace(/~0/g, '~'));
    } else if ((p === '$defs' || p === 'definitions') && i + 1 < parts.length) {
      out.push('#' + parts[++i]);
    } else if (p === 'items' || p === 'prefixItems') {
      if (out.length) out[out.length - 1] += '[]';
      else out.push('[]');
    } else if (p === 'additionalProperties') out.push('{*}');
  }
  return out.join('.') || '(root)';
}

// Core $refs are host-relative (/schemas/...); the "every core $ref stays inside core" lint checks the rest.
const fileOfRef = (ref) => {
  const target = ref.split('#')[0];
  return target.startsWith('/schemas/') ? target.slice('/schemas/'.length) : null;
};

/**
 * Every $ref between two distinct core files: [{ src, dst, pointer, path, experimental, point? }]. Files are
 * relative to core/schemas. `point` is the nearest enclosing `x-adcp-bridge-point` annotation: the extension
 * point that a bridge (or an older extension) fills under the existing property name. The 3.4 build assembles
 * the host schema from that extension, so a $ref under the point belongs to the extension, not to the host.
 */
export function refOccurrences(schemas) {
  const out = [];
  for (const { id, schema } of schemas) {
    const src = id.replace(/^\/schemas\//, '');
    const walk = (node, ptr, exp, point) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${ptr}/${i}`, exp, point));
      if (!node || typeof node !== 'object') return;
      if (node['x-status'] === 'experimental') exp = true;
      if (node['x-adcp-bridge-point']) point = { ...node['x-adcp-bridge-point'], at: ptr || '/' };
      if (typeof node.$ref === 'string') {
        const dst = fileOfRef(node.$ref);
        if (dst && dst !== src) out.push({ src, dst, pointer: ptr || '/', path: propPath(ptr || '/'), experimental: exp, ...(point ? { point } : {}) });
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${ptr}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, exp, point);
    };
    walk(schema, '', schema?.['x-status'] === 'experimental', null);
  }
  return out;
}

/**
 * Classify one $ref between layers under the final layout's rules. Returns null when the $ref is allowed, or
 * the check it breaks: `star` (module -> another module), `kernel` (kernel layer -> a module or extension),
 * `layer` (a buying layer -> a layer outside its dependencies), `sibling` (between pricing and catalogs, or
 * offer and execution), `extension-point` (module -> extension file, legal only at a declared extension point),
 * or `extension` (an extension -> a module it doesn't connect, or another extension).
 */
export function classifyRef(from, to) {
  if (from === to || isAssembly(from) || isAssembly(to)) return null; // an assembly composes modules by definition
  if (isKernelLayer(from)) return isKernelLayer(to) ? null : 'kernel';
  if (isKernelLayer(to)) return null;
  const mFrom = moduleOf(from);
  const mTo = moduleOf(to);
  if (mFrom && mTo) {
    if (mFrom !== mTo) return 'star';
    const la = buyingLayerOf(from);
    const lb = buyingLayerOf(to);
    if (!la || !lb || buyingDeps(la).includes(lb)) return null;
    return SIBLINGS.some(([a, b]) => (a === la && b === lb) || (a === lb && b === la)) ? 'sibling' : 'layer';
  }
  if (mFrom && to.startsWith('x-')) return 'extension-point';
  if (from.startsWith('x-') && mTo) return extensionEnds(from).includes(mTo) ? null : 'extension';
  if (from.startsWith('x-') && to.startsWith('x-')) return 'extension';
  return null;
}

/**
 * Every $ref that breaks a layout rule: [{ check, src, dst, path, from, to, experimental }], sorted.
 * A $ref under a bridge point counts from the extension that fills it, and the point must sit in a module
 * that extension connects (check `bridge-point` otherwise).
 */
export function layoutViolations(schemas, owner) {
  const out = [];
  for (const r of refOccurrences(schemas)) {
    let from = owner[r.src];
    const to = owner[r.dst];
    if (!from || !to) throw new Error(`${r.src} -> ${r.dst}: no layer`);
    let check = null;
    if (r.point) {
      const ext = `x-${r.point.extension}`;
      const bridge = r.point.bridge ? BRIDGES[r.point.bridge] : null;
      const named = r.point.bridge ? bridge?.[0] === r.point.extension : r.point.extension in OTHER_EXTENSIONS;
      if (!named || !extensionEnds(ext).includes(moduleOf(from))) check = 'bridge-point';
      else from = ext;
    }
    check ??= classifyRef(from, to);
    if (check) out.push({ check, src: r.src, dst: r.dst, path: r.path, pointer: r.pointer, from, to, ...(r.experimental ? { experimental: true } : {}) });
  }
  const key = (v) => [v.check, v.from, v.to, v.src, v.dst, v.path].join('\u0000');
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export const violationKey = (v) => `${v.src} -> ${v.dst} @ ${v.path}`;
