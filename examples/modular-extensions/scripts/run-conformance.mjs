#!/usr/bin/env node
// Storyboard runner for extension conformance suites.
//
//   node scripts/run-conformance.mjs [--ext <name>] [--json] [--verbose]
//
// For each extension package it loads conformance/*.yaml, checks that every file (and the
// reference code it runs, index.mjs) is the exact one the extension digest pins (manifest
// docs.conformance[].sha256, docs.reference_code.sha256), and runs each storyboard
// against a mock seller (lib/mock-seller.mjs, lib/mock-tv-seller.mjs) and the buyer SDK
// (lib/client.mjs, lib/buyer-validator.mjs). It then reports, per extension, which spec.md
// rules have a passing storyboard.
//
// A storyboard is a list of phases; a phase is a list of steps. A step runs one task, then
// grades `expect`. Steps cite the rule ids they test in `covers`. A rule counts as covered
// only when a storyboard that cites it passes in full. The run fails when a step fails, when
// a MUST rule has no passing storyboard, or when a suite lacks a GREASE step for the reject
// path or for the ignore path (an unknown extension with a random uri@digest, which the buyer
// must reject at a must-understand hook and ignore, or drop, at an optional one; RFC 8701).
//
// Tasks (step.task):
//   get_products {brief}            client.getProducts            -> products (discovery only)
//   request_proposals {brief}       client.requestProposals       -> products, proposals, draft
//   refine_proposals {proposal}     client.refineProposals        -> committed
//   accept_proposal {proposal}      client.acceptProposal         -> accepted, media_buy_id
//   get_media_buys                  client.getMediaBuys           -> media_buy, media_buys_response
//   capabilities                    client.capabilities           -> capabilities
//   call_task {ext, task, request, as}  client.callTask (a contributed task) -> task_result, task_request,
//                                   task_call ({name, task}); with `as`, also <as> and <as>_request
//   seller_op {op, args}            the seller's back office      -> op_result
//   load_fixture {name}             fixtures/payloads.mjs, or the seller catalog -> fixture
//   validate {schema, subject, mutate, grease}   buyer validator on a (mutated) payload -> subject, report
//                                   schema task_request | task_response with task: <name>#<task>
//                                   (and request: <path> for a response) validates a contributed task
//   module_call {ext, fn, args}     an export of the extension's reference code -> result
//   assert                          grade `expect.checks` only
// Values: {$from: ctx.path}, {$uri: name}, {$digest: name | name@version}, {$branch: name#branch}.
// Paths: dot-separated; `@<name>` selects the array item whose uri is that extension's
// (`@grease` selects the last GREASE entry); in JSON pointers the same segment is `/@<name>`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createBuyerValidator } from '../lib/buyer-validator.mjs';
import { createAdcpClient } from '../lib/client.mjs';
import { createCreatorNetworkSeller } from '../lib/mock-seller.mjs';
import { createTvSeller } from '../lib/mock-tv-seller.mjs';
import { CONFORMANCE_DIR, SPEC_FILE, parseSpec, parseStoryboard, sha256Of } from '../lib/extension-spec.mjs';
import * as F from '../fixtures/payloads.mjs';
import { extensionPackages, registryPath } from './build-extensions.mjs';
import { buildSdk } from './adcp-sdk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const SCHEMAS = {
  product: '/schemas/core/product.json',
  proposal: '/schemas/core/canonical-proposal.json',
  request_proposals: '/schemas/media-buy/request-proposals-response.json',
  commercial_terms: '/schemas/media-buy/commercial-terms.json',
  pricing: '/schemas/core/canonical-pricing-option.json',
  cpp_option: '/schemas/pricing-options/cpp-option.json',
  media_buys: '/schemas/media-buy/get-media-buys-response.json',
  capabilities: '/schemas/protocol/get-adcp-capabilities-response.json',
};

// ---- extensions and their suites -------------------------------------------

/** Every extension package: built bundle, lock, reference code, parsed spec, and the storyboards its digest pins. */
export async function loadSuites({ only } = {}) {
  const suites = [];
  for (const dir of extensionPackages()) {
    const bundle = readJson(path.join(dir, 'dist/bundle.json'));
    const manifest = bundle['x-adcp-extension'];
    if (only && manifest.name !== only) continue;
    const lock = readJson(path.join(dir, 'extension.lock.json'));
    const stale = (f) => new Error(`${manifest.name}: ${f} is not the file the digest pins (${lock.version} ${lock.digest.slice(0, 19)}...); run npm run build`);
    const specBytes = readFileSync(path.join(dir, SPEC_FILE));
    if (sha256Of(specBytes) !== manifest.docs?.spec?.sha256) throw stale(SPEC_FILE);
    const storyboards = (manifest.docs.conformance ?? []).map(({ path: rel, sha256 }) => {
      const bytes = readFileSync(path.join(dir, rel));
      if (sha256Of(bytes) !== sha256) throw stale(rel);
      return { file: rel, doc: parseStoryboard(bytes, rel) };
    });
    const pin = manifest.docs.reference_code;
    if (!pin || sha256Of(readFileSync(path.join(dir, pin.path))) !== pin.sha256) throw stale(pin?.path ?? 'index.mjs');
    suites.push({
      dir,
      name: manifest.name,
      manifest,
      lock,
      code: await import(pathToFileURL(path.join(dir, pin.path)).href),
      spec: parseSpec(specBytes.toString('utf8')),
      storyboards,
    });
  }
  return suites;
}

/** Every installed extension by manifest name (lock, dir, reference code); storyboards address them by name. */
export async function extensionIndex() {
  const byName = new Map();
  for (const dir of extensionPackages()) {
    const { name } = readJson(path.join(dir, 'extension.json'));
    const lock = readJson(path.join(dir, 'extension.lock.json'));
    byName.set(name, { name, dir, lock, code: await import(pathToFileURL(path.join(dir, 'index.mjs')).href) });
  }
  const ext = (name) => {
    const s = byName.get(name);
    if (!s) throw new Error(`unknown extension ${name}`);
    return s;
  };
  /** name or name@version -> digest (an older version comes from the registry index). */
  const digestOf = (spec) => {
    const [name, version] = spec.split('@');
    const s = ext(name);
    if (!version || version === s.lock.version) return s.lock.digest;
    const index = readJson(path.join(path.dirname(registryPath(s.lock.uri, 'sha256:x')), 'index.json'));
    if (!index.versions[version]) throw new Error(`${name}@${version} is not published`);
    return index.versions[version].digest;
  };
  return { ext, digestOf };
}

// ---- paths, values, mutations ----------------------------------------------

function makeResolver(ctx, idx) {
  const uriOf = (seg) => (seg === '@grease' ? ctx.grease?.uri : idx.ext(seg.slice(1)).lock.uri);
  const step = (node, seg) => {
    if (node === undefined || node === null) return undefined;
    if (seg.startsWith('@')) return Array.isArray(node) ? node.find((t) => t?.uri === uriOf(seg)) : undefined;
    return node[seg];
  };
  const get = (p) => (p === '' || p === undefined ? ctx : p.split('.').reduce(step, ctx));
  const value = (v) => {
    if (Array.isArray(v)) return v.map(value);
    if (!v || typeof v !== 'object') return v;
    if ('$from' in v) return structuredClone(get(v.$from));
    if ('$uri' in v) return idx.ext(v.$uri).lock.uri;
    if ('$digest' in v) return idx.digestOf(v.$digest);
    if ('$branch' in v) {
      const [name, branch] = v.$branch.split('#');
      return `${idx.ext(name).lock.uri}#${branch}`;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)]));
  };
  /** JSON pointer with `@name` segments -> { parent, key } inside doc. */
  const locate = (doc, pointer) => {
    const tokens = pointer.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = tokens.pop();
    let parent = doc;
    for (const t of tokens) {
      parent = t.startsWith('@') ? parent.find((x) => x?.uri === uriOf(t)) : parent[t];
      if (parent === undefined) throw new Error(`pointer ${pointer}: ${t} not found`);
    }
    const key = last.startsWith('@') ? parent.findIndex((x) => x?.uri === uriOf(last)) : last;
    return { parent, key };
  };
  return { get, value, locate };
}

function mutate(doc, ops, r) {
  for (const op of ops ?? []) {
    const { parent, key } = r.locate(doc, op.path);
    if (op.op === 'set') parent[key] = r.value(op.value);
    else if (op.op === 'remove') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key];
    else if (op.op === 'append') (parent[key] ??= []).push(r.value(op.value));
    else if (op.op === 'shift_days') parent[key] = new Date(Date.parse(parent[key]) + op.days * 864e5).toISOString().replace('.000Z', 'Z');
    else throw new Error(`unknown mutation op ${op.op}`);
  }
  return doc;
}

// ---- GREASE ------------------------------------------------------------------

/** A random extension no buyer can hold a module for: a fresh uri, digest, and branch per call. */
function greaseExtension() {
  const hex = (n) => randomBytes(n).toString('hex');
  return { uri: `https://grease-${hex(3)}.example/adcp/x${hex(3)}`, digest: `sha256:${hex(32)}`, branch: `grease_${hex(2)}` };
}

function applyGrease(doc, g, spec, r) {
  const { parent, key } = r.locate(doc, spec.at);
  if (spec.kind === 'extension-point') {
    const list = (parent[key] ??= []);
    const entry = { uri: g.uri, digest: g.digest, data: { grease: true }, ...(spec.must_understand ? { must_understand: true } : {}) };
    const at = list.findIndex((t) => t.uri > g.uri); // keep uri order, so only the unknown entry is graded
    list.splice(at < 0 ? list.length : at, 0, entry);
  } else if (spec.kind === 'branch') {
    (parent[key] ??= []).push({
      pricing_option_id: `po_${g.branch}`,
      pricing_model: `${g.uri}#${g.branch}`,
      currency: 'EUR',
      extension_model: { uri: g.uri, digest: g.digest, data: { grease: true } },
    });
  } else if (spec.kind === 'task') {
    // A declaration of an unknown extension that serves a task: the buyer must ignore it.
    (parent[key] ??= []).push({ uri: g.uri, digest: g.digest, points: ['task'], tasks: [{ name: `x_${g.branch}`, task: `${g.uri}#${g.branch}` }] });
  } else if (spec.kind === 'branch_host') {
    // Turn an existing host (for example the pricing of a signed purchase) into an unknown branch.
    const host = parent[key];
    for (const k of ['fixed_price', 'floor_price', 'price_breakdown', 'parameters', 'price_guidance']) delete host[k];
    host.pricing_model = `${g.uri}#${g.branch}`;
    host.extension_model = { uri: g.uri, digest: g.digest, data: { grease: true } };
  } else throw new Error(`unknown grease kind ${spec.kind}`);
  return doc;
}

// ---- fixtures and buyers -----------------------------------------------------

const SELLERS = { creator_network: createCreatorNetworkSeller, tv_sales_house: createTvSeller };
const tempDirs = [];

async function setUp(doc, idx) {
  const fx = typeof doc.fixture === 'string' ? { seller: doc.fixture } : doc.fixture ?? { seller: 'none' };
  const seller = fx.seller === 'none' ? null : SELLERS[fx.seller]?.({ ignoreUnderstood: fx.ignore_understood ?? false });
  if (fx.seller !== 'none' && !seller) throw new Error(`unknown fixture seller ${fx.seller}`);
  const transport = seller?.transport ?? { call: async () => { throw new Error('this storyboard has no seller'); }, subscribe: () => () => {} };
  const ctx = { seller, violations: [], changes: [], grease: null };
  const onViolation = (v) => ctx.violations.push(v.message);
  const buyer = doc.buyer ?? {};
  if (buyer.config) {
    const dir = mkdtempSync(path.join(tmpdir(), 'adcp-conformance-'));
    tempDirs.push(dir);
    const extensions = Object.fromEntries(
      Object.entries(buyer.config).map(([alias, spec]) => {
        const [name, range] = spec.split('@');
        return [alias, `${idx.ext(name).lock.uri}@${range ?? '*'}`];
      })
    );
    writeFileSync(path.join(dir, 'adcp.config.json'), JSON.stringify({ core: '3.3.0', extensions }));
    const built = await buildSdk(dir);
    if (!built.written) throw new Error(`buyer config did not resolve: ${JSON.stringify(built.resolved.map((r) => r.reasons ?? r.version))}`);
    ctx.client = await createAdcpClient({ transport, lockfile: path.join(dir, 'adcp.lock.json'), onViolation });
  } else {
    const extensions = (buyer.extensions ?? []).map((name) => {
      const s = idx.ext(name);
      return { EXTENSION_URI: s.lock.uri, EXTENSION_DIGEST: s.lock.digest, EXTENSION_MODULE_DIR: pathToFileURL(s.dir + '/') };
    });
    ctx.client = await createAdcpClient({ transport, extensions, onViolation });
  }
  ctx.validator = createBuyerValidator({ modules: ctx.client.modules });
  seller?.transport.subscribe((record) => ctx.changes.push(record));
  return ctx;
}

// ---- tasks -------------------------------------------------------------------

const TASKS = {
  async get_products(ctx, a) {
    const res = await ctx.client.getProducts({ buying_mode: 'brief', brief: a.brief ?? 'conformance' });
    Object.assign(ctx, { products: res.products ?? [] });
  },
  async request_proposals(ctx, a) {
    const res = await ctx.client.requestProposals({
      idempotency_key: `conformance-request-${randomBytes(6).toString('hex')}`,
      brief: a.brief ?? 'conformance',
      brand: { domain: 'brand.example.com' },
    });
    Object.assign(ctx, { proposals_response: res, products: res.products ?? [], proposals: res.proposals ?? [], draft: res.proposals?.[0] });
  },
  async refine_proposals(ctx, a, r) {
    const proposal = r.get(a.proposal ?? 'draft');
    const res = await ctx.client.refineProposals({ idempotency_key: `conformance-finalize-${randomBytes(6).toString('hex')}`, refinements: [{ proposal_id: proposal.proposal_id, action: 'finalize' }] });
    ctx.committed = res.proposals[0];
  },
  async accept_proposal(ctx, a, r) {
    const proposal = r.get(a.proposal ?? 'committed');
    ctx.accepted = await ctx.client.acceptProposal({ proposal, idempotency_key: `conformance-accept-${randomBytes(6).toString('hex')}`, account: { account_id: 'acc_conformance' } });
    ctx.media_buy_id = ctx.accepted.media_buy_id;
  },
  async get_media_buys(ctx) {
    const res = await ctx.client.getMediaBuys({ media_buy_ids: [ctx.media_buy_id] });
    Object.assign(ctx, { media_buys_response: res, media_buy: res.media_buys[0] });
  },
  async capabilities(ctx) {
    ctx.capabilities = await ctx.client.capabilities();
  },
  async seller_op(ctx, a, r) {
    await new Promise((done) => setImmediate(done)); // let change-feed deliveries settle first
    ctx.op_result = ctx.seller.ops[a.op](...r.value(a.args ?? []));
  },
  async load_fixture(ctx, a) {
    ctx.fixture = a.name === 'catalog' ? ctx.seller.catalog() : F[a.name]();
  },
  async call_task(ctx, a, r) {
    const request = { idempotency_key: `conformance-task-${randomBytes(6).toString('hex')}`, ...r.value(a.request) };
    Object.assign(ctx, { task_request: request, task_result: undefined, task_call: undefined });
    if (a.as) ctx[`${a.as}_request`] = request;
    try {
      ctx.task_result = await ctx.client.callTask(taskOf(ctx.idx, a.ext, a.task), request);
    } finally {
      ctx.task_call = ctx.client.lastTaskCall;
    }
    if (a.as) ctx[a.as] = ctx.task_result;
  },
  async validate(ctx, a, r) {
    const subject = mutate(structuredClone(r.get(a.subject)), a.mutate, r);
    if (a.grease) {
      ctx.grease = greaseExtension();
      applyGrease(subject, ctx.grease, a.grease, r);
    }
    ctx.subject = subject;
    if (a.schema === 'task_request' || a.schema === 'task_response') {
      const [ext, task] = a.task.split('#');
      ctx.report = ctx.validator.validateTask(taskOf(ctx.idx, ext, task), a.schema.slice('task_'.length), subject, { request: a.request ? r.get(a.request) : undefined });
    } else ctx.report = ctx.validator.validate(SCHEMAS[a.schema] ?? a.schema, subject);
    ctx.reports = [ctx.report];
  },
  async module_call(ctx, a, r) {
    ctx.result = ctx.idx.ext(a.ext).code[a.fn](...r.value(a.args ?? []));
  },
  async assert() {},
};

const CLIENT_TASKS = new Set(['get_products', 'request_proposals', 'refine_proposals', 'accept_proposal', 'get_media_buys', 'capabilities', 'call_task']);

/** The descriptor of a task an extension contributes, as its generated module has it: { id, uri, digest, branch }. */
function taskOf(idx, ext, task) {
  const { uri, digest } = idx.ext(ext).lock;
  return { id: `${uri}#${task}`, uri, digest, branch: task };
}

// ---- grading -------------------------------------------------------------------

function gradeCheck(c, r) {
  const v = r.get(c.path);
  const at = c.path;
  const match = (item, where) =>
    Object.entries(r.value(where)).every(([k, cond]) => {
      if (cond && typeof cond === 'object' && 'in' in cond) return cond.in.includes(item?.[k]);
      if (cond && typeof cond === 'object' && 'contains' in cond) return Array.isArray(item?.[k]) && item[k].some((x) => isDeepStrictEqual(x, cond.contains));
      return isDeepStrictEqual(item?.[k], cond);
    });
  if ('equals' in c && !isDeepStrictEqual(v, r.value(c.equals))) return `${at} is ${JSON.stringify(v)}, expected ${JSON.stringify(r.value(c.equals))}`;
  if ('not_equals' in c && isDeepStrictEqual(v, r.value(c.not_equals))) return `${at} is ${JSON.stringify(v)}, expected anything else`;
  if ('matches' in c && !new RegExp(c.matches).test(String(v))) return `${at} is ${JSON.stringify(v)}, expected /${c.matches}/`;
  if ('length' in c && v?.length !== c.length) return `${at} has length ${v?.length}, expected ${c.length}`;
  if (c.present && v === undefined) return `${at} is absent`;
  if (c.absent && v !== undefined) return `${at} is present: ${JSON.stringify(v).slice(0, 120)}`;
  if ('lte' in c && !(v <= r.value(c.lte))) return `${at} is ${v}, expected <= ${r.value(c.lte)}`;
  if ('none' in c && (v ?? []).some((item) => match(item, c.none))) return `${at} has an item matching ${JSON.stringify(c.none)}`;
  if ('some' in c && !(v ?? []).some((item) => match(item, c.some))) return `${at} has no item matching ${JSON.stringify(c.some)}`;
  if ('every' in c && !(v ?? []).every((item) => match(item, c.every))) return `${at} has an item not matching ${JSON.stringify(c.every)}`;
  return null;
}

function grade(step, ctx, r, before) {
  const e = step.expect ?? {};
  const fails = [];
  const reports = ctx.stepReports ?? [];
  const errors = [...reports.flatMap((x) => x.errors), ...(ctx.error && !ctx.error.report ? [ctx.error] : [])];
  const warnings = reports.flatMap((x) => [...x.warnings, ...x.extensions.flatMap((en) => en.warnings.map((m) => ({ code: m.split(':')[0], message: m })))]);
  const entries = reports.flatMap((x) => x.extensions);
  const stepViolations = [...ctx.violations.slice(before), ...(step.task === 'validate' ? ctx.report.violations.map((v) => v.message) : [])];
  const ok = !ctx.error && reports.every((x) => x.ok);

  if ('ok' in e && e.ok !== ok) fails.push(`expected ok=${e.ok}, got ok=${ok}${errors.length ? `: ${errors.map((x) => `${x.code} ${x.message}`).join('; ').slice(0, 300)}` : ''}`);
  if (e.error_code && !errors.some((x) => x.code === e.error_code)) fails.push(`expected error ${e.error_code}, got [${errors.map((x) => x.code)}]`);
  if (e.error_match && !errors.some((x) => new RegExp(e.error_match).test(x.message))) fails.push(`no error matches /${e.error_match}/: ${errors.map((x) => x.message).join('; ').slice(0, 300)}`);
  if (e.warning_code && !warnings.some((w) => w.code === e.warning_code)) fails.push(`expected warning ${e.warning_code}, got [${warnings.map((w) => w.code)}]`);
  if (e.warning_match && !warnings.some((w) => new RegExp(e.warning_match).test(w.message))) fails.push(`no warning matches /${e.warning_match}/`);
  for (const want of [].concat(e.status ?? [])) {
    const uri = want.ext === 'grease' ? ctx.grease?.uri : ctx.idx.ext(want.ext).lock.uri;
    const found = entries.filter((x) => x.uri === uri && (!want.point || x.point === want.point));
    if (!found.length) fails.push(`no ${want.ext} entry${want.point ? ` at ${want.point}` : ''} in the report`);
    else if (!found.some((x) => x.status === want.status)) fails.push(`${want.ext}${want.point ? ` at ${want.point}` : ''} is ${found.map((x) => x.status)}, expected ${want.status}`);
  }
  if ('violations' in e && stepViolations.length !== e.violations) fails.push(`expected ${e.violations} violation(s), got ${stepViolations.length}: ${stepViolations.join('; ').slice(0, 300)}`);
  if (e.violation_match && !stepViolations.some((m) => new RegExp(e.violation_match).test(m))) fails.push(`no violation matches /${e.violation_match}/: ${stepViolations.join('; ').slice(0, 300) || '(none)'}`);
  if (e.dropped && !isDeepStrictEqual(reports.flatMap((x) => x.dropped), e.dropped)) fails.push(`dropped ${JSON.stringify(reports.flatMap((x) => x.dropped))}, expected ${JSON.stringify(e.dropped)}`);
  if (e.seller_error && ctx.error?.code !== e.seller_error) fails.push(`expected seller error ${e.seller_error}, got ${ctx.error?.code ?? 'none'}`);
  for (const c of e.checks ?? []) {
    const f = gradeCheck(c, r);
    if (f) fails.push(f);
  }
  if (e.nonconformant) {
    // A conformance-only rule: the payload breaks it, so at least one check must fail.
    if (e.nonconformant.every((c) => !gradeCheck(c, r))) fails.push('expected the conformance check to flag this payload, but every check passed');
  }
  return fails;
}

/** Which GREASE path a step exercises: reject (must-understand hook) or ignore (optional hook, or a dropped list item). */
function greasePath(step) {
  if (step.task !== 'validate' || !step.with?.grease) return null;
  const want = [].concat(step.expect?.status ?? []).find((s) => s.ext === 'grease');
  if (!want) return null;
  return want.status === 'rejected' ? 'reject' : ['ignored', 'dropped'].includes(want.status) ? 'ignore' : null;
}

export async function runStoryboard(sb, idx) {
  const { doc } = sb;
  const result = { id: doc.id, title: doc.title, file: sb.file, ok: true, steps: [], covers: new Set(), grease: new Set() };
  let ctx;
  try {
    ctx = await setUp(doc, idx);
  } catch (e) {
    return { ...result, ok: false, error: `fixture: ${e.message}` };
  }
  ctx.idx = idx;
  const r = makeResolver(ctx, idx);
  let failed = false;
  for (const phase of doc.phases) {
    for (const step of phase.steps) {
      const s = { phase: phase.id, id: step.id, title: step.title, covers: step.covers ?? [] };
      result.steps.push(s);
      step.covers?.forEach((id) => result.covers.add(id));
      if (failed) {
        s.status = 'skipped';
        continue;
      }
      ctx.error = null;
      ctx.stepReports = [];
      const before = ctx.violations.length;
      try {
        const task = TASKS[step.task];
        if (!task) throw new Error(`unknown task ${step.task}`);
        ctx.client.lastReports = [];
        await task(ctx, step.with ?? {}, r);
      } catch (e) {
        if (e.code === undefined) {
          ctx.error = { code: 'RUNNER_ERROR', message: e.stack ?? e.message };
        } else ctx.error = { code: e.code, message: e.message, report: e.report };
      }
      if (CLIENT_TASKS.has(step.task)) {
        ctx.stepReports = [...ctx.client.lastReports];
        ctx.reports = ctx.stepReports;
        ctx.report = ctx.stepReports.at(-1);
      }
      else if (step.task === 'validate' && ctx.report) ctx.stepReports = [ctx.report];
      const fails = ctx.error?.code === 'RUNNER_ERROR' ? [ctx.error.message] : grade(step, ctx, r, before);
      s.status = fails.length ? 'failed' : 'passed';
      if (fails.length) {
        s.failures = fails;
        failed = true;
        result.ok = false;
      } else {
        const g = greasePath(step);
        if (g) {
          s.grease = g;
          result.grease.add(g);
        }
      }
    }
  }
  return result;
}

/** Run every suite; returns per-extension coverage of the spec rules. */
export async function runConformance({ only } = {}) {
  const suites = await loadSuites({ only });
  const idx = await extensionIndex();
  const extensions = [];
  try {
    for (const suite of suites) {
      const storyboards = [];
      for (const sb of suite.storyboards) storyboards.push(await runStoryboard(sb, idx));
      const rules = suite.spec.rules.map((rule) => {
        const citing = storyboards.filter((s) => s.covers.has(rule.id));
        const passing = citing.filter((s) => s.ok);
        const status = citing.some((s) => !s.ok && s.steps.some((st) => st.status === 'failed' && st.covers.includes(rule.id)))
          ? 'failing'
          : passing.length
            ? 'covered'
            : 'uncovered';
        return { ...rule, status, storyboards: passing.map((s) => s.id) };
      });
      const grease = { reject: storyboards.some((s) => s.grease.has('reject')), ignore: storyboards.some((s) => s.grease.has('ignore')) };
      const problems = [
        ...storyboards.filter((s) => !s.ok).map((s) => `storyboard ${s.id} failed`),
        ...rules.filter((r) => r.level === 'MUST' && r.status !== 'covered').map((r) => `${r.id} (MUST) has no passing storyboard`),
        ...(grease.reject ? [] : ['no passing GREASE step for the reject path']),
        ...(grease.ignore ? [] : ['no passing GREASE step for the ignore path']),
      ];
      extensions.push({
        name: suite.name,
        uri: suite.lock.uri,
        version: suite.lock.version,
        digest: suite.lock.digest,
        rules,
        storyboards: storyboards.map((s) => ({ ...s, covers: [...s.covers], grease: [...s.grease] })),
        grease,
        problems,
        ok: problems.length === 0,
      });
    }
  } finally {
    tempDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
  return { ok: extensions.every((e) => e.ok), extensions };
}

// ---- CLI -----------------------------------------------------------------------

function print({ extensions, ok }, { verbose }) {
  for (const e of extensions) {
    const must = e.rules.filter((r) => r.level === 'MUST');
    const covered = (rs) => rs.filter((r) => r.status === 'covered').length;
    const steps = e.storyboards.flatMap((s) => s.steps);
    console.log(`\n${e.name} ${e.version}  ${e.uri}@${e.digest.slice(0, 19)}...`);
    for (const s of e.storyboards) {
      const n = s.steps.filter((st) => st.status === 'passed').length;
      console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.id}  (${n}/${s.steps.length} steps)${s.grease.length ? `  grease: ${s.grease.join(', ')}` : ''}`);
      if (s.error) console.log(`         ${s.error}`);
      for (const st of s.steps) {
        if (st.status === 'failed' || verbose) console.log(`         ${st.status.padEnd(7)} ${st.phase}/${st.id}${st.failures ? `\n           ${st.failures.join('\n           ')}` : ''}`);
      }
    }
    console.log(`  rules: ${covered(e.rules)}/${e.rules.length} covered; MUST ${covered(must)}/${must.length}; conformance only: ${e.rules.filter((r) => r.conformanceOnly).length}; steps ${steps.filter((s) => s.status === 'passed').length}/${steps.length}; GREASE reject ${e.grease.reject ? 'yes' : 'NO'}, ignore ${e.grease.ignore ? 'yes' : 'NO'}`);
    for (const r of e.rules) {
      const mark = r.status === 'covered' ? '+' : r.status === 'failing' ? 'x' : '-';
      if (verbose || r.status !== 'covered') console.log(`    ${mark} ${r.id.padEnd(8)} ${(r.level ?? '?').padEnd(6)} ${r.status.padEnd(9)} ${r.conformanceOnly ? '[conformance only] ' : ''}${r.title}`);
    }
    for (const p of e.problems) console.log(`  PROBLEM: ${p}`);
  }
  const all = extensions.flatMap((e) => e.storyboards);
  const steps = all.flatMap((s) => s.steps);
  console.log(`\nconformance: ${all.filter((s) => s.ok).length}/${all.length} storyboards, ${steps.filter((s) => s.status === 'passed').length}/${steps.length} steps passed; ${ok ? 'every MUST rule has a passing storyboard' : 'FAILED'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--ext');
  const result = await runConformance({ only: i > 0 ? process.argv[i + 1] : undefined });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else print(result, { verbose: process.argv.includes('--verbose') });
  if (!result.ok) process.exitCode = 1;
}

export { CONFORMANCE_DIR };
