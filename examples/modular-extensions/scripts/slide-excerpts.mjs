#!/usr/bin/env node
// Exact excerpts for the deep-dive slides, taken from the built files and from a real run.
//
//   node scripts/slide-excerpts.mjs     -> analysis/slide-excerpts.json, analysis/slide-excerpts.md
//
// Every excerpt is cut from a file this example builds (core/schemas/, packages/*/dist/bundle.json,
// spec.md, conformance/*.yaml) or from a payload the mock sellers and the buyer SDK exchange in
// this run. Trimming only removes: a long string ends in "…", an omitted key or array item is a
// line "…", and a digest shows its first 12 hex digits and "…". Nothing is added or reworded.
// Each excerpt stays at 36 lines or fewer; the script fails otherwise. Payloads are real nested JSON, and every
// omitted key or item is a "…" at its own place.
// Run it with --experimental-strip-types (npm run analysis does): it drives the sales agent's
// generated layer, which is TypeScript.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdcpClient } from '../lib/client.mjs';
import { createBuyerValidator } from '../lib/buyer-validator.mjs';
import { createCreatorNetworkSeller } from '../lib/mock-seller.mjs';
import { RATE_CARD, createTvSeller } from '../lib/mock-tv-seller.mjs';
import { createAdcpServer } from '../lib/server.mjs';
import { layerDigests, placement } from './build-core.mjs';
import { buildSdk, printResult } from './adcp-sdk.mjs';
import { runConformance } from './run-conformance.mjs';
import { runRelease } from './module-release.mjs';
import { CREATOR_NETWORK_MODULES } from '../lib/mock-seller.mjs';
import { TV_SELLER_MODULES } from '../lib/mock-tv-seller.mjs';
import * as F from '../fixtures/payloads.mjs';
import { tasks as makegoodTasks } from '../packages/ext-makegood-units/src/index.mjs';

const makegoodTask = makegoodTasks.requestMakegood;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'analysis');
const MAX_LINES = Number(process.env.EXCERPT_MAX_LINES ?? 36);
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const owner = placement();
/** An array marked as cut: the rendering adds a "…" item (before the items when lead is true). */
const cutArray = (items, { lead = false } = {}) => Object.assign([...items], { [ELIDED]: true, ...(lead ? { [LEAD]: true } : {}) });

// ---- trimming and rendering --------------------------------------------------------

const ELIDED = Symbol('elided');
const LEAD = Symbol('lead'); // on an array: the omitted items come before the ones shown
const CUT = Symbol.for('cut'); // a value that is cut entirely: renders as a bare …
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Paths for cutTo from 'a/b/0/c' strings (digits are array indexes; '…' keeps a key and cuts its value). */
const P = (...ps) => ps.map((p) => p.split('/').map((x) => (/^\d+$/.test(x) ? Number(x) : x === '…' ? CUT : x)));

// A cut inside an object: a key with this prefix renders as a bare "…" line, at the place of the keys it omits.
const GAP = '\u0000gap';
let gapSeq = 0;
const gapKey = () => `${GAP}${gapSeq++}`;
const isGap = (k) => k.startsWith(GAP);

/** A copy of obj with only `keys`, in the object's own order; each run of omitted keys is one "…" at its place. */
function pick(obj, keys) {
  const out = {};
  let gap = false;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k) && obj[k] !== undefined) {
      if (gap) out[gapKey()] = CUT;
      gap = false;
      out[k] = obj[k];
    } else gap = true;
  }
  if (gap) out[gapKey()] = CUT;
  return out;
}

/**
 * The real nested JSON of `node`, cut to the given paths (arrays of keys and indexes; [] keeps the whole
 * node). Order is the node's own; each run of omitted keys or items shows as one "…" at its place.
 */
function cutTo(node, paths) {
  if (paths.some((p) => p.length === 0)) return node;
  if (paths.some((p) => p[0] === CUT)) return CUT; // keep the key, cut its value
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    const out = [];
    let gap = false;
    node.forEach((v, i) => {
      const sub = paths.filter((p) => p[0] === i).map((p) => p.slice(1));
      if (!sub.length) return void (gap = true);
      if (gap) out.push(CUT);
      gap = false;
      out.push(cutTo(v, sub));
    });
    if (gap) out.push(CUT);
    return out;
  }
  const out = {};
  let gap = false;
  for (const [k, v] of Object.entries(node)) {
    const sub = paths.filter((p) => p[0] === k).map((p) => p.slice(1));
    if (!sub.length) {
      gap = true;
      continue;
    }
    if (gap) out[gapKey()] = CUT;
    gap = false;
    out[k] = cutTo(v, sub);
  }
  if (gap) out[gapKey()] = CUT;
  return out;
}

/** Shorten strings and arrays, and drop the named keys (for example descriptions); mark what was cut. */
function shorten(v, { maxStr = 90, maxItems = 3, drop = [] } = {}) {
  if (v === CUT) return v;
  if (typeof v === 'string') {
    if (DIGEST.test(v)) return `${v.slice(0, 19)}…`;
    v = v.replace(/sha256:([a-f0-9]{12})[a-f0-9]{52}/g, 'sha256:$1…');
    return v.length > maxStr ? `${v.slice(0, maxStr).trimEnd()}…` : v;
  }
  if (Array.isArray(v)) {
    const out = v.slice(0, maxItems).map((x) => shorten(x, { maxStr, maxItems, drop }));
    if (v.length > maxItems || v[ELIDED]) out[ELIDED] = true;
    if (v[LEAD]) out[LEAD] = true;
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    let last = null;
    for (const [k, x] of Object.entries(v)) {
      if (drop.includes(k) || isGap(k)) {
        if (!(last && isGap(last))) out[(last = gapKey())] = CUT;
      } else out[(last = k)] = shorten(x, { maxStr, maxItems, drop });
    }
    if (v[ELIDED]) out[ELIDED] = true;
    return out;
  }
  return v;
}

function inline(v) {
  if (v === CUT) return '…';
  if (Array.isArray(v)) {
    const items = v.map(inline);
    return `[${(v[ELIDED] ? (v[LEAD] ? ['…', ...items] : [...items, '…']) : items).join(', ')}]`;
  }
  if (v && typeof v === 'object') {
    const items = Object.entries(v).map(([k, x]) => (isGap(k) ? '…' : `${JSON.stringify(k)}: ${inline(x)}`));
    if (v[ELIDED]) items.push('…');
    return items.length ? `{ ${items.join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

const WIDTH = 124;
function render(v, indent = 0, prefix = 0) {
  const pad = '  '.repeat(indent);
  const one = inline(v);
  if (pad.length + prefix + one.length <= WIDTH || v === null || typeof v !== 'object') return one;
  const inner = '  '.repeat(indent + 1);
  if (Array.isArray(v)) {
    const items = v.map((x) => inner + render(x, indent + 1));
    if (v[ELIDED]) v[LEAD] ? items.unshift(`${inner}…`) : items.push(`${inner}…`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const items = Object.entries(v).map(([k, x]) => (isGap(k) ? `${inner}…` : `${inner}${JSON.stringify(k)}: ${render(x, indent + 1, JSON.stringify(k).length + 2)}`));
  if (v[ELIDED]) items.push(`${inner}…`);
  return `{\n${items.join(',\n')}\n${pad}}`;
}

/** One excerpt: a titled, sourced, trimmed snippet. Throws if it is longer than MAX_LINES. */
function excerpt(title, source, value, { lang = 'json', note, maxStr, maxItems, drop } = {}) {
  const text = typeof value === 'string' ? value : render(shorten(value, { maxStr, maxItems, drop }));
  const lines = text.split('\n').length;
  if (lines > MAX_LINES) throw new Error(`excerpt "${title}" has ${lines} lines (max ${MAX_LINES}); trim it`);
  return { title, source, lang, text, lines, ...(note ? { note } : {}) };
}

/** A core schema file as built, with the layer that owns it. */
const coreSource = (rel, pointer) => ({ file: `core/schemas/${rel}`, ...(pointer ? { pointer } : {}), layer: owner[rel] });
const core = (rel) => readJson(`core/schemas/${rel}`);

/** Raw lines of a text file from a heading/line match to the next block, trimmed with "…". */
function textBlock(rel, startRe, endRe, { maxLines = 14 } = {}) {
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`${rel}: no line matches ${startRe}`);
  let end = lines.findIndex((l, i) => i > start && endRe.test(l));
  if (end < 0) end = lines.length;
  let block = lines.slice(start, end);
  while (block.length && block.at(-1).trim() === '') block.pop();
  if (block.length > maxLines) block = [...block.slice(0, maxLines - 1), block[0].match(/^\s*/)[0] + '…'];
  return { text: block.join('\n'), line: start + 1 };
}

// ---- the extensions --------------------------------------------------------------

const PKG = {
  sat: 'ext-seller-adjustable-terms',
  mg: 'ext-makegood-units',
  ltv: 'ext-linear-tv-indexed-cpp',
  rc: 'ext-rate-card-index',
};
const bundle = (key) => readJson(`packages/${PKG[key]}/dist/bundle.json`);
const lockOf = (key) => readJson(`packages/${PKG[key]}/extension.lock.json`);
const ns = (key) => {
  const lock = lockOf(key);
  return { EXTENSION_URI: lock.uri, EXTENSION_DIGEST: lock.digest, EXTENSION_MODULE_DIR: pathToFileURL(path.join(ROOT, 'packages', PKG[key]) + '/') };
};

/** The manifest excerpt: identity, hooks (extends), requires, and the docs pins. */
function manifestExcerpt(key, title) {
  const b = bundle(key);
  const m = b['x-adcp-extension'];
  const X = 'x-adcp-extension';
  const value = cutTo(b, [
    ['$id'],
    ...P(`${X}/name`, `${X}/version`, `${X}/requires/core`, `${X}/requires/points`, `${X}/docs/spec`, `${X}/docs/conformance/0`, `${X}/docs/reference_code`),
    ...m.extends.flatMap((e, i) => (e.branch ? ['point', 'branch', 'definition', 'reports_as'] : ['point', 'definition', 'must_understand']).map((k) => [X, 'extends', i, k])),
  ]);
  return excerpt(title, { file: `packages/${PKG[key]}/dist/bundle.json`, pointer: '/x-adcp-extension', digest: lockOf(key).digest }, value, {
    note: `docs pins spec.md, ${m.docs.conformance.length} storyboard(s), and index.mjs; the bundle digest covers all of them`,
  });
}

/** One definition of the extension schema, as published in the bundle. */
function definitionExcerpt(key, name, keys, opts = {}) {
  const def = bundle(key).definitions[name];
  const value = cutTo(bundle(key), keys ? keys.filter((k) => k in def).map((k) => ['definitions', name, k]) : [['definitions', name]]);
  return excerpt(`Extension schema: definitions.${name}`, { file: `packages/${PKG[key]}/dist/bundle.json`, pointer: `/definitions/${name}` }, value, { drop: ['description'], ...opts });
}

/** A spec rule and the storyboard step that covers it, with the step's result from this run. */
function ruleExcerpts(key, ruleId, storyboardFile, stepId, conformance) {
  const specRel = `packages/${PKG[key]}/spec.md`;
  const rule = textBlock(specRel, new RegExp(`^#### ${ruleId}:`), /^#{1,4} /, { maxLines: 12 });
  const sbRel = `packages/${PKG[key]}/${storyboardFile}`;
  const step = textBlock(sbRel, new RegExp(`^\\s+- (\\{ )?id: ${stepId}\\b`), /^\s{6}- (\{ )?id: |^\s{2}- id: /, { maxLines: 14 });
  const ext = conformance.extensions.find((e) => e.name === bundle(key)['x-adcp-extension'].name);
  const sb = ext.storyboards.find((s) => s.file === storyboardFile);
  const st = sb.steps.find((s) => s.id === stepId);
  if (!st.covers.includes(ruleId)) throw new Error(`${storyboardFile} ${stepId} does not cover ${ruleId}`);
  const r = ext.rules.find((x) => x.id === ruleId);
  return [
    excerpt(`Spec rule ${ruleId}`, { file: specRel, line: rule.line, sha256: bundle(key)['x-adcp-extension'].docs.spec.sha256 }, rule.text, { lang: 'markdown', note: `level ${r.level}; status in this run: ${r.status}` }),
    excerpt(`Storyboard step ${sb.id} / ${stepId} (covers ${ruleId})`, { file: sbRel, line: step.line }, step.text, { lang: 'yaml', note: `result in this run: ${st.status}; storyboard ${sb.ok ? 'passed' : 'failed'} (${sb.steps.filter((s) => s.status === 'passed').length}/${sb.steps.length} steps)` }),
  ];
}

/** A transport that records every wire call. */
function recorded(transport) {
  const calls = [];
  return {
    calls,
    transport: {
      async call(task, request) {
        const response = await transport.call(task, request);
        calls.push({ task, request: structuredClone(request), response: structuredClone(response) });
        return response;
      },
      subscribe: (fn) => transport.subscribe(fn),
    },
  };
}
const lastCall = (calls, task) => [...calls].reverse().find((c) => c.task === task);
const brand = { domain: 'brand.example.com' };
let seq = 0;
const proposalRequest = (brief) => ({ idempotency_key: `slides-request-${String(++seq).padStart(4, '0')}-aaaa`, brief, brand });
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

// ---- the kernel's generic mechanism -----------------------------------------------

function kernelExcerpts() {
  const hook = core('core/extension-hook.json');
  const decl = core('core/extension-declaration.json');
  const env = core('core/version-envelope.json');
  const err = core('core/error.json');
  const nt = core('enums/notification-type.json');
  const caps = core('protocol/get-adcp-capabilities-response.json');
  const entry = core('core/extension-entry.json');
  const branch = core('core/extension-branch-id.json');
  return {
    id: 'kernel',
    title: "The kernel's generic mechanism (no module named)",
    excerpts: [
      excerpt('Hook-annotation vocabulary: ExtensionPoint and OpenUnion', coreSource('core/extension-hook.json', '/definitions'), cutTo(hook, P('ExtensionPoint/properties/name', 'ExtensionPoint/properties/must_understand', 'ExtensionPoint/properties/order', 'ExtensionPoint/properties/identity', 'ExtensionPoint/required', 'OpenUnion/properties/name', 'OpenUnion/properties/discriminator', 'OpenUnion/properties/body', 'OpenUnion/properties/identity', 'OpenUnion/properties/must_understand', 'OpenUnion/properties/unknown_in_list', 'OpenUnion/required', 'MustUnderstand/enum').map((p) => ['definitions', ...p])), { maxStr: 60, drop: ['description'] }),
      excerpt('Kernel schema: ExtensionEntry', coreSource('core/extension-entry.json'), pick(entry, ['$id', 'type', 'properties', 'required', 'additionalProperties']), { maxStr: 70 }),
      excerpt('Kernel branch id: ExtensionBranchId', coreSource('core/extension-branch-id.json'), pick(branch, ['$id', 'type', 'pattern', 'maxLength'])),
      excerpt('Declaration: ExtensionDeclaration (the kernel\'s two hooks: the `capabilities` extension point and the `task` union)', coreSource('core/extension-declaration.json'), cutTo(decl, [['$id'], ...P('properties/uri', 'properties/digest'), ...['points', 'capabilities', 'tasks'].flatMap((k) => ['type', 'items', 'x-adcp-extension-point'].map((x) => ['properties', k, x])), ['required']]), { maxStr: 60 }),
      excerpt('Kernel hook: the task union (ExtensionTask), how an extension adds a task', coreSource('core/extension-declaration.json', '/definitions/ExtensionTask'), cutTo(decl, P('definitions/ExtensionTask/x-adcp-open-union', 'definitions/ExtensionTask/properties', 'definitions/ExtensionTask/required')), { maxStr: 60, drop: ['description'] }),
      excerpt('Declaration in the assembled capabilities response (kernel fragment)', coreSource('protocol/get-adcp-capabilities-response.json', '/properties/declared_extensions'), cutTo(caps, P('properties/declared_extensions')), { maxStr: 90 }),
      excerpt('Request side: understood_extensions on the version envelope', coreSource('core/version-envelope.json', '/properties/understood_extensions'), cutTo(env, P('properties/understood_extensions')), { maxStr: 120 }),
      excerpt('Module-owned registries: the error code stays an open string in the kernel', coreSource('core/error.json', '/properties/code'), cutTo(err, P('properties/code/type', 'properties/code/maxLength', 'properties/code/description')), { maxStr: 150 }),
      excerpt(
        'Module-owned registries: notification types from four owners in one list',
        coreSource('enums/notification-type.json', '/enum'),
        cutTo(nt, nt.enum.map((v, i) => (/^(account\.change_recorded|creative\.status_changed|reporting\.delivery_ready|product\.priced)$/.test(v) ? ['enum', i] : null)).filter(Boolean)),
        { maxStr: 150, note: 'Four of the enum values, in file order, from four owners (by prefix, inference): creative, accounts (change feed), buying (supply layer), reporting. The final layout places this file in the generated assembly; module-owned registries make such lists open strings that modules register values into. The prototype does not generate these registries' }
      ),
    ],
  };
}

// ---- modules: a module minor release, and the modules map in capabilities ----------------

/** Lines of a run log from the first line starting with `from` up to (not including) the first line after it starting with `to`. */
function logBlock(log, from, to) {
  const start = log.findIndex((l) => l.startsWith(from));
  if (start < 0) throw new Error(`release log: no line starts with ${from}`);
  let end = to ? log.findIndex((l, i) => i > start && l.startsWith(to)) : log.length;
  if (end < 0) end = log.length;
  return log.slice(start, end).join('\n');
}

function releaseExcerpts() {
  const specRel = 'core/releases/buying-pricing-1.1.json';
  const spec = readJson(specRel);
  const r = runRelease(path.join(ROOT, specRel));
  const x = runRelease(path.join(ROOT, specRel), { refused: true });
  if (!r.released || x.released) throw new Error('module release: the release must ship and the refused edit must be refused (npm run release:pricing)');
  const run = 'node scripts/module-release.mjs core/releases/buying-pricing-1.1.json (npm run release:pricing), on a scratch copy of this example';
  return {
    id: 'release',
    title: 'Module release: buying/pricing 1.0 -> 1.1, an additive minor of one buying layer',
    flow_note: 'A real run on a scratch copy: the release adds one optional property to a file buying/pricing owns, the core build reports which layers moved, the additive check runs over the layer, the release is re-stamped, every extension is rebuilt, and two apps are regenerated. test/module-release.test.mjs asserts the same.',
    excerpts: [
      excerpt('The release: one layer, one minor version, one additive patch', { file: specRel }, pick(spec, ['layer', 'from', 'to', 'patches']), { maxStr: 70, drop: ['$comment'] }),
      excerpt('The core build with the old stamps: only buying/pricing moved', { run }, logBlock(r.log, 'build with the old stamps', 'additive check'), { lang: 'text' }),
      excerpt('The additive check over the layer passes', { run }, logBlock(r.log, 'additive check', 'core/release.json'), { lang: 'text' }),
      excerpt('core/release.json after the re-stamp: one layer moved', { run }, logBlock(r.log, 'core/release.json', 'extensions rebuilt'), { lang: 'text' }),
      excerpt('Every extension rebuilt against the 1.1 release: the same digests', { run }, logBlock(r.log, 'extensions rebuilt', 'apps regenerated'), { lang: 'text' }),
      excerpt('Two apps regenerated: the governance-only app is byte-identical', { run }, logBlock(r.log, 'apps regenerated', 'creator network'), { lang: 'text' }),
      excerpt('A seller at minor version 1.1, checked against both apps', { run }, logBlock(r.log, 'creator network'), { lang: 'text' }),
      excerpt('A non-additive edit is refused: the same field made required', { run: `${run}, with the release's refused patches` }, x.log.join('\n'), { lang: 'text' }),
    ],
  };
}

async function modulesExcerpts() {
  const caps = core('protocol/get-adcp-capabilities-response.json');
  const seller = createCreatorNetworkSeller();
  const wire = recorded(seller.transport);
  const client = await createAdcpClient({ transport: wire.transport, lockfile: path.join(ROOT, 'examples/buyer-app/adcp.lock.json') });
  const checked = await client.capabilities();
  const capsWire = lastCall(wire.calls, 'get_adcp_capabilities').response;
  const gov = readJson('test/apps/governance-only/adcp.lock.json');
  const govClient = await createAdcpClient({ transport: createCreatorNetworkSeller().transport, lockfile: path.join(ROOT, 'test/apps/governance-only/adcp.lock.json') });
  const govChecked = await govClient.capabilities();

  const rewriting = (edit) => {
    const s = createCreatorNetworkSeller();
    return { ...s.transport, call: async (t, q) => { const res = await s.transport.call(t, q); if (t === 'get_adcp_capabilities') edit(res.modules); return res; } };
  };
  const outcome = async (transport, task) => {
    const c = await createAdcpClient({ transport, lockfile: path.join(ROOT, 'examples/buyer-app/adcp.lock.json') });
    const cap = await c.capabilities();
    const e = await errorOf(() => c.requestProposals(proposalRequest('Two sponsored YouTube integrations with a cooking creator in March')));
    const entry = cap.moduleCheck.entries.find((x) => x.name === task);
    return { [task]: entry, 'moduleCheck.ok': cap.moduleCheck.ok, request_proposals: e ? `refused before the call: ${e.code}` : 'sent' };
  };
  const newer = await outcome(rewriting((m) => (m['buying/pricing'] = { version: '1.1', digest: m['buying/pricing'].digest.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })), 'buying/pricing');
  const major = await outcome(rewriting((m) => (m['buying/pricing'] = { ...m['buying/pricing'], version: '2.0' })), 'buying/pricing');
  const tv = createTvSeller({ modules: TV_SELLER_MODULES.filter((m) => m !== 'buying/offer') });
  const noOffer = await outcome(tv.transport, 'buying/offer');
  const pickEntries = (entries, names) => cutArray(entries.filter((e) => names.includes(e.name)));
  return {
    id: 'modules',
    title: 'The modules map: module and layer versions in get_adcp_capabilities, checked against the app lock',
    flow_note: `The map is optional and additive, in the kernel's fragment of the generated capabilities response (core/patches.json, layer _assembly). The mock sellers list the buying layers they implement (${CREATOR_NETWORK_MODULES.length} for the creator network); the buyer client checks each entry against the module versions its lock pins. test/modules.test.mjs asserts the same.`,
    excerpts: [
      excerpt('Kernel capabilities fragment: the optional modules map', coreSource('protocol/get-adcp-capabilities-response.json', '/properties/modules'), cutTo(caps, P('properties/modules')), { maxStr: 100 }),
      excerpt('Wire: the creator network lists the buying layers it implements', { run: 'get_adcp_capabilities from the creator network (lib/mock-seller.mjs)' }, { ...pick(capsWire, ['adcp', 'supported_protocols', 'modules']), declared_extensions: CUT }, { maxStr: 60, maxItems: 8 }),
      excerpt('The client checks each entry against the app lock (the buyer app pins the whole bundle)', { run: 'client.capabilities() with examples/buyer-app/adcp.lock.json' }, { 'moduleCheck.ok': checked.moduleCheck.ok, 'moduleCheck.entries': pickEntries(checked.moduleCheck.entries, ['buying/offer', 'buying/pricing', 'buying/catalogs', 'governance']) }, { maxItems: 8 }),
      excerpt('A governance-only app pins the kernel layer and governance, not the bundle', { file: 'test/apps/governance-only/adcp.lock.json' }, { core: gov.core, extensions: gov.extensions }),
      excerpt('The same seller, checked against the governance-only app', { run: 'client.capabilities() with test/apps/governance-only/adcp.lock.json' }, { 'moduleCheck.ok': govChecked.moduleCheck.ok, 'moduleCheck.entries': pickEntries(govChecked.moduleCheck.entries, ['governance', 'buying/offer', 'buying/pricing']) }, { maxItems: 8 }),
      excerpt('A minor ahead is compatible; another major, or a missing layer, refuses request_proposals', { run: 'client.capabilities(), then client.requestProposals(), against three sellers' }, { 'seller lists buying/pricing 1.1': newer, 'seller lists buying/pricing 2.0': major, 'seller lists no buying/offer': noOffer }, { maxStr: 100 }),
    ],
  };
}

// ---- (a) and (b): the creator slip and the make-good ---------------------------------

async function creatorExamples(conformance) {
  const seller = createCreatorNetworkSeller();
  const rec = recorded(seller.transport);
  const violations = [];
  const client = await createAdcpClient({ transport: rec.transport, extensions: [ns('sat'), ns('mg')], onViolation: (v) => violations.push(v.message) });
  const { proposals: [draft] } = await client.requestProposals(proposalRequest('Two sponsored YouTube integrations with a cooking creator in March'));
  const { proposals: [committed] } = await client.refineProposals({ idempotency_key: 'slides-finalize-0001-aa', refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
  const { media_buy_id } = await client.acceptProposal({ proposal: committed, idempotency_key: 'slides-accept-0001-aaaa', account: { account_id: 'acc_brand_example' } });
  const reqWire = lastCall(rec.calls, 'request_proposals').request;
  const acceptWire = lastCall(rec.calls, 'accept_proposal').request;

  const changes = [];
  seller.transport.subscribe((c) => changes.push(c));
  seller.ops.creatorUnavailable(media_buy_id, 0, 5);
  const afterSlip = (await client.getMediaBuys({ media_buy_ids: [media_buy_id] })).media_buys[0];
  // Video 2 can't be made: the buyer asks for the make-good under its rule (the task makegood-units contributes).
  await client.callTask(makegoodTask, { media_buy_id, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed', idempotency_key: 'slides-makegood-0001' });
  const afterMg = (await client.getMediaBuys({ media_buy_ids: [media_buy_id] })).media_buys[0];
  const mgReport = client.lastReport;
  seller.ops.rogueShift(media_buy_id, 0, 4);
  await client.getMediaBuys({ media_buy_ids: [media_buy_id] });

  // A buyer with no extensions, and a seller that ignores understood_extensions.
  const plain = await createAdcpClient({ transport: createCreatorNetworkSeller().transport });
  const plainRes = await plain.requestProposals(proposalRequest('Two sponsored YouTube integrations'));
  const leaky = await createAdcpClient({ transport: createCreatorNetworkSeller({ ignoreUnderstood: true }).transport });
  const leakErr = await errorOf(() => leaky.requestProposals(proposalRequest('Two sponsored YouTube integrations')));
  const leakErrors = leaky.lastReport.errors;

  const SAT = lockOf('sat');
  const MG = lockOf('mg');
  const satEntry = committed.commercial_terms.extensions.find((t) => t.uri === SAT.uri);
  const mgEntry = committed.commercial_terms.extensions.find((t) => t.uri === MG.uri);
  const ct = core('media-buy/commercial-terms.json');
  const mbs = core('media-buy/get-media-buys-response.json');
  const hostCommercial = excerpt('Host schema: commercial_terms extension point (owner: buying/commitment)', coreSource('media-buy/commercial-terms.json', '/properties/extensions'), cutTo(ct, P('$id', 'properties/extensions', 'additionalProperties')), { maxStr: 110 });
  const hostReadback = excerpt('Host schema: media_buy_state extension point (owner: buying/execution)', coreSource('media-buy/get-media-buys-response.json', '/properties/media_buys/items/properties/extensions_state'), cutTo(mbs, P('$id', 'properties/media_buys/items/properties/extensions_state')), { maxStr: 110 });
  const entrySchema = excerpt('Kernel schema: ExtensionEntry', coreSource('core/extension-entry.json'), pick(core('core/extension-entry.json'), ['$id', 'properties', 'required', 'additionalProperties']), { maxStr: 60 });
  const requestWire = excerpt('Wire: request_proposals request (the SDK adds understood_extensions)', { run: 'client.requestProposals -> transport request_proposals' }, reqWire, { maxItems: 4 });
  const withoutCommon = {
    plain: excerpt('Buyer without the extensions: the seller projects the terms', { run: 'request_proposals with no understood_extensions -> response.proposals[0].commercial_terms (it has no extensions key)' }, cutTo(plainRes.proposals[0].commercial_terms, [...plainRes.proposals[0].commercial_terms.purchases.flatMap((_, i) => P(`purchases/${i}/product_id`, `purchases/${i}/budget`, `purchases/${i}/start_time`, `purchases/${i}/pricing/pricing_model`, `purchases/${i}/pricing/fixed_price`)), ['total_budget']]), { maxItems: 2, maxStr: 70 }),
  };

  const slip = {
    id: 'a',
    title: '(a) Creator slip: seller-adjustable-terms, a pre-agreed time shift',
    hooks: ['commercial_terms (extension point, always, order uri; owner buying/commitment)', 'media_buy_state (extension point, never; owner buying/execution)'],
    excerpts: [
      hostCommercial,
      hostReadback,
      entrySchema,
      manifestExcerpt('sat', 'Extension manifest (inside the digest): seller-adjustable-terms'),
      definitionExcerpt('sat', 'TimeShiftConstraint', null, { maxStr: 70 }),
      ...ruleExcerpts('sat', 'SAT-R11', 'conformance/04-applied.yaml', 'read_back_dispute', conformance),
      requestWire,
      excerpt('Wire: committed proposal, the allowance in commercial_terms.extensions', { run: 'refine_proposals finalize -> proposals[0]' }, (() => {
        const i = committed.commercial_terms.extensions.indexOf(satEntry);
        const a = satEntry.data.allowances.findIndex((x) => x.allowance_id === 'slip_v1_start');
        return cutTo(committed, P('proposal_id', 'proposal_status', `commercial_terms/extensions/${i}/uri`, `commercial_terms/extensions/${i}/digest`, `commercial_terms/extensions/${i}/data/allowances/${a}`));
      })(), { note: 'The other allowances, the other entry, and the rest of the terms are cut.' }),
      excerpt('Wire: accept_proposal request (the SDK recomputed terms_digest)', { run: 'client.acceptProposal -> transport accept_proposal' }, acceptWire),
      excerpt('Readback: get_media_buys after the 5-day slip', { run: 'seller ops.creatorUnavailable(mb, 0, 5); client.getMediaBuys' }, (() => {
        const st = afterSlip.extensions_state.find((x) => x.uri === SAT.uri);
        const i = afterSlip.extensions_state.indexOf(st);
        const a = st.data.applied.findIndex((x) => x.allowance_id === 'slip_v1_start');
        return cutTo(afterSlip, [...P('packages/0/package_id', 'packages/0/start_time'), ...['allowance_id', 'revision', 'change_id', 'previous_value', 'value'].map((k) => ['extensions_state', i, 'data', 'applied', a, k]), ...P(`extensions_state/${i}/uri`, `extensions_state/${i}/digest`)]);
      })(), { maxItems: 3, note: 'get_media_buys response, media_buys[0]. The change feed record of the same shift: change_id ' + changes[0].change_id + ', resource_revision ' + changes[0].resource_revision + ', reason ' + changes[0].reason }),
      excerpt('Readback past the allowance: the SDK reports a violation (onViolation)', { run: 'seller ops.rogueShift(mb, 0, 4); client.getMediaBuys' }, violations.join('\n'), { lang: 'text' }),
      withoutCommon.plain,
      excerpt('Seller sends the allowance anyway: the buyer SDK fails closed', { run: 'request_proposals from a seller that ignores understood_extensions' }, {
        code: leakErr.code,
        errors: leakErrors.filter((e) => e.message.includes(SAT.uri)).map((e) => pick(e, ['code', 'path', 'message'], { all: true })),
      }, { maxStr: 220 }),
    ],
  };

  const issued = afterMg.extensions_state.find((s) => s.uri === MG.uri);
  const makegood = {
    id: 'b',
    title: '(b) Creator make-good: makegood-units, a capped zero-cost replacement',
    hooks: ['commercial_terms (extension point, always, order uri; owner buying/commitment)', 'media_buy_state (extension point, never; owner buying/execution)'],
    excerpts: [
      hostCommercial,
      hostReadback,
      entrySchema,
      manifestExcerpt('mg', 'Extension manifest (inside the digest): makegood-units'),
      definitionExcerpt('mg', 'MakegoodRule', ['type', 'properties', 'required'], { maxStr: 60, maxItems: 7 }),
      ...ruleExcerpts('mg', 'MG-R9', 'conformance/04-readback.yaml', 'over_cap', conformance),
      requestWire,
      excerpt('Wire: committed proposal, the make-good rule in commercial_terms.extensions', { run: 'refine_proposals finalize -> proposals[0]' }, (() => {
        const i = committed.commercial_terms.extensions.indexOf(mgEntry);
        return cutTo(committed, P('proposal_id', 'proposal_status', `commercial_terms/extensions/${i}/uri`, `commercial_terms/extensions/${i}/digest`, `commercial_terms/extensions/${i}/data/rules/1`));
      })(), { note: 'The other rule, the other entry, and the rest of the terms are cut.' }),
      excerpt('Readback: get_media_buys after the missed video', { run: 'client.callTask(request_makegood) for video 2; client.getMediaBuys -> media_buys[0]' }, (() => {
        const i = afterMg.extensions_state.indexOf(issued);
        const pk = afterMg.packages.map((p, j) => [p, j]).filter(([p]) => p.package_id !== 'pkg_video_1');
        return cutTo(afterMg, [
          ...pk.flatMap(([p, j]) => (p.canceled ? ['package_id', 'budget', 'canceled'] : ['package_id', 'budget', 'start_time']).map((k) => ['packages', j, k])),
          ...P(`extensions_state/${i}/uri`, `extensions_state/${i}/digest`),
          ...issued.data.issued.flatMap((_, u) => ['makegood_id', 'rule_id', 'revision', 'change_id', 'package_id', 'reason'].map((k) => ['extensions_state', i, 'data', 'issued', u, k])),
        ]);
      })(), { note: 'The buyer SDK reports this readback entry at /media_buys/0/extensions_state/' + afterMg.extensions_state.indexOf(issued) + ' as understood (media_buy_state)' }),
      withoutCommon.plain,
      excerpt('Seller sends the make-good rule anyway: the buyer SDK fails closed', { run: 'request_proposals from a seller that ignores understood_extensions' }, {
        code: leakErr.code,
        errors: leakErrors.filter((e) => e.message.includes(MG.uri)).map((e) => pick(e, ['code', 'path', 'message'], { all: true })),
      }, { maxStr: 220 }),
    ],
  };
  makegood.excerpts.push(
    excerpt('Wire: one commercial_terms.extensions list, two entries, each with its own data', { run: 'refine_proposals finalize -> proposals[0]' }, cutTo(committed, committed.commercial_terms.extensions.flatMap((e, i) => [['commercial_terms', 'extensions', i, 'uri'], ['commercial_terms', 'extensions', i, 'digest'], ['commercial_terms', 'extensions', i, 'data', Object.keys(e.data)[0], CUT]])), { note: 'Both entries sit in the same extensions array of the same signed terms; each data holds its own extension\'s fields (cut here).' })
  );
  return [slip, makegood];
}

// ---- (c) the linear-TV indexed-CPP pricing model --------------------------------------

async function pricingModelExample(conformance) {
  const seller = createTvSeller();
  const rec = recorded(seller.transport);
  const violations = [];
  const tv = await createAdcpClient({ transport: rec.transport, extensions: [ns('ltv')], onViolation: (v) => violations.push(v.message) });
  const res = await tv.requestProposals(proposalRequest('Prime time 25-54 in March'));
  const reqWire = lastCall(rec.calls, 'request_proposals').request;
  const branchReport = tv.lastReport.extensions.find((e) => e.point === 'pricing_model' && e.path.startsWith('/proposals'));
  const { proposals: [committed] } = await tv.refineProposals({ idempotency_key: 'slides-finalize-tv-0001', refinements: [{ proposal_id: res.proposals[0].proposal_id, action: 'finalize' }] });
  const { media_buy_id } = await tv.acceptProposal({ proposal: committed, idempotency_key: 'slides-accept-tv-0001-a', account: { account_id: 'acc_brand_example' } });
  seller.ops.fixMarketIndex(media_buy_id, 0.96);
  const mb = (await tv.getMediaBuys({ media_buy_ids: [media_buy_id] })).media_buys[0];
  const readReport = tv.lastReport;
  const invoice = seller.ops.invoice(media_buy_id, 104.1);

  const plain = await createAdcpClient({ transport: createTvSeller().transport });
  const plainRes = await plain.requestProposals(proposalRequest('Prime time 25-54 in March'));
  const leaky = await createAdcpClient({ transport: createTvSeller({ ignoreUnderstood: true }).transport });
  const leakErr = await errorOf(() => leaky.requestProposals(proposalRequest('Prime time 25-54 in March')));

  const opt = core('pricing-options/extension-option.json');
  const cpo = core('core/canonical-pricing-option.json');
  const purchase = committed.commercial_terms.purchases[0];
  return {
    id: 'c',
    title: '(c) Linear-TV indexed CPP: a pricing model core lacks, as a branch of the pricing_model open union',
    hooks: ['pricing_model (open union; branch always must-understand; unknown_in_list drop_option; owner buying/pricing)', 'media_buy_state (extension point, never; owner buying/execution)', 'capabilities (kernel extension point on ExtensionDeclaration)'],
    excerpts: [
      excerpt('Host schema: the generic branch, annotated as the pricing_model union (owner: buying/pricing)', coreSource('pricing-options/extension-option.json'), cutTo(opt, P('$id', 'x-adcp-open-union', 'properties/pricing_option_id', 'properties/pricing_model', 'properties/currency', 'properties/extension_model', 'required', 'not')), { drop: ['description'], maxItems: 5 }),
      excerpt('Host schema: the accepted pricing (canonical), widened and annotated (owner: buying/pricing)', coreSource('core/canonical-pricing-option.json'), cutTo(cpo, [...P('properties/pricing_model/anyOf', 'properties/extension_model', 'x-adcp-open-union/name', 'x-adcp-open-union/body'), ...['if', 'then', 'else'].map((k) => ['allOf', cpo.allOf.length - 1, k])]), { maxItems: 4, drop: ['description'], note: 'pricing_model.anyOf[0] is the upstream enum, untouched (op widen); allOf keeps its five upstream rules and gains the last one. The annotation is the same as on extension-option.json.' }),
      excerpt('Kernel schema: ExtensionBranchId', coreSource('core/extension-branch-id.json'), pick(core('core/extension-branch-id.json'), ['type', 'pattern', 'maxLength']), { maxStr: 70, drop: ['description'] }),
      manifestExcerpt('ltv', 'Extension manifest (inside the digest): linear-tv-indexed-cpp'),
      excerpt('Extension schema: definitions.IndexedCpp and MarketIndex', { file: `packages/${PKG.ltv}/dist/bundle.json`, pointer: '/definitions' }, cutTo(bundle('ltv').definitions, P('IndexedCpp/type', 'IndexedCpp/required', 'IndexedCpp/properties/base_price', 'IndexedCpp/properties/indices', 'IndexedCpp/properties/market_index', 'IndexedCpp/properties/ceiling_price', 'MarketIndex/type', 'MarketIndex/required', 'MarketIndex/properties/fixed_at', 'MarketIndex/properties/floor', 'MarketIndex/properties/cap')), { drop: ['description'], maxItems: 6 }),
      ...ruleExcerpts('ltv', 'LTV-R12', 'conformance/04-model-and-fixing.yaml', 'read_back_dispute', conformance),
      excerpt('Wire: request_proposals request', { run: 'client.requestProposals -> transport request_proposals' }, reqWire),
      excerpt('Wire: committed proposal, the branch as the purchase pricing', { run: 'refine_proposals finalize -> proposals[0].commercial_terms.purchases[0]' }, cutTo(purchase, [['budget'], ...Object.keys(purchase.pricing).filter((k) => k !== 'extension_model').map((k) => ['pricing', k]), ...P('pricing/extension_model/uri', 'pricing/extension_model/digest', 'pricing/extension_model/data/base_price', 'pricing/extension_model/data/market_index', 'pricing/extension_model/data/ceiling_price')]), { maxStr: 120, note: `The buyer SDK reports the branch as ${branchReport.status}, with the warning: ${branchReport.warnings[0]}` }),
      excerpt('Readback: the market index fixed after booking, and the invoice', { run: 'seller ops.fixMarketIndex(mb, 0.96); client.getMediaBuys; ops.invoice(mb, 104.1)' }, {
        extensions_state: mb.extensions_state,
        'buyer report': readReport.extensions.map((e) => `${e.point}${e.branch ? `#${e.branch}` : ''} ${e.status}`),
        invoice,
      }, { note: 'The buyer report lines are the run\'s report entries rendered as `point#branch status`' }),
      excerpt('Buyer without the extension: core cpp at the published index', { run: 'request_proposals with no understood_extensions -> response' }, cutTo(plainRes, [...plainRes.products[0].pricing_options.flatMap((_, i) => ['pricing_option_id', 'pricing_model', 'fixed_price'].map((k) => ['products', 0, 'pricing_options', i, k])), ...P('proposals/0/commercial_terms/purchases/0/budget', 'proposals/0/commercial_terms/purchases/0/pricing/pricing_option_id', 'proposals/0/commercial_terms/purchases/0/pricing/pricing_model', 'proposals/0/commercial_terms/purchases/0/pricing/currency', 'proposals/0/commercial_terms/purchases/0/pricing/fixed_price')])),
      excerpt('Seller sends the branch anyway: dropped from the option list, rejected in signed terms', { run: 'request_proposals from a seller that ignores understood_extensions' }, {
        code: leakErr.code,
        warnings: leaky.lastReport.warnings.map((w) => pick(w, ['code', 'path'], { all: true })),
        dropped: leaky.lastReport.dropped,
        errors: leaky.lastReport.errors.map((e) => pick(e, ['code', 'path', 'message'], { all: true })),
      }, { maxStr: 220 }),
    ],
  };
}

// ---- (d) the rate card as an ignorable explanation -------------------------------------

async function rateCardExample(conformance) {
  const seller = createTvSeller();
  const rec = recorded(seller.transport);
  const buyer = await createAdcpClient({ transport: rec.transport, extensions: [ns('rc')] });
  const { products } = await buyer.getProducts({ buying_mode: 'brief', brief: 'Prime time 25-54 in March' });
  const report = buyer.lastReports[0];
  const reqWire = lastCall(rec.calls, 'get_products').request;
  const option = products[0].pricing_options[0];
  const card = report.extensions.find((e) => e.uri === RATE_CARD.uri);

  const plainSeller = recorded(createTvSeller().transport);
  const plain = await createAdcpClient({ transport: plainSeller.transport });
  const plainProducts = (await plain.getProducts({ buying_mode: 'brief', brief: 'Prime time 25-54 in March' })).products;
  const plainValidator = createBuyerValidator();
  const leaked = plainValidator.validate('/schemas/pricing-options/cpp-option.json', option);
  const flagged = structuredClone(option);
  flagged.extensions[0].must_understand = true;
  const flaggedReport = plainValidator.validate('/schemas/pricing-options/cpp-option.json', flagged);
  const signed = plainValidator.validate('/schemas/media-buy/commercial-terms.json', F.commercialTerms());

  const cpp = core('pricing-options/cpp-option.json');
  return {
    id: 'd',
    title: '(d) Rate card as an ignorable explanation: rate-card-index on a core cpp quote (get_products discovery)',
    hooks: ['pricing_option (extension point, flag; owner buying/pricing)', 'commercial_terms (extension point, always; owner buying/commitment) for the signed copy'],
    flow_note: 'This example keeps get_products: the point is a discovery-time pricing option, and the pricing_option extension point exists only on the core-model option files that get_products products carry. Canonical pricing options in request_proposals have no such extension point.',
    excerpts: [
      excerpt('Host schema: pricing_option extension point on the core cpp option (owner: buying/pricing)', coreSource('pricing-options/cpp-option.json', '/properties/extensions'), cutTo(cpp, P('$id', 'properties/pricing_model', 'properties/extensions')), { maxStr: 120 }),
      excerpt('Kernel schema: ExtensionEntry (must_understand read at flag hooks)', coreSource('core/extension-entry.json', '/properties/must_understand'), cutTo(core('core/extension-entry.json'), P('properties/must_understand')), { maxStr: 200 }),
      manifestExcerpt('rc', 'Extension manifest (inside the digest): rate-card-index'),
      definitionExcerpt('rc', 'RateCard', ['type', 'properties', 'required'], { maxStr: 50, maxItems: 4 }),
      ...ruleExcerpts('rc', 'RC-R2', 'conformance/01-discovery.yaml', 'get_products', conformance),
      excerpt('Wire: get_products request (discovery)', { run: 'client.getProducts -> transport get_products' }, reqWire),
      excerpt('Wire: the cpp option, quote plus explanatory card', { run: 'get_products -> products[0].pricing_options[0]' }, cutTo(option, [
        ...P('pricing_option_id', 'pricing_model', 'currency', 'fixed_price'),
        ...[0, 1].flatMap((j) => ['kind', 'name', 'amount'].map((k) => ['price_breakdown', 'adjustments', j, k])),
        ...P('extensions/0/uri', 'extensions/0/digest', 'extensions/0/data/base_price', 'extensions/0/data/premium_basis'),
        ...[0, 1].flatMap((j) => ['kind', 'name', 'factor', 'points'].map((k) => ['extensions', 0, 'data', 'rows', j, k])),
      ]), { maxStr: 60, note: `The buyer SDK evaluates the card: status ${card.status}, must_understand ${card.must_understand}, evaluated price ${card.evaluation.price}` }),
      excerpt('Buyer without the extension: the seller drops the optional card; fixed_price binds', { run: 'get_products with no understood_extensions -> products[0].pricing_options[0] (it has no extensions key)' }, pick(plainProducts[0].pricing_options[0], ['pricing_option_id', 'pricing_model', 'fixed_price', 'extensions'])),
      excerpt('Seller sends the card anyway: ignored; flagged or signed: fail closed', { run: 'buyer validator with no modules on the leaked option, the flagged option, and signed commercial_terms (fixtures/payloads.mjs)' }, {
        'as sent (optional)': { ok: leaked.ok, status: leaked.extensions[0].status, note: leaked.extensions[0].note ?? null },
        'must_understand: true': { ok: flaggedReport.ok, codes: [...new Set(flaggedReport.errors.map((e) => e.code))] },
        'signed copy in commercial_terms': { ok: signed.ok, errors: signed.errors.filter((e) => e.message.includes(RATE_CARD.uri)).map((e) => pick(e, ['code', 'path'], { all: true })) },
      }, { maxStr: 120 }),
    ],
  };
}

// ---- the developer journey: (a) add parameters to an existing task, (b) add a task ----------

/** Mark the lines of `full` that `base` lacks with "+", the others with a space: a line diff of two real renderings. */
function markAdded(full, base) {
  const a = base.split('\n');
  const b = full.split('\n');
  const L = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  // A line that only gains a trailing comma (because a key follows it now) is not an added line.
  const same = (x, y) => x.replace(/,$/, '') === y.replace(/,$/, '');
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = same(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && same(a[i], b[j])) {
      out.push(`  ${b[j]}`);
      i++;
      j++;
    } else if (i < a.length && L[i + 1][j] >= L[i][j + 1]) i++;
    else out.push(`+ ${b[j++]}`);
  }
  return out.join('\n');
}

/** A payload excerpt with the parts a base payload lacks marked "+" (both are real; the trim applies to both). */
function addedExcerpt(title, source, full, base, { note, ...opts } = {}) {
  const r = (v) => render(shorten(v, opts));
  return excerpt(title, source, markAdded(r(full), r(base)), { lang: 'diff', note: `Lines marked + are what the extension adds; the other lines are the same payload without it.${note ? ` ${note}` : ''}` });
}

/**
 * Lines of a source file, from the first line matching `from` through the first later line matching
 * `to` (inclusive; an array of patterns is matched in sequence). `skip` lists [from, to] pairs of
 * inner lines to cut; each cut shows as one "…" line.
 */
function sourceExcerpt(title, rel, from, to, { skip = [], lang = 'ts', note } = {}) {
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  const start = lines.findIndex((l) => from.test(l));
  if (start < 0) throw new Error(`${rel}: no line matches ${from}`);
  let end = start;
  for (const re of [].concat(to)) {
    end = lines.findIndex((l, i) => i >= end && re.test(l));
    if (end < 0) throw new Error(`${rel}: no line after ${start + 1} matches ${re}`);
  }
  let block = lines.slice(start, end + 1).map((text, k) => ({ text, n: start + k }));
  for (const [a, z] of skip) {
    const s = block.findIndex((x) => a.test(x.text));
    const e = block.findIndex((x, k) => k >= s && z.test(x.text));
    if (s < 0 || e < 0) throw new Error(`${rel}: skip ${a} .. ${z} not found`);
    block = [...block.slice(0, s), { text: `${block[s].text.match(/^\s*/)[0]}…` }, ...block.slice(e + 1)];
  }
  const indent = Math.min(...block.filter((x) => x.text.trim()).map((x) => x.text.match(/^\s*/)[0].length));
  return excerpt(title, { file: rel, line: start + 1 }, block.map((x) => x.text.slice(indent)).join('\n'), { lang, note });
}

// The layers whose hooks makegood-units uses: the kernel (task), commitment (commercial_terms), execution (media_buy_state).
const MG_LAYERS = ['core', 'buying/commitment', 'buying/execution'];

async function journeyExcerpts(conformance) {
  const before = layerDigests();
  const release = readJson('core/release.json');
  const MG = lockOf('mg');
  // A generated layer with makegood-units only: the sales agent's (examples/sales-agent/adcp-sdk/).
  const layer = await import(pathToFileURL(path.join(ROOT, 'examples/sales-agent/adcp-sdk/index.ts')).href);

  // One buyer on that layer, one with no extension; both buy from the creator network.
  const seller = createCreatorNetworkSeller();
  const rec = recorded(seller.transport);
  const client = await layer.createClient({ transport: rec.transport });
  const caps = await client.capabilities();
  const flow = async (c, tag) => {
    // The same request from both buyers, so the two payloads differ only in what the SDK adds.
    const { proposals: [draft] } = await c.requestProposals({ idempotency_key: 'slides-journey-request-0001', brief: 'Two sponsored YouTube integrations with a cooking creator in March', brand });
    const { proposals: [committed] } = await c.refineProposals({ idempotency_key: `slides-journey-finalize-${tag}`, refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }] });
    const { media_buy_id } = await c.acceptProposal({ proposal: committed, idempotency_key: `slides-journey-accept-${tag}-a`, account: { account_id: 'acc_brand_example' } });
    return { committed, media_buy_id };
  };
  const { media_buy_id } = await flow(client, 'mg');
  const committed = lastCall(rec.calls, 'refine_proposals').response.proposals[0]; // the wire form
  const proposalsWire = lastCall(rec.calls, 'request_proposals').request;
  // Journey (b) runs on the same creator buy as the worked examples, so every id means one event in both decks:
  // a buyer on the buyer app's layer (both extensions) buys, the seller slips video 1 by 5 days (chg_4,
  // revision 2), and then the buyer asks for the make-good for video 2 (mg_8, revision 3, chg_7).
  const buyerLayer = await import(pathToFileURL(path.join(ROOT, 'examples/buyer-app/adcp-sdk/index.ts')).href);
  const taskSeller = createCreatorNetworkSeller();
  const taskRec = recorded(taskSeller.transport);
  const taskClient = await buyerLayer.createClient({ transport: taskRec.transport });
  const taskCaps = await taskClient.capabilities();
  const { media_buy_id: taskBuy } = await flow(taskClient, 'task');
  taskSeller.ops.creatorUnavailable(taskBuy, 0, 5);
  const ask = { media_buy_id: taskBuy, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed' };
  await taskClient.requestMakegood({ ...ask, idempotency_key: 'slides-makegood-0001' });
  const taskCall = taskClient.lastTaskCall;
  await taskClient.requestMakegood({ ...ask, idempotency_key: 'slides-makegood-0002' });
  const taskWire = taskRec.calls.filter((c) => c.task === taskCall.name);
  await client.getMediaBuys({ media_buy_ids: [media_buy_id] });
  const after = layerDigests();

  const plainRec = recorded(createCreatorNetworkSeller().transport);
  const plain = await createAdcpClient({ transport: plainRec.transport });
  const { committed: plainCommitted } = await flow(plain, 'plain');
  const plainWire = lastCall(plainRec.calls, 'request_proposals').request;

  // The same extension declared by an agent that does not serve the task: the declaration without `tasks`.
  const noTask = createAdcpServer();
  noTask.declare({ uri: MG.uri, digest: MG.digest, version: MG.version, bytes: readFileSync(path.join(ROOT, 'packages', PKG.mg, 'dist/bundle.json')) });
  const capsNoTask = await noTask.transport.call('get_adcp_capabilities', {});

  const mgDecl = caps.declared_extensions.find((d) => d.uri === MG.uri);
  const mgDeclIndex = caps.declared_extensions.indexOf(mgDecl);
  const trimTerms = (ct) =>
    cutTo(ct, [
      ...P('brand', 'purchases/…', 'start_time', 'end_time', 'total_budget'),
      ...(ct.extensions ?? []).flatMap((_, i) => [...P(`extensions/${i}/uri`, `extensions/${i}/digest`), ...['rule_id', 'max_units', 'window', 'keep_same'].map((k) => ['extensions', i, 'data', 'rules', 1, k])]),
    ]);
  const digests = (title) =>
    excerpt(title, { run: 'scripts/build-core.mjs layerDigests() over core/schemas, before and after the run; core/release.json' }, {
      'core/release.json layers (hooks, digest)': Object.fromEntries(MG_LAYERS.map((l) => [l, pick(release.layers[l], ['hooks', 'digest'], { all: true })])),
      'layerDigests() before enabling makegood-units': pick(before, MG_LAYERS),
      'layerDigests() after a buyer and a seller enabled it and called request_makegood': pick(after, MG_LAYERS),
      [`all ${Object.keys(after).length} layers unchanged`]: JSON.stringify(after) === JSON.stringify(before) && Object.entries(after).every(([l, d]) => release.layers[l].digest === d),
      'core bundle digest': release.bundle_digest,
    }, { note: 'Computed in this run. test/contributed-task.test.mjs asserts the same, and the build fails with LAYER MOVED if any layer stops matching core/release.json.' });

  // The generate command, as a developer runs it: the same config, generated into a scratch copy.
  const generate = async (app) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adcp-slides-'));
    try {
      cpSync(path.join(ROOT, app, 'adcp.config.json'), path.join(dir, 'adcp.config.json'));
      const out = [`$ node scripts/adcp-sdk.mjs ${app}`];
      printResult(await buildSdk(dir), (line) => out.push(line));
      const check = await buildSdk(path.join(ROOT, app), { check: true });
      if (check.stale.length) throw new Error(`${app}: the generated layer is stale; run npm run sdk`);
      return out.join('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const configExcerpt = (title, app) => excerpt(title, { file: `${app}/adcp.config.json` }, readJson(`${app}/adcp.config.json`), { drop: ['$comment'], maxStr: 120 });

  const src = `packages/${PKG.mg}`;
  const schema = readJson(`${src}/schema.json`).definitions;
  const manifest = readJson(`${src}/extension.json`);

  const params = {
    id: 'journey-a',
    title: 'Developer journey (a): add parameters to an existing task (make-good rules in request_proposals)',
    journey: true,
    excerpts: [
      addedExcerpt('Step 1. The target payload: the request_proposals request', { run: 'client.requestProposals -> transport request_proposals, a buyer with makegood-units and a buyer with no extensions' }, proposalsWire, plainWire),
      addedExcerpt('Step 1. The target payload: commercial_terms in the committed proposal', { run: 'refine_proposals finalize -> proposals[0].commercial_terms, a buyer with makegood-units and a buyer with no extensions' }, trimTerms(committed.commercial_terms), trimTerms(plainCommitted.commercial_terms), { maxItems: 3 }),
      excerpt('Step 2. Declare it: the extension schema (schema.json)', { file: `${src}/schema.json`, pointer: '/definitions' }, cutTo(schema, P('MakegoodTerms/properties/rules/type', 'MakegoodTerms/properties/rules/items', 'MakegoodTerms/properties/rules/minItems', 'MakegoodTerms/required', 'MakegoodRule/properties/rule_id', 'MakegoodRule/properties/max_units', 'MakegoodRule/properties/window', 'MakegoodRule/properties/keep_same', 'MakegoodRule/properties/at_no_cost', 'MakegoodRule/required')), { drop: ['description'], maxItems: 3, note: '`window` reuses the kernel type Duration by its core URI.' }),
      excerpt('Step 2. Declare it: the manifest (extension.json) attaches at two extension points', { file: `${src}/extension.json` }, cutTo(manifest, [...P('id', 'version', 'requires'), ...manifest.extends.flatMap((e, i) => (e.point === 'task' ? [] : ['point', 'definition', 'must_understand'].map((k) => ['extends', i, k])))]), { note: 'The cut item is the task registration of journey (b).' }),
      ...ruleExcerpts('mg', 'MG-R9', 'conformance/04-readback.yaml', 'over_cap', conformance).map((e) => ({ ...e, title: `Step 2. Declare it: ${e.title[0].toLowerCase()}${e.title.slice(1)}` })),
      digests('Step 3. Why nothing else changes: kernel and buying-layer digests before and after'),
      excerpt('Step 4. Negotiation on the wire: the seller declares the extension (get_adcp_capabilities response)', { run: 'get_adcp_capabilities -> response' }, cutTo(caps, ['uri', 'digest', 'points'].map((k) => ['declared_extensions', mgDeclIndex, k]))),
      excerpt('Step 4. Negotiation on the wire: the buyer lists what it understands (request_proposals request)', { run: 'client.requestProposals -> request' }, cutTo(proposalsWire, P('understood_extensions')), { note: 'The digests match exactly, so the seller sends the rules to this buyer and omits them for a buyer that lists nothing.' }),
      configExcerpt('Step 5. Generated code: the app declares its extensions (adcp.config.json)', 'examples/buyer-app'),
      excerpt('Step 5. Generated code: one command generates the app\'s typed layer', { run: 'scripts/adcp-sdk.mjs on the buyer app\'s config (npm run sdk)' }, await generate('examples/buyer-app'), { lang: 'text', note: 'It resolves each range against the registry and the pinned core, locks the digests in adcp.lock.json, and writes adcp-sdk/. The core package is not touched.' }),
      sourceExcerpt('Step 5. Generated code: the extension data is a plain attribute at its extension point', 'examples/buyer-app/adcp-sdk/types.ts', /^\/\*\* commercial_terms \(extension point/, [/^export interface MediaBuyState/, /^}/], { note: 'The wire stays the envelope; the layer maps between the two and reports errors at wire locations (…/extensions/0/data/rules/0/max_units).' }),
      sourceExcerpt('Step 6. Seller code: set the attribute', 'examples/sales-agent/agent.ts', /^\s+\/\/ One free replacement per video/, /terms\.makegood_units = \{ rules:/, { skip: [[/^\s+function proposal\(/, /const \[first, second\]/]] }),
      sourceExcerpt('Step 6. Buyer code: read the attribute', 'examples/buyer-app/app.ts', /^\/\/ The buyer's own policy, written against typed extension data/, /^}/),
    ],
  };

  const taskEntry = manifest.extends.find((e) => e.point === 'task');
  const resp = schema.MakegoodAccepted;
  const task = {
    id: 'journey-b',
    title: 'Developer journey (b): add a task (request_makegood, an added MCP tool or A2A skill)',
    journey: true,
    excerpts: [
      (() => {
        const base = structuredClone(caps);
        base.declared_extensions[mgDeclIndex] = capsNoTask.declared_extensions[0];
        const cut = (c) => cutTo(c, ['uri', 'digest', 'points', 'tasks'].map((k) => ['declared_extensions', mgDeclIndex, k]));
        return addedExcerpt('Step 1. The target payload: the seller declares the task in its capabilities', { run: 'get_adcp_capabilities response from a seller that serves the task, and from one that declares the extension but serves no task' }, cut(caps), cut(base));
      })(),
      excerpt(`Step 1. The target payload: the contributed task on the wire, ${taskCall.name}`, { run: `the creator buy after the 5-day slip of video 1: client.requestMakegood twice -> transport ${taskCall.name}` }, {
        [`${taskCall.name} request`]: taskWire[0].request,
        response: taskWire[0].response,
        'a second request for the same rule (new idempotency_key): response': taskWire[1].response,
      }, { maxStr: 70, note: 'The extension contributes the whole task; no kernel or module task changes. status is the kernel task status, by $ref. The request is the task\'s arguments, with no envelope: the task id the seller declared already names uri@digest.' }),
      excerpt('Step 2. Declare it: the request schema (schema.json)', { file: `${src}/schema.json`, pointer: '/definitions/MakegoodRequest' }, cutTo(schema, ['type', 'properties', 'required', 'additionalProperties'].map((k) => ['MakegoodRequest', k])), { drop: ['description'], maxItems: 6 }),
      excerpt('Step 2. Declare it: the response schema (schema.json)', { file: `${src}/schema.json`, pointer: '/definitions' }, cutTo(schema, [['MakegoodResponse', 'oneOf'], ...['status', 'outcome'].map((k) => ['MakegoodAccepted', 'properties', k]), ['MakegoodAccepted', 'required'], ...P('MakegoodRejected/properties/rejection/properties/code')]), { drop: ['description'], maxItems: 8, maxStr: 60 }),
      excerpt('Step 2. Declare it: the manifest (extension.json) registers a branch of the kernel task union', { file: `${src}/extension.json` }, cutTo(manifest, [['requires', 'points'], ...['point', 'branch', 'definition', 'response'].map((k) => ['extends', manifest.extends.indexOf(taskEntry), k])]), { note: 'The task id is the extension uri, "#", and the branch: https://extensions.adcontextprotocol.org/makegood-units#request_makegood.' }),
      ...ruleExcerpts('mg', 'MG-R20', 'conformance/05-request-makegood.yaml', 'over_cap', conformance).map((e) => ({ ...e, title: `Step 2. Declare it: ${e.title[0].toLowerCase()}${e.title.slice(1)}` })),
      excerpt("Step 3. Why nothing else changes: the kernel's generic task union", coreSource('core/extension-declaration.json', '/definitions/ExtensionTask'), cutTo(core('core/extension-declaration.json'), P('properties/tasks/type', 'properties/tasks/items', 'definitions/ExtensionTask/x-adcp-open-union', 'definitions/ExtensionTask/properties', 'definitions/ExtensionTask/required')), { drop: ['description'], note: 'Generic: it names no extension and no task. Any extension adds a task as one more branch.' }),
      digests('Step 3. Why nothing else changes: kernel and buying-layer digests before and after'),
      excerpt('Step 4. Negotiation on the wire: the seller maps its transport name to the task id (get_adcp_capabilities response)', { run: 'get_adcp_capabilities -> response' }, cutTo(caps, [['declared_extensions', mgDeclIndex, 'tasks']]), { maxStr: 100 }),
      excerpt('Step 4. The buyer SDK resolves the task id to the transport name it calls', { run: 'client.capabilities -> negotiation; client.requestMakegood' }, {
        'negotiation.tasks (usable uri@digest only)': taskCaps.negotiation.tasks,
        'transport name it called': taskCall,
      }, { maxStr: 100, note: 'Client state from this run, not a wire message.' }),
      configExcerpt('Step 5. Generated code: the agent declares the extension (adcp.config.json)', 'examples/sales-agent'),
      excerpt('Step 5. Generated code: one command generates the agent\'s typed layer', { run: 'scripts/adcp-sdk.mjs on the sales agent\'s config (npm run sdk)' }, await generate('examples/sales-agent'), { lang: 'text', note: 'The task comes with the extension: no separate declaration.' }),
      sourceExcerpt('Step 5. Generated code: a typed client method and a typed handler per task', 'examples/sales-agent/adcp-sdk/types.ts', /^\/\*\* The tasks this app's extensions contribute/, /^export type Server = /, { note: 'BoundServer.handle(task, handler) takes the request and response types from Tasks (lib/binding.d.mts). The task id and the descriptor come from the extension package (src/index.ts).' }),
      sourceExcerpt('Step 6. Seller code: the typed handler', 'examples/sales-agent/agent.ts', /^\s+\/\/ The contributed task: request and response types come from/, /return \{ status: 'completed', outcome: 'accepted'/, { skip: [[/^\s+\/\/ Cancel the missed video/, /^\s+buy\.packages\.push/]] }),
      sourceExcerpt('Step 6. Buyer code: call the task', 'examples/buyer-app/app.ts', /^\/\/ request_makegood is a typed method of this app's client/, /a second request under the same rule/),
    ],
  };
  return [params, task];
}

// ---- output ---------------------------------------------------------------------------

function markdown(doc) {
  const out = [
    '# Slide excerpts: the developer journey, the four worked examples, and module releases',
    '',
    `Generated by \`scripts/slide-excerpts.mjs\` on ${doc.generated_at} from the built files and a real run (core bundle \`${doc.core.bundle_digest.slice(0, 19)}…\`, ${doc.core.layers} layers, the final layout). Every excerpt is cut, never rewritten: a long string ends in "…", an omitted key or item is a "…" line, and a digest shows 12 hex digits. Each is ${MAX_LINES} lines or fewer.`,
    '',
    'Flow: `request_proposals` (canonical proposal with `commercial_terms` and `terms_digest`) -> `refine_proposals` finalize -> `accept_proposal`. Example (d) uses `get_products`, because a discovery-time pricing option is its point.',
    '',
    'The two developer-journey sections walk the same six steps for (a) adding parameters to an existing task and (b) adding a task: 1. the target payload; 2. declare it (schema, manifest, rules); 3. why nothing else changes; 4. negotiation on the wire; 5. generated code: the app lists the extension in adcp.config.json, runs one command, and gets its own typed layer (the generated binding); 6. seller code and buyer code, which read and write plain attributes and call the task as a typed method. In a `diff` excerpt, lines marked `+` are what the extension adds: the same payload, rendered from a run without the extension, lacks them. A source-code excerpt is a contiguous cut of the named file; `…` marks a cut.',
    '',
    '## Contents',
    '',
    ...doc.sections.map((s) => `- [${s.title}](#${s.title.toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/ /g, '-')})`),
    '',
  ];
  for (const s of doc.sections) {
    out.push(`## ${s.title}`, '');
    if (s.hooks) out.push(`Hooks: ${s.hooks.map((h) => `\`${h.split(' ')[0]}\` ${h.slice(h.indexOf(' ') + 1)}`).join('; ')}.`, '');
    if (s.flow_note) out.push(s.flow_note, '');
    s.excerpts.forEach((e, i) => {
      const src = e.source.run
        ? `run: ${e.source.run}`
        : e.source.files
          ? e.source.files.map((f) => `\`${f.file}\`${f.pointer ? ` \`${f.pointer}\`` : ''}${f.layer ? ` (layer \`${f.layer}\`)` : ''}`).join(', ')
          : `\`${e.source.file}\`${e.source.pointer ? ` \`${e.source.pointer}\`` : ''}${e.source.line ? `, line ${e.source.line}` : ''}${e.source.layer ? ` (layer \`${e.source.layer}\`)` : ''}`;
      out.push(`### ${s.id}.${i + 1} ${e.title}`, '', `Source: ${src}${e.note ? `. ${e.note}` : ''}`, '', '```' + (e.lang === 'markdown' ? 'md' : e.lang), e.text, '```', '');
    });
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const conformance = await runConformance();
  if (!conformance.ok) throw new Error('conformance failed; run npm run conformance');
  const release = readJson('core/release.json');
  const sections = [...(await journeyExcerpts(conformance)), ...(await creatorExamples(conformance)), await pricingModelExample(conformance), await rateCardExample(conformance), kernelExcerpts(), releaseExcerpts(), await modulesExcerpts()];
  const doc = {
    $comment: 'Exact excerpts for the deep-dive slides. Each excerpt names its source file (and JSON pointer or line) or the run step that produced it. Trimming only removes content: "…" marks a cut. Generated by scripts/slide-excerpts.mjs.',
    generated_at: new Date().toISOString(),
    core: { adcp_version: release.adcp_version, bundle_digest: release.bundle_digest, layers: Object.keys(release.layers).length, hooks_by_layer: Object.fromEntries(Object.entries(release.layers).filter(([, l]) => l.hooks).map(([k, l]) => [k, l.hooks])) },
    extensions: Object.fromEntries(Object.entries(PKG).map(([k]) => [bundle(k)['x-adcp-extension'].name, { version: lockOf(k).version, uri: lockOf(k).uri, digest: lockOf(k).digest }])),
    sections,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'slide-excerpts.json'), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(path.join(OUT_DIR, 'slide-excerpts.md'), markdown(doc));
  const n = sections.reduce((k, s) => k + s.excerpts.length, 0);
  console.log(`wrote analysis/slide-excerpts.json and analysis/slide-excerpts.md: ${sections.length} sections, ${n} excerpts, longest ${Math.max(...sections.flatMap((s) => s.excerpts.map((e) => e.lines)))} lines`);
}

