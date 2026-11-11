#!/usr/bin/env node
// Copy the $ref closure of a few real AdCP core schemas, byte for byte, from a
// protocol checkout into core/upstream/. Nothing here is edited: the proposed
// core changes live in core/patches.json and are applied by build-core.mjs.
//
//   ADCP_SRC=/path/to/adcp node scripts/vendor-core.mjs
//   node scripts/vendor-core.mjs                       (reads the adcp repo this example lives in)
//   node scripts/vendor-core.mjs --placement-only     (re-map the files already vendored)
//
// Run once; the result is checked into the example so it runs without the
// protocol repo. It also writes core/placement.json: the layer that owns each
// vendored file, from the final layout (analysis/final/raw/placement-final-v2.json):
// the kernel (`core`), kernel types, the generated assembly, the nine standard
// modules, each of buying's eight layers as its own layer (`buying/<layer>`),
// the compliance-testing leaf, and `x-<name>` for a file the layout places in
// an extension. --placement-only rewrites core/placement.json from the files
// listed in core/UPSTREAM.json and copies nothing, so the vendored bytes stay
// at their commit.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Default: the adcp repo root, two levels up from this example (examples/modular-extensions).
const ADCP_SRC = process.env.ADCP_SRC ?? path.resolve(ROOT, '../..');
const SOURCE = path.join(ADCP_SRC, 'static/schemas/source');
const OUT = path.join(ROOT, 'core/upstream');

// The core surfaces this example touches. Everything they $ref comes along.
export const ROOTS = [
  '/schemas/pricing-options/cpm-option.json',
  '/schemas/pricing-options/cpp-option.json',
  '/schemas/media-buy/commercial-terms.json',
  '/schemas/protocol/get-adcp-capabilities-response.json',
  '/schemas/core/platform-extension-ref.json',
  '/schemas/core/format-option-ref.json',
  '/schemas/core/duration.json',
  '/schemas/core/ext.json',
  // Proposal-based buying (the creator scenario): request_proposals -> refine -> accept -> get_media_buys.
  // get_products stays for discovery-time pricing options (its proposals are legacy core/proposal.json).
  '/schemas/media-buy/get-products-request.json',
  '/schemas/media-buy/request-proposals-request.json',
  '/schemas/media-buy/request-proposals-response.json',
  '/schemas/media-buy/refine-proposals-request.json',
  '/schemas/media-buy/accept-proposal-request.json',
  '/schemas/core/canonical-proposal.json',
  '/schemas/media-buy/get-media-buys-response.json',
  '/schemas/core/account-change.json',
  // Pricing as an open union (the hook design): the pricing-option union, and products, so a
  // seller can scope a pricing model to a channel and the buyer can check it.
  '/schemas/core/pricing-option.json',
  '/schemas/core/product.json',
];

// Which layer owns each file: the final layout. analysis/run_all.sh regenerates this file
// (adcp main @ad1f380f8c; every vendored path exists there, and the placement is by path).
// Each entry is { label, reason, ... }; only `label` is read.
const PLACEMENT = process.env.ADCP_PLACEMENT ?? path.join(ROOT, 'analysis/final/raw/placement-final-v2.json');

// The 3.x compatibility assembly (`_compat`). The legacy get_products product and its signal targeting
// option listings $ref the signals module; those $refs leave only with removals 4.0 already slates (the
// 3.x compatibility facades). Like the generated capabilities assembly, the compatibility assembly
// composes modules by definition, so it isn't a module; 4.0 removes it. The layout places these files in
// buying (supply and targeting); this example lists them here, with the layout's fix for each.
export const COMPAT_ASSEMBLY = {
  'core/product.json': 'legacy get_products product (products[] of the get_products facade); its included_signals[] embeds signal listings; slated for removal in 4.0 with the 3.x compatibility facades',
  'core/product-signal-targeting-option.json': 'signal targeting option listing on the legacy product; slated for removal in 4.0 with the 3.x compatibility facades',
};
export const COMPAT = '_compat';

/** Layout label -> layer name in this example. The kernel keeps its name `core`; a buying layer is `buying/<layer>`. */
export function layerOfLabel(label) {
  if (label === 'kernel') return 'core';
  if (label === 'kernel-types') return 'kernel-types';
  if (label === 'assembly') return '_assembly';
  if (label.startsWith('module:')) return label.slice('module:'.length); // module:buying/pricing -> buying/pricing
  if (label.startsWith('extension:')) return `x-${label.slice('extension:'.length)}`; // a file the layout places in an extension
  throw new Error(`no layer for layout label ${label}`);
}

function* refsOf(node) {
  if (Array.isArray(node)) for (const v of node) yield* refsOf(v);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('/schemas/')) yield v.split('#')[0];
      else yield* refsOf(v);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
const placementOnly = process.argv.includes('--placement-only');
let files;
let commit;
if (placementOnly) {
  ({ files, commit } = JSON.parse(readFileSync(path.join(ROOT, 'core/UPSTREAM.json'), 'utf8')));
} else {
  const seen = new Set();
  const stack = [...ROOTS];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const doc = JSON.parse(readFileSync(path.join(SOURCE, id.slice('/schemas/'.length)), 'utf8'));
    stack.push(...refsOf(doc));
  }
  rmSync(OUT, { recursive: true, force: true });
  files = {};
  for (const id of [...seen].sort()) {
    const rel = id.slice('/schemas/'.length);
    const bytes = readFileSync(path.join(SOURCE, rel));
    mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
    writeFileSync(path.join(OUT, rel), bytes);
    files[rel] = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  }
  commit = execFileSync('git', ['-C', ADCP_SRC, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
const placement = JSON.parse(readFileSync(PLACEMENT, 'utf8'));
const entryOf = (rel) => {
  const e = placement[rel];
  if (!e) throw new Error(`${rel}: no placement in ${PLACEMENT}`);
  if (e.label === 'retire') throw new Error(`${rel}: the layout retires this file, but a vendored schema still $refs it`);
  return e;
};
const layers = Object.fromEntries(Object.keys(files).map((rel) => [rel, rel in COMPAT_ASSEMBLY ? COMPAT : layerOfLabel(entryOf(rel).label)]));
writeFileSync(
  path.join(ROOT, 'core/placement.json'),
  JSON.stringify(
    {
      source: 'analysis/final/raw/placement-final-v2.json (the final layout; analysis/run_all.sh regenerates it)',
      labels: 'layout label -> layer: kernel -> core, kernel-types -> kernel-types, assembly -> _assembly, module:<m> -> <m>, module:buying/<l> -> buying/<l>, extension:<x> -> x-<x>; the files in compat_assembly -> _compat',
      compat_assembly: Object.fromEntries(Object.entries(COMPAT_ASSEMBLY).map(([f, why]) => [f, { layout_label: entryOf(f).label, why }])),
      layers,
    },
    null,
    2
  ) + '\n'
);
if (!placementOnly) {
  writeFileSync(
    path.join(ROOT, 'core/UPSTREAM.json'),
    JSON.stringify({ source: 'adcontextprotocol/adcp static/schemas/source', commit, roots: ROOTS, files }, null, 2) + '\n'
  );
}
console.log(`${placementOnly ? 'mapped' : 'vendored'} ${Object.keys(files).length} schema files from ${commit.slice(0, 10)} into ${new Set(Object.values(layers)).size} layers`);
}
