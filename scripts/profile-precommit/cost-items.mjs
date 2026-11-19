// Ranks where CPU time goes across many V8 .cpuprofile files, by inclusive
// cost item rather than self time.
//
//   node scripts/profile-precommit.mjs costs <dir> [<dir> ...] [--repo-root /app] [--out costs.json]
//
// Self time (cpuprofile.mjs) cannot say "the SDK costs X" because SDK work
// spreads its self time over Ajv, node:fs and the GC. Here every sample is
// charged to each cost item that has a frame anywhere on the sample's stack,
// so items overlap and do not sum to the total. Two buckets are not CPU and
// are reported apart: (idle), and time a thread spent blocked in a synchronous
// child-process call (spawnSync, execSync, execFileSync), which V8 charges to
// the calling frame although the CPU is spent in the child's own profile.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SYNC_CHILD = /^(spawnSync|execSync|execFileSync)$/;

function pkgOf(file) {
  const nm = file.lastIndexOf('/node_modules/');
  if (nm < 0) return null;
  const parts = file.slice(nm + 14).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

// Cost items: name -> predicate over a call frame (functionName, file, pkg).
const ITEMS = [
  ['module loading (node:internal/modules)', (f) => f.file.startsWith('node:internal/modules/')],
  ['vitest/vite module runner and transform', (f) => /^(vitest|vite|vite-node|@vitest\/[^/]+|esbuild|rollup|magic-string|es-module-lexer)$/.test(f.pkg ?? '')],
  ['tsx/esbuild transform', (f) => f.pkg === 'tsx' || f.pkg === 'esbuild' || f.pkg === 'get-tsconfig'],
  ['@adcp/sdk (all)', (f) => f.pkg === '@adcp/sdk' || f.pkg === '@adcp/client'],
  ['ajv (all)', (f) => f.pkg === 'ajv' || f.pkg === 'ajv-formats'],
  ['ajv compile', (f) => (f.pkg === 'ajv') && /^(compile|compileSchema|_compileSchemaEnv|_compileMetaSchema|_addSchema|addSchema|getSchema|compileAsync|resolveRef|_compile)$/.test(f.functionName)],
  ['zod', (f) => f.pkg === 'zod'],
  ['typescript compiler', (f) => f.pkg === 'typescript'],
  ['pg / pglite', (f) => /^(pg|pg-protocol|@electric-sql\/pglite|pglite)$/.test(f.pkg ?? '')],
  ['express / http stack', (f) => /^(express|router|body-parser|raw-body|supertest|superagent|undici|@modelcontextprotocol\/sdk)$/.test(f.pkg ?? '') || f.file.startsWith('node:_http') || f.file.startsWith('node:internal/http')],
  ['structuredClone / worker messaging', (f) => f.functionName === 'structuredClone' || f.file.startsWith('node:internal/worker')],
  ['JSON.parse / stringify', (f) => !f.file && /^(parse|stringify)$/.test(f.functionName)],
  ['node:fs', (f) => f.file.startsWith('node:fs') || f.file.startsWith('node:internal/fs')],
  ['node:crypto', (f) => f.file.startsWith('node:crypto') || f.file.startsWith('node:internal/crypto')],
  ['repo source (server/src)', (f) => /(^|\/)server\/src\//.test(f.rel ?? '')],
  ['repo scripts', (f) => /^scripts\//.test(f.rel ?? '')],
];

function frameInfo(callFrame, repoRoot) {
  let file = (callFrame.url || '').replace(/^file:\/\//, '');
  try { file = decodeURIComponent(file); } catch { /* keep raw */ }
  const pkg = pkgOf(file);
  const rel = !pkg && file.startsWith(repoRoot + '/') ? file.slice(repoRoot.length + 1) : null;
  return { functionName: callFrame.functionName || '', file, pkg, rel, line: callFrame.lineNumber + 1 };
}

function walkProfiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkProfiles(p, out);
    else if (name.endsWith('.cpuprofile')) out.push(p);
  }
  return out;
}

function add(map, key, ms) { map.set(key, (map.get(key) ?? 0) + ms); }

export function costItems(dirs, { repoRoot = '/app', groupBy } = {}) {
  const groups = new Map();
  const group = (g) => {
    if (!groups.has(g)) {
      groups.set(g, {
        profiles: 0, unreadable: 0, sampledMs: 0, idleMs: 0, blockedMs: 0, gcMs: 0,
        items: new Map(), testFiles: new Map(), packages: new Map(), functions: new Map(),
        perProfile: [],
      });
    }
    return groups.get(g);
  };

  for (const dir of dirs) {
    for (const file of walkProfiles(dir)) {
      const g = group(groupBy ? groupBy(file, dir) : path.basename(dir));
      g.profiles += 1;
      let profile;
      try { profile = JSON.parse(readFileSync(file, 'utf8')); } catch { g.unreadable += 1; continue; }

      // Per node: item bitmask, nearest test file, blocked flag, inherited from the root down.
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const info = new Map();
      const root = profile.nodes[0];
      const stack = [[root, 0, null, false, new Set()]];
      while (stack.length) {
        const [node, parentMask, parentTest, parentBlocked, parentPkgs] = stack.pop();
        const f = frameInfo(node.callFrame, repoRoot);
        let mask = parentMask;
        ITEMS.forEach(([, pred], i) => { if (pred(f)) mask |= 1 << i; });
        const test = /\.test\.[cm]?[jt]sx?$/.test(f.file) ? (f.rel ?? f.file) : parentTest;
        const blocked = parentBlocked || SYNC_CHILD.test(f.functionName);
        let pkgs = parentPkgs;
        if (f.pkg && !parentPkgs.has(f.pkg)) { pkgs = new Set(parentPkgs); pkgs.add(f.pkg); }
        const leafKey = `${f.functionName || '(anonymous)'} ${f.rel ?? (f.pkg ? `${f.pkg}:${path.basename(f.file)}` : f.file)}:${f.line}`;
        info.set(node.id, { mask, test, blocked, pkgs, name: f.functionName, url: f.file, leafKey });
        for (const c of node.children ?? []) stack.push([byId.get(c), mask, test, blocked, pkgs]);
      }

      // Inclusive per function: charge each sample once to every distinct frame key on its stack.
      const parent = new Map();
      for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
      const keysOf = new Map();
      const stackKeys = (id) => {
        let ks = keysOf.get(id);
        if (ks) return ks;
        const p = parent.get(id);
        const up = p === undefined ? new Set() : stackKeys(p);
        const k = info.get(id).leafKey;
        ks = up.has(k) ? up : new Set(up).add(k);
        keysOf.set(id, ks);
        return ks;
      };

      let profMs = 0;
      const { samples = [], timeDeltas = [] } = profile;
      const fnMs = new Map();
      for (let i = 0; i < samples.length; i += 1) {
        const ms = Math.max(0, timeDeltas[i] ?? 0) / 1000;
        const inf = info.get(samples[i]);
        if (!inf) continue;
        g.sampledMs += ms;
        if (inf.name === '(idle)' && !inf.url) { g.idleMs += ms; continue; }
        if (inf.blocked) { g.blockedMs += ms; continue; }
        profMs += ms;
        if (inf.name === '(garbage collector)' && !inf.url) g.gcMs += ms;
        for (let b = 0; b < ITEMS.length; b += 1) if (inf.mask & (1 << b)) add(g.items, ITEMS[b][0], ms);
        add(g.testFiles, inf.test ?? '(outside any test file)', ms);
        for (const p of inf.pkgs) add(g.packages, p, ms);
        for (const k of stackKeys(samples[i])) add(fnMs, k, ms);
      }
      for (const [k, ms] of fnMs) add(g.functions, k, ms);
      g.perProfile.push({ file: path.relative(dir, file), cpuMs: Math.round(profMs) });
    }
  }

  const top = (map, n, cpu) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, ms]) => ({ name, cpu_s: +(ms / 1000).toFixed(1), share: cpu ? +(ms / cpu).toFixed(3) : 0 }));
  const result = {};
  for (const [name, g] of groups) {
    const cpu = g.sampledMs - g.idleMs - g.blockedMs;
    g.perProfile.sort((a, b) => b.cpuMs - a.cpuMs);
    result[name] = {
      profiles: g.profiles, unreadable: g.unreadable,
      sampled_s: +(g.sampledMs / 1000).toFixed(1), idle_s: +(g.idleMs / 1000).toFixed(1),
      blocked_in_sync_child_s: +(g.blockedMs / 1000).toFixed(1), cpu_s: +(cpu / 1000).toFixed(1),
      gc_s: +(g.gcMs / 1000).toFixed(1),
      items: top(g.items, 50, cpu),
      packages: top(g.packages, 30, cpu),
      test_files: top(g.testFiles, 40, cpu),
      functions_inclusive: top(g.functions, 80, cpu),
      longest_profiles: g.perProfile.slice(0, 10),
    };
  }
  return result;
}

export function runCostsCommand(args) {
  const dirs = [];
  let repoRoot = '/app';
  let out = null;
  let group = 'dir';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--repo-root') repoRoot = args[++i];
    else if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--group') group = args[++i];
    else dirs.push(args[i]);
  }
  // --group dir: one group per argument; --group subdir: one per first-level subdirectory.
  const groupBy = group === 'subdir'
    ? (file, dir) => path.relative(dir, file).split(path.sep)[0]
    : undefined;
  const result = costItems(dirs, { repoRoot, groupBy });
  const json = JSON.stringify(result, null, 1);
  if (out) writeFileSync(out, json);
  else process.stdout.write(json + '\n');
  return result;
}
