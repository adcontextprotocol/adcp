// Aggregates the V8 .cpuprofile files a command wrote (via --cpu-prof) into
// self-time buckets: runtime categories, npm packages, repository paths and
// the hottest functions. Raw profiles are large (one per Node process or
// worker thread), so the caller keeps only the few longest ones.

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

function categorize(callFrame, repoRoot) {
  const { functionName, url } = callFrame;
  if (!url) {
    if (functionName === '(garbage collector)') return { category: 'gc', bucket: '(garbage collector)' };
    if (functionName === '(idle)') return { category: 'idle', bucket: '(idle)' };
    if (functionName === '(program)') return { category: 'native', bucket: '(program)' };
    return { category: 'native', bucket: functionName || '(native)' };
  }
  if (url.startsWith('node:')) {
    const rest = url.slice(5);
    if (/^internal\/modules\//.test(rest)) return { category: 'module-loading', bucket: `node:${rest.split('/').slice(0, 3).join('/')}` };
    return { category: 'node-core', bucket: `node:${rest.split('/').slice(0, 2).join('/')}` };
  }
  let file = url.replace(/^file:\/\//, '');
  try { file = decodeURIComponent(file); } catch { /* keep raw */ }
  const nm = file.lastIndexOf('/node_modules/');
  if (nm >= 0) {
    const parts = file.slice(nm + '/node_modules/'.length).split('/');
    const pkg = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    const category = /^(vite|vitest|@vitest\/.*|esbuild|tsx|rollup|@rollup\/.*|es-module-lexer|magic-string|vite-node)$/.test(pkg)
      ? 'test-runner/transform'
      : pkg === 'typescript' ? 'typescript' : 'dependencies';
    return { category, bucket: pkg };
  }
  if (file.startsWith(repoRoot)) {
    const rel = path.relative(repoRoot, file);
    const parts = rel.split('/');
    const bucket = parts.slice(0, parts[0] === 'server' ? 3 : 2).join('/');
    const category = /(^|\/)tests?\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel) ? 'repo-tests' : 'repo-source';
    return { category, bucket };
  }
  return { category: 'other', bucket: file.split('/').slice(0, 4).join('/') };
}

function addTo(map, key, ms) {
  map.set(key, (map.get(key) ?? 0) + ms);
}

function top(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
}

// ADCP_PROFILE_KEEP_ALL=1 keeps every raw profile (runs whose artifacts are
// archived and compared later).
const DEFAULT_KEEP = process.env.ADCP_PROFILE_KEEP_ALL === '1' ? Infinity : 3;

export function aggregateCpuProfiles(dir, { repoRoot, keep = DEFAULT_KEEP } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.cpuprofile'));
  } catch {
    return null;
  }
  const categories = new Map();
  const buckets = new Map();
  const functions = new Map();
  const perProfile = [];
  let totalMs = 0;
  let unreadable = 0;

  for (const name of names) {
    const file = path.join(dir, name);
    let profile;
    try {
      profile = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      unreadable += 1;
      continue;
    }
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const selfMs = new Map();
    const { samples = [], timeDeltas = [] } = profile;
    for (let i = 0; i < samples.length; i += 1) {
      // timeDeltas[i] is the gap before sample i; attribute it to sample i.
      addTo(selfMs, samples[i], Math.max(0, timeDeltas[i] ?? 0) / 1000);
    }
    let profileMs = 0;
    for (const [id, ms] of selfMs) {
      const node = byId.get(id);
      if (!node) continue;
      const { category, bucket } = categorize(node.callFrame, repoRoot);
      profileMs += ms;
      if (category === 'idle') continue;
      addTo(categories, category, ms);
      addTo(buckets, bucket, ms);
      const fn = node.callFrame;
      const loc = fn.url ? `${fn.url.replace(/^file:\/\//, '').replace(repoRoot + '/', '')}:${fn.lineNumber + 1}` : '';
      addTo(functions, `${fn.functionName || '(anonymous)'} ${loc}`.trim(), ms);
    }
    totalMs += profileMs;
    perProfile.push({ name, ms: Math.round(profileMs), bytes: statSync(file).size });
  }

  // Keep the longest profiles for DevTools; delete the rest to save disk.
  perProfile.sort((a, b) => b.ms - a.ms);
  const kept = perProfile.slice(0, keep).map((p) => p.name);
  for (const p of perProfile.slice(keep)) rmSync(path.join(dir, p.name), { force: true });

  const busyMs = [...categories.values()].reduce((a, b) => a + b, 0);
  return {
    profiles: names.length,
    unreadable,
    sampled_ms: Math.round(totalMs),
    busy_ms: Math.round(busyMs),
    categories: top(categories, 20).map((row) => ({ ...row, share: busyMs ? +(row.ms / busyMs).toFixed(3) : 0 })),
    buckets: top(buckets, 40),
    functions: top(functions, 40),
    kept_profiles: kept,
    longest_profiles: perProfile.slice(0, 10),
  };
}
