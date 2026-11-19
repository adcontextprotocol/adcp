#!/usr/bin/env node
// Pre-commit hook profiler: runs the same commands as .husky/pre-commit and
// writes a run directory you read instead of the terminal.
//
// USAGE
//   node scripts/profile-precommit.mjs run [options]
//   node scripts/profile-precommit.mjs summarize <run-dir>
//   node scripts/profile-precommit.mjs compare <run-a> <run-b>
//   node scripts/profile-precommit.mjs costs <profile-dir>... [--group dir|subdir] [--repo-root /app] [--out f.json]
//                                 Inclusive CPU cost items over .cpuprofile files.
//
// RUN OPTIONS
//   --server-unit full|skip|auto  Server unit plan. Standalone default: full
//                                 (the path a staged package.json takes);
//                                 --as-hook default: auto (staged files).
//   --label TEXT                  Suffix for the run directory name.
//   --out DIR                     Parent directory (default .hook-runs).
//   --cpu-prof                    V8 CPU profiles for every Node process and
//                                 worker thread (NODE_OPTIONS=--cpu-prof);
//                                 aggregated into cpu-summary.json, the three
//                                 longest raw profiles kept (every profile
//                                 with ADCP_PROFILE_KEEP_ALL=1). Adds overhead, so
//                                 compare timings only between runs that
//                                 agree on this flag.
//   --heap-prof                   V8 sampling heap profiles (raw files kept).
//   --import-durations            Ask vitest to record per-module import
//                                 times (experimental.importDurations), so
//                                 the summary can rank the costliest imports.
//   --keep-going                  Run every command even after a failure
//                                 (the hook stops at the first failure).
//   --only a,b                    Run only commands whose name contains one
//                                 of these substrings (for iteration).
//   --sample-ms N                 Process-tree sampling interval (1000).
//   --synthetic-load N            Keep N busy-loop processes (`yes`) running
//                                 for the whole run: a repeatable stand-in
//                                 for other agents' work on the machine.
//   --as-hook                     Terse terminal output; for .husky/pre-commit.
//
// The command list is derived, not hard-coded: the hook's command lines are
// read from .husky/pre-commit and every `npm run X` is expanded through
// package.json into its leaf commands (split on &&). `with-timeout.sh N`
// budgets are enforced per group, as the hook does (ADCP_TIMEOUT_SCALE
// honoured). The exit status is the hook's: the first failing command's code.
//
// RUN DIRECTORY  .hook-runs/<UTC timestamp>[-label]/
//   machine.json                 CPU count, load, memory, competing processes.
//   summary.json, summary.html   Ranked commands, vitest files, shard balance.
//   <NN-command>/
//     report.json                Command, start/end, wall, exit, rusage
//                                (user/sys CPU, max RSS of the largest
//                                process), tree peak RSS, failure summary.
//     stdout.log, stderr.log     Full output.
//     samples.csv                Every --sample-ms: process count, summed
//                                CPU% and RSS of the command's process tree.
//     vitest/ node-test.json     Structured results (vitest timing reporter,
//                                vitest JSON, node:test JSON reporter).
//     cpu/ cpu-summary.json      With --cpu-prof.
//
// WHAT IS NOT COVERED
//   - Forked vitest workers (the server suite's `forks` pool) ignore
//     --cpu-prof in NODE_OPTIONS; the server-unit step passes it through
//     vitest's --execArgv instead (ADCP_VITEST_CPU_PROF_DIR), giving one
//     profile per test file. Under --cpu-prof, ten server test files never
//     finish (their worker idles in the event loop; for example
//     tests/unit/storyboards.test.ts and
//     src/training-agent/identity33/identity33-route.test.ts), so stop a
//     profiling run once the rest finish; the profiles written so far are
//     still aggregated. Thread-pool workers (the root suite) are
//     covered by NODE_OPTIONS. A process killed by a signal writes no
//     profile; report.json shows profiles written against Node processes
//     seen by the sampler. tsc is @typescript/native (a Go binary), so the
//     typecheck steps have rusage and samples but no V8 profile.
//   - CPU% in samples.csv comes from `ps` (a decaying average); use the
//     rusage user/sys totals for exact CPU time. rusage covers only waited-for
//     descendants, and its max RSS is the single largest process; the
//     tree peak in samples.csv is the summed footprint.
//
// HOOK USE (optional): ADCP_PRECOMMIT_PROFILE=1 git commit ... makes
// .husky/pre-commit run this script with --as-hook instead of the plain
// commands; the commit passes or fails exactly as it would otherwise.

import { spawn, execFileSync, execFile } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateCpuProfiles } from './profile-precommit/cpuprofile.mjs';
import { renderSummaryHtml, renderCompareHtml } from './profile-precommit/render.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const NODE_TEST_REPORTER = path.join(SCRIPT_DIR, 'profile-precommit', 'node-test-json-reporter.mjs');
const VITEST_TIMING_REPORTER = path.join(SCRIPT_DIR, 'profile-precommit', 'vitest-timing-reporter.mjs');
const COMPETING_RE = 'pre-push|storyboard|git push|vitest|tsc --project';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    const flag = ['cpu-prof', 'heap-prof', 'keep-going', 'as-hook', 'import-durations'].includes(key);
    opts[key] = flag ? true : (inline ?? rest[++i]);
  }
  return { command, opts };
}

// ---------------------------------------------------------- command expansion

function hookCommandLines() {
  const text = readFileSync(path.join(REPO_ROOT, '.husky', 'pre-commit'), 'utf8');
  const lines = [];
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^if\b/.test(line)) { depth += 1; continue; }
    if (/^fi\b/.test(line)) { depth -= 1; continue; }
    if (depth > 0 || !line || line.startsWith('#') || /^(export|HUSKY_INIT=|\[)/.test(line)) continue;
    if (line.includes('profile-precommit')) continue;
    lines.push(line);
  }
  return lines;
}

function expand(command, scripts, ctx, out) {
  const clauses = command.split(/\s+&&\s+/).map((c) => c.trim()).filter(Boolean);
  clauses.forEach((clause, index) => {
    if (/(\|\||;|\|)/.test(clause.replace(/'[^']*'|"[^"]*"/g, ''))) {
      throw new Error(`Cannot expand clause with shell operators: ${clause}`);
    }
    let budget = ctx.budget;
    let inner = clause;
    const timeout = /^bash scripts\/with-timeout\.sh (\d+) (.+)$/.exec(clause);
    if (timeout) {
      budget = { id: out.budgets.length, seconds: scaleBudget(Number(timeout[1])), label: timeout[2], startedAt: null };
      out.budgets.push(budget);
      inner = timeout[2];
    }
    const npmRun = /^npm run (?:--silent )?([\w:.-]+)$/.exec(inner);
    if (npmRun) {
      const name = npmRun[1];
      if (!(name in scripts)) throw new Error(`package.json has no script ${name}`);
      expand(scripts[name], scripts, { budget, chain: [...ctx.chain, name] }, out);
      return;
    }
    const owner = ctx.chain.at(-1) ?? 'hook';
    const name = clauses.length > 1 ? `${owner}#${index + 1}` : owner;
    out.commands.push({ name, chain: ctx.chain, command: inner, budget });
  });
}

function scaleBudget(seconds) {
  const scale = Number(process.env.ADCP_TIMEOUT_SCALE);
  return Number.isFinite(scale) && scale >= 1 ? Math.ceil(seconds * scale) : seconds;
}

function planCommands() {
  const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
  const out = { commands: [], budgets: [] };
  for (const line of hookCommandLines()) {
    const label = /check-image-quality/.test(line) ? 'check-image-quality' : null;
    const before = out.commands.length;
    expand(line, scripts, { budget: null, chain: [] }, out);
    if (label) for (const c of out.commands.slice(before)) c.name = label;
  }
  out.commands.forEach((c, i) => {
    c.index = i + 1;
    c.slug = `${String(i + 1).padStart(2, '0')}-${c.name.replace(/[^\w.-]+/g, '-')}`;
    c.kind = classify(c.command);
  });
  return out;
}

function classify(command) {
  if (/precommit-server-unit\.cjs/.test(command)) return 'server-unit';
  if (/(^|\s)vitest run\b/.test(command)) return 'vitest';
  if (/\bnode\b.*\s--test(\s|$)/.test(command)) return 'node-test';
  if (/^tsc\b/.test(command)) return 'tsc';
  if (/typecheck/.test(command)) return 'tsc-wrapper';
  return 'other';
}

// The leaf command as run: the hook's command plus structured reporters.
function instrument(cmd, dir, opts) {
  switch (cmd.kind) {
    case 'vitest':
      return `${cmd.command} --reporter=default --reporter=${VITEST_TIMING_REPORTER}${opts['import-durations'] ? ' --experimental.importDurations.limit=500' : ''}`;
    case 'node-test':
      return cmd.command.replace(/(\s--test)(\s|$)/, `$1 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=${NODE_TEST_REPORTER} --test-reporter-destination=${path.join(dir, 'node-test.json')}$2`);
    case 'tsc':
      return `${cmd.command} --pretty false`;
    default:
      return cmd.command;
  }
}

// ------------------------------------------------------------- machine state

function sh(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function availableMemoryBytes() {
  const vm = sh('vm_stat', []);
  const pageSize = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 4096);
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  if (!vm) return os.freemem();
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize;
}

function machineState(excludePids = new Set()) {
  const competing = sh('pgrep', ['-fl', COMPETING_RE])
    .split('\n').filter(Boolean)
    .filter((line) => !excludePids.has(Number(line.split(' ')[0])))
    .filter((line) => !line.includes('pgrep'))
    // A wrapper shell (`zsh -c '...'`) matches on its script text, not on
    // what it runs; the processes it starts are listed on their own.
    .filter((line) => !/^\d+ \S*\b(?:zsh|bash|sh) -c\b/.test(line))
    .map((line) => line.slice(0, 200));
  return {
    at: new Date().toISOString(),
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model,
    loadavg: os.loadavg().map((v) => +v.toFixed(2)),
    total_mem_gb: +(os.totalmem() / 2 ** 30).toFixed(1),
    free_mem_gb: +(os.freemem() / 2 ** 30).toFixed(1),
    available_mem_gb: +(availableMemoryBytes() / 2 ** 30).toFixed(1),
    competing_processes: competing,
  };
}

// ---------------------------------------------------------------- sampling

function psSnapshot() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split('\n').filter(Boolean).map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
        return m ? { pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4], comm: m[5] } : null;
      }).filter(Boolean));
    });
  });
}

function treeOf(rows, rootPid) {
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) { out.push(child); stack.push(child.pid); }
  }
  return out;
}

function startSampler(rootPid, csvPath, intervalMs, t0) {
  appendFileSync(csvPath, 'elapsed_s,procs,node_procs,cpu_pct,rss_mb,max_proc_rss_mb,load1\n');
  const state = { peakRssMb: 0, peakCpuPct: 0, cpuPctSum: 0, samples: 0, nodePids: new Set(), maxProcs: 0 };
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const tree = treeOf(await psSnapshot(), rootPid);
    busy = false;
    const node = tree.filter((p) => /node$/.test(p.comm));
    for (const p of node) state.nodePids.add(p.pid);
    const cpu = tree.reduce((a, p) => a + p.cpu, 0);
    const rssMb = tree.reduce((a, p) => a + p.rss, 0) / 1024;
    const maxProc = tree.reduce((a, p) => Math.max(a, p.rss), 0) / 1024;
    state.peakRssMb = Math.max(state.peakRssMb, rssMb);
    state.peakCpuPct = Math.max(state.peakCpuPct, cpu);
    state.maxProcs = Math.max(state.maxProcs, tree.length);
    state.cpuPctSum += cpu;
    state.samples += 1;
    appendFileSync(csvPath, `${((Date.now() - t0) / 1000).toFixed(1)},${tree.length},${node.length},${cpu.toFixed(1)},${rssMb.toFixed(1)},${maxProc.toFixed(1)},${os.loadavg()[0].toFixed(2)}\n`);
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return { state, stop: () => clearInterval(timer) };
}

// -------------------------------------------------------------- run a command

// macOS /usr/bin/time -l (BSD) and Linux /usr/bin/time -v (GNU) report the
// same rusage in different formats; BSD gives max RSS in bytes, GNU in KiB.
const TIME_FLAG = process.platform === 'darwin' ? '-l' : '-v';

function parseRusage(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  if (TIME_FLAG === '-v') {
    const elapsed = /Elapsed \(wall clock\) time[^:]*:\s*([\d:.]+)/.exec(text)?.[1];
    const kib = num(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    return {
      real_s: elapsed ? +elapsed.split(':').reduce((acc, part) => acc * 60 + Number(part), 0).toFixed(2) : null,
      user_s: num(/User time \(seconds\):\s*([\d.]+)/),
      sys_s: num(/System time \(seconds\):\s*([\d.]+)/),
      max_rss_mb: kib === null ? null : +(kib / 1024).toFixed(1),
      peak_footprint_mb: null,
      involuntary_ctx_switches: num(/Involuntary context switches:\s*(\d+)/),
    };
  }
  return {
    real_s: num(/([\d.]+)\s+real/),
    user_s: num(/([\d.]+)\s+user/),
    sys_s: num(/([\d.]+)\s+sys/),
    max_rss_mb: (() => { const b = num(/(\d+)\s+maximum resident set size/); return b === null ? null : +(b / 2 ** 20).toFixed(1); })(),
    peak_footprint_mb: (() => { const b = num(/(\d+)\s+peak memory footprint/); return b === null ? null : +(b / 2 ** 20).toFixed(1); })(),
    involuntary_ctx_switches: num(/(\d+)\s+involuntary context switches/),
  };
}

function killTree(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* gone */ }
}

async function runCommand(cmd, runDir, opts) {
  const dir = path.join(runDir, cmd.slug);
  mkdirSync(dir, { recursive: true });
  const command = instrument(cmd, dir, opts);
  const env = {
    ...process.env,
    PATH: `${path.join(REPO_ROOT, 'node_modules', '.bin')}:${process.env.PATH}`,
  };
  const nodeOptions = [];
  if (opts['cpu-prof']) nodeOptions.push('--cpu-prof', `--cpu-prof-dir=${path.join(dir, 'cpu')}`);
  if (opts['heap-prof']) nodeOptions.push('--heap-prof', `--heap-prof-dir=${path.join(dir, 'heap')}`);
  if (nodeOptions.length) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, ...nodeOptions].filter(Boolean).join(' ');
  if (cmd.kind === 'vitest') env.ADCP_VITEST_TIMING_DIR = path.join(dir, 'vitest');
  if (cmd.kind === 'server-unit') {
    env.ADCP_PRECOMMIT_REPORT_DIR = path.join(dir, 'vitest');
    env.ADCP_VITEST_TIMING_DIR = path.join(dir, 'vitest');
    env.ADCP_PRECOMMIT_SERVER_UNIT_PLAN = opts['server-unit'];
    if (opts['import-durations']) env.ADCP_VITEST_IMPORT_DURATIONS = '500';
    if (opts['cpu-prof']) env.ADCP_VITEST_CPU_PROF_DIR = path.join(dir, 'cpu');
    if (opts['heap-prof']) env.ADCP_VITEST_HEAP_PROF_DIR = path.join(dir, 'heap');
  }

  let deadlineMs = null;
  if (cmd.budget) {
    cmd.budget.startedAt ??= Date.now();
    deadlineMs = cmd.budget.startedAt + cmd.budget.seconds * 1000;
  }

  const before = machineState();
  const t0 = Date.now();
  const outFd = openSync(path.join(dir, 'stdout.log'), 'w');
  const errFd = openSync(path.join(dir, 'stderr.log'), 'w');
  const rusageFile = path.join(dir, 'rusage.txt');
  const child = spawn('/usr/bin/time', [TIME_FLAG, '-o', rusageFile, 'sh', '-c', command], {
    cwd: REPO_ROOT, env, detached: true, stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  const sampler = startSampler(child.pid, path.join(dir, 'samples.csv'), Number(opts['sample-ms'] ?? 1000), t0);

  let timedOut = false;
  let killTimer = null;
  if (deadlineMs !== null) {
    const remaining = Math.max(0, deadlineMs - Date.now());
    killTimer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000).unref();
    }, remaining);
  }
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (c, signal) => resolve(c ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1)));
  });
  if (killTimer) clearTimeout(killTimer);
  sampler.stop();
  const t1 = Date.now();

  const report = {
    name: cmd.name,
    index: cmd.index,
    kind: cmd.kind,
    chain: cmd.chain,
    command: cmd.command,
    command_as_run: command,
    budget_s: cmd.budget?.seconds ?? null,
    started_at: new Date(t0).toISOString(),
    ended_at: new Date(t1).toISOString(),
    wall_s: +((t1 - t0) / 1000).toFixed(2),
    exit_code: timedOut ? 124 : code,
    timed_out: timedOut,
    rusage: parseRusage(rusageFile),
    tree: {
      peak_rss_mb: +sampler.state.peakRssMb.toFixed(1),
      peak_cpu_pct: +sampler.state.peakCpuPct.toFixed(0),
      mean_cpu_pct: sampler.state.samples ? +(sampler.state.cpuPctSum / sampler.state.samples).toFixed(0) : null,
      max_procs: sampler.state.maxProcs,
      node_processes_seen: sampler.state.nodePids.size,
    },
    machine_before: before,
    machine_after: machineState(),
  };
  Object.assign(report, collectResults(cmd, dir, report));
  if (opts['cpu-prof']) {
    report.cpu_profile = aggregateCpuProfiles(path.join(dir, 'cpu'), { repoRoot: REPO_ROOT });
    if (report.cpu_profile) writeFileSync(path.join(dir, 'cpu', 'cpu-summary.json'), JSON.stringify(report.cpu_profile, null, 1));
  }
  if (opts['heap-prof']) {
    try { report.heap_profiles = readdirSync(path.join(dir, 'heap')).length; } catch { report.heap_profiles = 0; }
  }
  if (report.exit_code !== 0) report.failure = failureSummary(cmd, dir, report);
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

// ------------------------------------------------------- structured results

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function tail(file, lines) {
  try {
    return readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

function readLog(dir, name) {
  try { return readFileSync(path.join(dir, name), 'utf8').replace(/\u001b\[[0-9;]*m/g, ''); } catch { return ''; }
}

function collectResults(cmd, dir) {
  const out = {};
  if (cmd.kind === 'vitest' || cmd.kind === 'server-unit') {
    const vdir = path.join(dir, 'vitest');
    const timings = existsSync(vdir)
      ? readdirSync(vdir).filter((f) => /^timing-.*\.json$/.test(f)).sort().map((f) => ({ file: f, ...readJson(path.join(vdir, f)) }))
      : [];
    const shardsRecord = readJson(path.join(vdir, 'shards.json'));
    const shards = timings.map((t) => {
      const rec = shardsRecord?.shards?.find((s) => t.shard && s.index === t.shard.index);
      const files = t.files ?? [];
      return {
        shard: t.shard ? `${t.shard.index}/${t.shard.count}` : 'all',
        wall_s: rec ? +((rec.endedAt - rec.startedAt) / 1000).toFixed(1) : +(t.wall_ms / 1000).toFixed(1),
        exit_code: rec?.code ?? null,
        files: files.length,
        tests: files.reduce((a, f) => a + f.tests, 0),
        sum_file_s: +(files.reduce((a, f) => a + f.total_ms, 0) / 1000).toFixed(1),
        sum_prepare_s: +(files.reduce((a, f) => a + f.prepare_ms + f.env_ms, 0) / 1000).toFixed(1),
        sum_setup_s: +(files.reduce((a, f) => a + f.setup_ms, 0) / 1000).toFixed(1),
        sum_collect_s: +(files.reduce((a, f) => a + f.collect_ms, 0) / 1000).toFixed(1),
        sum_tests_s: +(files.reduce((a, f) => a + f.tests_ms, 0) / 1000).toFixed(1),
        failed_files: files.filter((f) => f.state === 'failed').length,
        isolate: t.isolate,
        pool: t.pool,
        max_workers: t.max_workers,
        file_parallelism: t.file_parallelism,
        // Busy time per worker lane (concurrencyId): the balance inside one run.
        lanes: Object.values(files.reduce((acc, f) => {
          const lane = (acc[f.worker] ??= { worker: f.worker, files: 0, busy_s: 0 });
          lane.files += 1;
          lane.busy_s = +(lane.busy_s + f.total_ms / 1000).toFixed(1);
          return acc;
        }, {})),
      };
    });
    const files = timings.flatMap((t) => (t.files ?? []).map((f) => ({
      shard: t.shard ? `${t.shard.index}/${t.shard.count}` : 'all', ...f,
    }))).sort((a, b) => b.total_ms - a.total_ms);
    const imports = new Map();
    for (const t of timings) {
      for (const row of t.top_imports ?? []) {
        const cur = imports.get(row.module) ?? { module: row.module, self_ms: 0, total_ms: 0, count: 0 };
        cur.self_ms += row.self_ms; cur.total_ms += row.total_ms; cur.count += row.count;
        imports.set(row.module, cur);
      }
    }
    const log = readLog(dir, 'stdout.log');
    out.vitest = {
      shards,
      files: files.map(({ failures, module_errors, ...rest }) => rest),
      top_imports: [...imports.values()].sort((a, b) => b.self_ms - a.self_ms).slice(0, 40)
        .map((r) => ({ ...r, self_ms: Math.round(r.self_ms), total_ms: Math.round(r.total_ms) })),
      duration_lines: [...log.matchAll(/^(?:\[shard [^\]]+\] )?\s*Duration\s+.*$/gm)].map((m) => m[0].trim()),
      hints: [...log.matchAll(/^.*(?:faster with|modules were evaluated|workers spawned).*$/gm)].map((m) => m[0].trim()).slice(0, 12),
      rerun: shardsRecord?.rerun ?? null,
      failed: timings.flatMap((t) => (t.files ?? []).filter((f) => f.state === 'failed' || f.failures.length || f.module_errors.length)
        .map((f) => ({ file: f.file, shard: t.shard ? `${t.shard.index}/${t.shard.count}` : 'all', failures: f.failures, module_errors: f.module_errors }))),
      unhandled_errors: timings.flatMap((t) => t.unhandled_errors ?? []),
    };
    if (!timings.length) out.vitest.note = 'No timing report found (the run crashed before reporting, or the plan skipped the suite).';
  }
  if (cmd.kind === 'node-test') {
    const nt = readJson(path.join(dir, 'node-test.json'));
    if (nt) {
      const perFile = new Map();
      for (const t of nt.tests) {
        if (t.nesting !== 0) continue;
        const key = path.relative(REPO_ROOT, t.file ?? '?');
        perFile.set(key, (perFile.get(key) ?? 0) + (t.duration_ms ?? 0));
      }
      out.node_test = {
        tests: nt.tests.filter((t) => t.type === 'test').length,
        failed: nt.tests.filter((t) => t.status === 'failed' && t.type === 'test').length,
        files: [...perFile.entries()].map(([file, ms]) => ({ file, ms: Math.round(ms) })).sort((a, b) => b.ms - a.ms),
      };
    }
  }
  return out;
}

function tsErrors(text) {
  const byFile = new Map();
  for (const m of text.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
    const list = byFile.get(m[1]) ?? [];
    list.push({ line: +m[2], col: +m[3], code: m[4], message: m[5] });
    byFile.set(m[1], list);
  }
  return [...byFile.entries()].map(([file, errors]) => ({ file, count: errors.length, errors: errors.slice(0, 50) }))
    .sort((a, b) => b.count - a.count);
}

function failureSummary(cmd, dir, report) {
  const summary = { exit_code: report.exit_code, timed_out: report.timed_out };
  if (report.timed_out) summary.message = `Killed by the with-timeout budget (${report.budget_s}s for this group).`;
  if (report.vitest) {
    summary.vitest_failed_files = report.vitest.failed;
    if (report.vitest.unhandled_errors.length) summary.unhandled_errors = report.vitest.unhandled_errors;
    if (report.vitest.rerun) summary.serial_rerun = report.vitest.rerun;
  }
  if (cmd.kind === 'node-test') {
    const nt = readJson(path.join(dir, 'node-test.json'));
    summary.node_test_failures = (nt?.tests ?? [])
      .filter((t) => t.status === 'failed' && t.type === 'test')
      .map((t) => ({
        file: path.relative(REPO_ROOT, t.file ?? '?'),
        line: t.line,
        name: t.name,
        message: t.error?.cause?.message ?? t.error?.message,
        expected: t.error?.cause?.expected,
        actual: t.error?.cause?.actual,
        stack: t.error?.cause?.stack ?? t.error?.stack,
      }));
  }
  if (cmd.kind === 'tsc' || cmd.kind === 'tsc-wrapper') {
    summary.typecheck_errors_by_file = tsErrors(readLog(dir, 'stdout.log') + '\n' + readLog(dir, 'stderr.log'));
  }
  summary.stderr_tail = tail(path.join(dir, 'stderr.log'), 40);
  summary.stdout_tail = tail(path.join(dir, 'stdout.log'), 25);
  return summary;
}

// ------------------------------------------------------------------- summary

function buildSummary(runDir) {
  const meta = readJson(path.join(runDir, 'run.json')) ?? {};
  const reports = readdirSync(runDir)
    .filter((d) => /^\d\d-/.test(d) && existsSync(path.join(runDir, d, 'report.json')))
    .sort()
    .map((d) => ({ dir: d, ...readJson(path.join(runDir, d, 'report.json')) }));
  const total = reports.reduce((a, r) => a + r.wall_s, 0);
  const commands = reports.map((r) => ({
    dir: r.dir, name: r.name, kind: r.kind, command: r.command, wall_s: r.wall_s,
    share: total ? +(r.wall_s / total).toFixed(3) : 0,
    exit_code: r.exit_code, timed_out: r.timed_out, budget_s: r.budget_s,
    user_s: r.rusage?.user_s, sys_s: r.rusage?.sys_s, max_rss_mb: r.rusage?.max_rss_mb,
    tree_peak_rss_mb: r.tree?.peak_rss_mb, tree_mean_cpu_pct: r.tree?.mean_cpu_pct,
    cpu_profile: r.cpu_profile ? { profiles: r.cpu_profile.profiles, node_processes_seen: r.tree?.node_processes_seen, categories: r.cpu_profile.categories, buckets: r.cpu_profile.buckets.slice(0, 15), functions: r.cpu_profile.functions.slice(0, 15) } : undefined,
    failure: r.failure,
  }));
  const vitestFiles = reports.flatMap((r) => (r.vitest?.files ?? []).map((f) => ({ command: r.name, ...f })))
    .sort((a, b) => b.total_ms - a.total_ms);
  const summary = {
    run_dir: runDir,
    ...meta,
    total_wall_s: +total.toFixed(1),
    exit_code: meta.exit_code,
    commands_ranked: [...commands].sort((a, b) => b.wall_s - a.wall_s).map((c) => c.name),
    commands,
    vitest_shards: reports.flatMap((r) => (r.vitest?.shards ?? []).map((s) => ({ command: r.name, ...s }))),
    vitest_files_top: vitestFiles.slice(0, 60),
    vitest_files_all: vitestFiles.map((f) => ({ command: f.command, file: f.file, shard: f.shard, total_ms: f.total_ms, collect_ms: f.collect_ms, tests_ms: f.tests_ms, setup_ms: f.setup_ms, prepare_ms: f.prepare_ms + f.env_ms, state: f.state })),
    vitest_top_imports: reports.flatMap((r) => (r.vitest?.top_imports ?? []).map((i) => ({ command: r.name, ...i }))).sort((a, b) => b.self_ms - a.self_ms).slice(0, 30),
    vitest_hints: reports.flatMap((r) => (r.vitest?.hints ?? []).map((h) => `${r.name}: ${h}`)),
    vitest_durations: reports.flatMap((r) => (r.vitest?.duration_lines ?? []).map((h) => `${r.name}: ${h}`)),
    node_test_files: reports.flatMap((r) => (r.node_test?.files ?? []).map((f) => ({ command: r.name, ...f }))).sort((a, b) => b.ms - a.ms),
    failures: commands.filter((c) => c.failure).map((c) => ({ name: c.name, dir: c.dir, ...c.failure })),
  };
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(runDir, 'summary.html'), renderSummaryHtml(summary));
  return summary;
}

// ------------------------------------------------------------------- compare

function compareRuns(dirA, dirB, outFile) {
  const a = readJson(path.join(dirA, 'summary.json')) ?? buildSummary(dirA);
  const b = readJson(path.join(dirB, 'summary.json')) ?? buildSummary(dirB);
  const names = [...new Set([...a.commands.map((c) => c.name), ...b.commands.map((c) => c.name)])];
  const commands = names.map((name) => {
    const ca = a.commands.find((c) => c.name === name);
    const cb = b.commands.find((c) => c.name === name);
    return {
      name,
      a_s: ca?.wall_s ?? null, b_s: cb?.wall_s ?? null,
      delta_s: ca && cb ? +(cb.wall_s - ca.wall_s).toFixed(1) : null,
      a_cpu_s: ca ? +((ca.user_s ?? 0) + (ca.sys_s ?? 0)).toFixed(1) : null,
      b_cpu_s: cb ? +((cb.user_s ?? 0) + (cb.sys_s ?? 0)).toFixed(1) : null,
      a_exit: ca?.exit_code ?? null, b_exit: cb?.exit_code ?? null,
    };
  });
  const key = (f) => `${f.command}::${f.file}`;
  const fa = new Map((a.vitest_files_all ?? []).map((f) => [key(f), f]));
  const fb = new Map((b.vitest_files_all ?? []).map((f) => [key(f), f]));
  const files = [...new Set([...fa.keys(), ...fb.keys()])].map((k) => {
    const x = fa.get(k); const y = fb.get(k);
    return {
      command: (x ?? y).command, file: (x ?? y).file,
      a_ms: x?.total_ms ?? null, b_ms: y?.total_ms ?? null,
      delta_ms: x && y ? Math.round(y.total_ms - x.total_ms) : null,
      a_state: x?.state ?? null, b_state: y?.state ?? null,
    };
  }).sort((p, q) => Math.abs(q.delta_ms ?? 0) - Math.abs(p.delta_ms ?? 0));
  const result = {
    a: { dir: dirA, label: a.label, total_wall_s: a.total_wall_s, exit_code: a.exit_code, machine: a.machine_start, options: a.options },
    b: { dir: dirB, label: b.label, total_wall_s: b.total_wall_s, exit_code: b.exit_code, machine: b.machine_start, options: b.options },
    total_delta_s: +(b.total_wall_s - a.total_wall_s).toFixed(1),
    // Over the commands both runs executed, so --only runs compare fairly.
    common_delta_s: +commands.filter((c) => c.delta_s !== null).reduce((sum, c) => sum + c.delta_s, 0).toFixed(1),
    commands,
    shards: { a: a.vitest_shards, b: b.vitest_shards },
    files_changed_most: files.slice(0, 80),
    files_only_in_a: files.filter((f) => f.b_ms === null).map((f) => f.file),
    files_only_in_b: files.filter((f) => f.a_ms === null).map((f) => f.file),
  };
  const base = outFile ?? path.join(dirB, `compare-${path.basename(dirA)}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${base}.html`, renderCompareHtml(result));
  return { base, result };
}

// ---------------------------------------------------------------------- main

async function runAll(opts) {
  const asHook = !!opts['as-hook'];
  opts['server-unit'] ??= asHook ? 'auto' : 'full';
  if (!['full', 'skip', 'auto'].includes(opts['server-unit'])) throw new Error('--server-unit must be full, skip or auto');
  const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runDir = path.resolve(REPO_ROOT, opts.out ?? '.hook-runs', `${stamp}${opts.label ? `-${String(opts.label).replace(/[^\w.-]+/g, '-')}` : ''}`);
  mkdirSync(runDir, { recursive: true });

  const plan = planCommands();
  const only = opts.only ? String(opts.only).split(',') : null;
  const commands = only ? plan.commands.filter((c) => only.some((o) => c.name.includes(o))) : plan.commands;
  const staged = sh('git', ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const meta = {
    label: opts.label ?? null,
    started_at: new Date().toISOString(),
    git: { head: sh('git', ['rev-parse', 'HEAD']), branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']), staged_count: staged.length, staged_sample: staged.slice(0, 20) },
    node: process.version,
    options: { 'server-unit': opts['server-unit'], 'cpu-prof': !!opts['cpu-prof'], 'import-durations': !!opts['import-durations'], 'heap-prof': !!opts['heap-prof'], 'keep-going': !!opts['keep-going'], 'synthetic-load': Number(opts['synthetic-load'] ?? 0), only, ADCP_TIMEOUT_SCALE: process.env.ADCP_TIMEOUT_SCALE ?? null, ADCP_PRECOMMIT_SERVER_UNIT_SHARDS: process.env.ADCP_PRECOMMIT_SERVER_UNIT_SHARDS ?? null, ADCP_PRECOMMIT_SERVER_UNIT_WORKERS: process.env.ADCP_PRECOMMIT_SERVER_UNIT_WORKERS ?? null, ADCP_PRECOMMIT_SERVER_UNIT_ISOLATE_ALL: process.env.ADCP_PRECOMMIT_SERVER_UNIT_ISOLATE_ALL ?? null },
    plan: commands.map((c) => ({ index: c.index, name: c.name, kind: c.kind, chain: c.chain, command: c.command, budget_s: c.budget?.seconds ?? null })),
    machine_start: machineState(new Set([process.pid])),
  };
  writeFileSync(path.join(runDir, 'machine.json'), JSON.stringify(meta.machine_start, null, 2));
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  const say = (line) => process.stdout.write(`${line}\n`);
  const load = Number(opts['synthetic-load'] ?? 0);
  const hogs = Array.from({ length: Number.isInteger(load) && load > 0 ? load : 0 }, () => spawn('sh', ['-c', 'exec yes > /dev/null'], { stdio: 'ignore', detached: true }));
  const stopHogs = () => { for (const hog of hogs) killTree(hog.pid, 'SIGKILL'); };
  process.on('exit', stopHogs);
  if (hogs.length) say(`  synthetic load: ${hogs.length} busy processes`);
  say(`${asHook ? 'pre-commit' : 'profile-precommit'}: ${commands.length} commands -> ${path.relative(REPO_ROOT, runDir)}`);

  let exitCode = 0;
  for (const cmd of commands) {
    if (exitCode !== 0 && !opts['keep-going']) break;
    if (!asHook) say(`  [${cmd.index}/${plan.commands.length}] ${cmd.name} ...`);
    const report = await runCommand(cmd, runDir, opts);
    const mark = report.exit_code === 0 ? 'ok  ' : 'FAIL';
    say(`  ${mark} ${cmd.name.padEnd(36)} ${report.wall_s.toFixed(1).padStart(7)}s${report.timed_out ? ' (timed out)' : ''}`);
    if (report.exit_code !== 0 && exitCode === 0) exitCode = report.exit_code || 1;
  }
  stopHogs();
  meta.ended_at = new Date().toISOString();
  meta.exit_code = exitCode;
  meta.machine_end = machineState(new Set([process.pid]));
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  const summary = buildSummary(runDir);
  say(`${exitCode === 0 ? 'passed' : `FAILED (exit ${exitCode})`} in ${summary.total_wall_s}s; report: ${path.join(runDir, 'summary.html')}`);
  return exitCode;
}

const { command, opts } = parseArgs(process.argv.slice(2));
try {
  if (process.argv[2] === 'costs') {
    const { runCostsCommand } = await import('./profile-precommit/cost-items.mjs');
    runCostsCommand(process.argv.slice(3));
  } else if (command === 'run') {
    process.exitCode = await runAll(opts);
  } else if (command === 'summarize' && opts._[0]) {
    const s = buildSummary(path.resolve(opts._[0]));
    console.log(path.join(s.run_dir, 'summary.html'));
  } else if (command === 'compare' && opts._.length === 2) {
    const { base } = compareRuns(path.resolve(opts._[0]), path.resolve(opts._[1]), opts.out ? path.resolve(opts.out) : undefined);
    console.log(`${base}.html`);
  } else if (command === 'plan') {
    console.log(JSON.stringify(planCommands().commands.map(({ budget, ...c }) => ({ ...c, budget_s: budget?.seconds ?? null })), null, 2));
  } else {
    console.error('usage: node scripts/profile-precommit.mjs run [--server-unit full|skip|auto] [--cpu-prof] [--label X] | summarize <dir> | compare <a> <b> | plan');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
