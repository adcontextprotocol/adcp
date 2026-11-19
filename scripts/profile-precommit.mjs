#!/usr/bin/env node
// Hook runner and pre-commit profiler. `hook` is what .husky/pre-commit and
// .husky/pre-push run: the hook's steps under one wall-clock budget, with a
// run directory you read instead of the terminal. `run` profiles the
// pre-commit commands.
//
// USAGE
//   node scripts/profile-precommit.mjs hook [--name pre-commit|pre-push] [--budget-s N]
//                                 [--root DIR] [--keep-going] [-- CMD ARGS...]
//   node scripts/profile-precommit.mjs run [options]
//   node scripts/profile-precommit.mjs summarize <run-dir>
//   node scripts/profile-precommit.mjs compare <run-a> <run-b>
//   node scripts/profile-precommit.mjs costs <profile-dir>... [--group dir|subdir] [--repo-root /app] [--out f.json]
//                                 Inclusive CPU cost items over .cpuprofile files.
//   node scripts/profile-precommit.mjs plan
//
// THE PLAN (scripts/profile-precommit/plan.mjs) is derived, not hard-coded:
// `npm run precommit` (one vitest run over the precommit:* projects of the
// root vitest.config.ts since tp-jyw.51) with every `npm run X`
// expanded through package.json into its leaf commands (split on &&).
// `npm run precommit` stays the sequential equivalent.
//
// BUDGET (scripts/profile-precommit/budget.mjs). One wall-clock budget for the
// whole hook, counted from this process's start: pre-commit 120 s, pre-push
// 180 s. First match wins: --budget-s N; ADCP_PRECOMMIT_BUDGET_S or
// ADCP_PREPUSH_BUDGET_S; ADCP_HOOK_BUDGET_S; the default. A value that is not
// a positive number of seconds exits 2 before any step starts. When the
// budget runs out, the runner prints a ⏰ TIMEOUT block naming every step
// still running and how long it ran, stops those steps and everything they
// started, skips the rest and exits 124. ADCP_TIMEOUT_SCALE does not apply.
//
// HOOK (scripts/profile-precommit/runner.mjs). Leaves run exactly as
// package.json writes them, in phases: the concurrency-safe leaves (vitest,
// node:test, tsc and a read-only allowlist) together, then the server unit
// step on its own (it already uses every core), and any other leaf alone, in
// order. A phase runs to the end and reports every failure; a failed phase
// skips the later ones (--keep-going or ADCP_PRECOMMIT_KEEP_GOING=1 runs them
// all). The exit status is the first failing leaf's in plan order (124 when
// the budget ran out), and Ctrl-C stops every running leaf.
// With `-- CMD ARGS...` the hook runs CMD as its single step instead of the
// plan, with the hook's standard input, under the --name hook's budget, and
// sets ADCP_HOOK_RUNNER=<name> for it (.husky/pre-push re-runs itself this
// way; a hook that becomes one command changes only its exec line).
// The terminal gets one line per step, the full output of a phase with a
// single step, and the log tail of every failed step. An advisory root
// (none today; the image check is an advisory test of the vitest run) is
// shown, not fatal. Inside the vitest run, its projects' groups are the
// phases (vitest.config.ts).
// Hook runs write .hook-runs/<stamp>-hook/ (pre-push: <stamp>-pre-push-hook/);
// the newest ADCP_HOOK_RUNS_KEEP (default 20) of each hook are kept. --root
// runs the plan of another tree (tests).
//
// RUN OPTIONS (profiling; sequential unless --concurrent or --as-hook)
//   --server-unit full|skip|auto  Server unit plan (ADCP_PRECOMMIT_SERVER_UNIT_PLAN
//                                 for the vitest leaf). Standalone default: full
//                                 (the path a staged package.json takes);
//                                 --as-hook default: auto (staged files).
//   --root DIR                    Profile the plan of another tree (tests).
//   --label TEXT                  Suffix for the run directory name.
//   --out DIR                     Parent directory (default .hook-runs).
//   --concurrent                  Use the hook's phases instead of running
//                                 one command at a time.
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
//   --as-hook                     The hook's phases, budget and terse terminal
//                                 output; for ADCP_PRECOMMIT_PROFILE=1 in the hook.
//   --budget-s N                  A budget for a standalone run (none by default).
//
// RUN DIRECTORY  .hook-runs/<UTC timestamp>[-label]/ (hook: <stamp>-hook/)
//   run.json                     Options, plan with phases, git state.
//   machine.json                 (run) CPU count, load, memory, competing
//                                processes.
//   summary.json, summary.html   Ranked commands, vitest files, shard balance.
//                                total_wall_s is elapsed time; steps overlap
//                                in concurrent runs (sum_command_wall_s).
//   <NN-command>/
//     report.json                Command, status (passed, failed, advisory,
//                                timed_out, interrupted, skipped), start/end,
//                                wall, exit, failure summary; for `run` also
//                                rusage (user/sys CPU, max RSS of the largest
//                                process) and tree peak RSS.
//     stdout.log, stderr.log     Full output.
//     samples.csv                (run) Every --sample-ms: process count,
//                                summed CPU% and RSS of the command's tree.
//     vitest/ node-test.json     (run) Structured results (vitest timing
//                                reporter, vitest JSON, node:test JSON).
//     cpu/ cpu-summary.json      With --cpu-prof.
//
// WHAT IS NOT COVERED
//   - Forked vitest workers (the `forks` pool) lose a --cpu-prof profile
//     given in NODE_OPTIONS; vitest leaves get it through vitest's --execArgv
//     instead, and the server-unit step through ADCP_VITEST_CPU_PROF_DIR,
//     giving one profile per test file. Under --cpu-prof, ten server test files never
//     finish (their worker idles in the event loop; for example
//     tests/unit/storyboards.test.ts and
//     src/training-agent/identity33/identity33-route.test.ts), so stop a
//     profiling run once the rest finish; the profiles written so far are
//     still aggregated. A process killed by a signal writes no
//     profile; report.json shows profiles written against Node processes
//     seen by the sampler. A profile Node could not write (on a full disk,
//     for example) is listed in report.json as profile_write_errors and
//     printed after the step's status line. tsc is @typescript/native (a Go
//     binary), so the typecheck steps have rusage and samples but no V8
//     profile.
//   - CPU% in samples.csv comes from `ps` (a decaying average); use the
//     rusage user/sys totals for exact CPU time. rusage covers only waited-for
//     descendants, and its max RSS is the single largest process; the
//     tree peak in samples.csv is the summed footprint.
//   - `run` uses macOS tools (/usr/bin/time -l, vm_stat); `hook` uses none.
//
// PROFILED HOOK (optional): ADCP_PRECOMMIT_PROFILE=1 git commit ... makes
// .husky/pre-commit run `run --as-hook` instead of `hook`: the same phases
// and the same pass/fail outcome, plus the profiling data.

import { spawn, execFileSync, execFile } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateCpuProfiles } from './profile-precommit/cpuprofile.mjs';
import { BudgetUsageError, budgetOverrideHint, resolveBudget } from './profile-precommit/budget.mjs';
import { planCommands, phasesOf } from './profile-precommit/plan.mjs';
import { renderCompareHtml } from './profile-precommit/render.mjs';
import { buildSummary, collectResults, readJson } from './profile-precommit/results.mjs';
import { leanLauncher, pruneHookRuns, runPlan } from './profile-precommit/runner.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const NODE_TEST_REPORTER = path.join(SCRIPT_DIR, 'profile-precommit', 'node-test-json-reporter.mjs');
// Keeps --test-force-exit from dropping a file's last results (nodejs/node#64833).
const NODE_TEST_BLOCKING_STDOUT = path.join(SCRIPT_DIR, 'profile-precommit', 'node-test-blocking-stdout.cjs');
const VITEST_TIMING_REPORTER = path.join(SCRIPT_DIR, 'profile-precommit', 'vitest-timing-reporter.mjs');
const COMPETING_RE = 'pre-push|storyboard|git push|vitest|tsc --project';
const DEFAULT_HOOK_RUNS_KEEP = 20;
const FAILURE_LOG_LINES = 200;

// ---------------------------------------------------------------- arguments

// Everything after the first `--` is a command line, kept verbatim.
function parseArgs(argv) {
  const [command, ...all] = argv;
  const end = all.indexOf('--');
  const rest = end === -1 ? all : all.slice(0, end);
  const opts = { _: [], command: end === -1 ? null : all.slice(end + 1) };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    const flag = ['cpu-prof', 'heap-prof', 'keep-going', 'as-hook', 'import-durations', 'concurrent'].includes(key);
    opts[key] = flag ? true : (inline ?? rest[++i]);
  }
  return { command, opts };
}

// ------------------------------------------------------------ instrumentation


// Profiling flags for vitest's workers. A forks-pool worker is stopped with
// SIGTERM and writes its profile on that signal only when the flag is in its
// own execArgv (vitest's nodejs/node#55094 work-around); NODE_OPTIONS alone
// loses it. Worker threads accept the same flags. As the server-unit step
// does (scripts/precommit-server-unit.cjs).
function vitestProfileArgs(dir, opts) {
  const flags = [
    ...(opts['cpu-prof'] ? ['--cpu-prof', `--cpu-prof-dir=${path.join(dir, 'cpu')}`] : []),
    ...(opts['heap-prof'] ? ['--heap-prof', `--heap-prof-dir=${path.join(dir, 'heap')}`] : []),
  ];
  return flags.map((flag) => ` --execArgv=${flag}`).join('');
}

// The leaf command as run: the hook's command plus structured reporters.
function instrument(cmd, dir, opts) {
  switch (cmd.kind) {
    case 'vitest':
      // The JSON report holds every project's results (the server suite's
      // too, since tp-jyw.51), as precommit-server-unit.cjs kept them.
      return `${cmd.command} --reporter=default --reporter=${VITEST_TIMING_REPORTER} --reporter=json --outputFile.json=${path.join(dir, 'vitest', 'all.json')}${opts['import-durations'] ? ' --experimental.importDurations.limit=500' : ''}${vitestProfileArgs(dir, opts)}`;
    case 'node-test':
      return cmd.command.replace(/(\s--test)(\s|$)/, `$1 --require=${NODE_TEST_BLOCKING_STDOUT} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=${NODE_TEST_REPORTER} --test-reporter-destination=${path.join(dir, 'node-test.json')}$2`);
    case 'tsc':
      return `${cmd.command} --pretty false`;
    default:
      return cmd.command;
  }
}

// ------------------------------------------------------------- machine state

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

// Node reports a profile it could not write, or a profile directory it could
// not create, as one line on the process's stderr ("ENOSPC: Failed to write
// file <path>") and still exits 0. Without these lines a full disk shows only
// as a missing or cut-short profile.
const PROFILE_WRITE_ERROR = /^E[A-Z]+: Failed to (?:write file|create (?:CPU|heap) profile directory) .+$/gm;

function profileWriteErrors(stderrFile) {
  let text;
  try { text = readFileSync(stderrFile, 'utf8'); } catch { return []; }
  return [...new Set(text.match(PROFILE_WRITE_ERROR) ?? [])];
}

// The profiling launcher for runner.mjs: the leaf plus structured reporters,
// under /usr/bin/time, with a process-tree sampler and machine state.
function profileLauncher(opts, root) {
  return {
    launch(cmd, dir) {
      const command = instrument(cmd, dir, opts);
      const env = {
        ...process.env,
        PATH: `${path.join(root, 'node_modules', '.bin')}:${process.env.PATH}`,
      };
      const nodeOptions = [];
      if (opts['cpu-prof']) nodeOptions.push('--cpu-prof', `--cpu-prof-dir=${path.join(dir, 'cpu')}`);
      if (opts['heap-prof']) nodeOptions.push('--heap-prof', `--heap-prof-dir=${path.join(dir, 'heap')}`);
      if (nodeOptions.length) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, ...nodeOptions].filter(Boolean).join(' ');
      if (cmd.kind === 'vitest') {
        env.ADCP_VITEST_TIMING_DIR = path.join(dir, 'vitest');
        // The precommit:server-* projects read the plan in vitest.config.ts.
        env.ADCP_PRECOMMIT_SERVER_UNIT_PLAN = opts['server-unit'];
      }
      if (cmd.kind === 'server-unit') {
        env.ADCP_PRECOMMIT_REPORT_DIR = path.join(dir, 'vitest');
        env.ADCP_VITEST_TIMING_DIR = path.join(dir, 'vitest');
        env.ADCP_PRECOMMIT_SERVER_UNIT_PLAN = opts['server-unit'];
        if (opts['import-durations']) env.ADCP_VITEST_IMPORT_DURATIONS = '500';
        if (opts['cpu-prof']) env.ADCP_VITEST_CPU_PROF_DIR = path.join(dir, 'cpu');
        if (opts['heap-prof']) env.ADCP_VITEST_HEAP_PROF_DIR = path.join(dir, 'heap');
      }

      const before = machineState();
      const t0 = Date.now();
      const outFd = openSync(path.join(dir, 'stdout.log'), 'w');
      const errFd = openSync(path.join(dir, 'stderr.log'), 'w');
      const rusageFile = path.join(dir, 'rusage.txt');
      const child = spawn('/usr/bin/time', [TIME_FLAG, '-o', rusageFile, 'sh', '-c', command], {
        cwd: root, env, detached: true, stdio: ['ignore', outFd, errFd],
      });
      closeSync(outFd);
      closeSync(errFd);
      const sampler = startSampler(child.pid, path.join(dir, 'samples.csv'), Number(opts['sample-ms'] ?? 1000), t0);

      const finish = async () => {
        sampler.stop();
        const extra = {
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
          ...collectResults(cmd, dir, root),
        };
        if (opts['cpu-prof']) {
          extra.cpu_profile = aggregateCpuProfiles(path.join(dir, 'cpu'), { repoRoot: root });
          if (extra.cpu_profile) writeFileSync(path.join(dir, 'cpu', 'cpu-summary.json'), JSON.stringify(extra.cpu_profile, null, 1));
        }
        if (opts['heap-prof']) {
          try { extra.heap_profiles = readdirSync(path.join(dir, 'heap')).length; } catch { extra.heap_profiles = 0; }
        }
        if (opts['cpu-prof'] || opts['heap-prof']) {
          const writeErrors = profileWriteErrors(path.join(dir, 'stderr.log'));
          if (writeErrors.length) extra.profile_write_errors = writeErrors;
        }
        return extra;
      };
      return { child, commandAsRun: command, done: Promise.resolve(), finish };
    },
  };
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
// ---------------------------------------------------------------- terminal

const say = (line) => process.stdout.write(`${line}\n`);

const STATUS_MARK = {
  passed: 'ok  ', failed: 'FAIL', timed_out: 'TIME', interrupted: 'INT ', advisory: 'warn', skipped: 'skip',
};

function statusLine(report) {
  const mark = STATUS_MARK[report.status] ?? report.status;
  const wall = report.status === 'skipped' ? '      -' : `${report.wall_s.toFixed(1).padStart(6)}s`;
  const note = report.status === 'skipped' ? `  (${report.skipped_because})`
    : report.status === 'timed_out' ? '  (stopped: the hook budget ran out)'
    : report.status === 'advisory' ? `  (exit ${report.exit_code}; advisory, does not block the commit)`
      : report.exit_code ? `  (exit ${report.exit_code})` : '';
  return `  ${mark} ${report.name.padEnd(40)} ${wall}${note}`;
}

function logTail(file, lines) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { text: '', cut: 0 }; }
  const all = text.replace(/\n$/, '').split('\n');
  return { text: all.slice(-lines).join('\n'), cut: Math.max(0, all.length - lines) };
}

// A failed step's output, printed when it ends (concurrent steps' output is
// only in their logs). A step that streamed live already showed it.
function printStepOutput(report, dir, streamed) {
  if (streamed || !['failed', 'timed_out', 'advisory'].includes(report.status)) return;
  for (const name of ['stdout.log', 'stderr.log']) {
    const file = path.join(dir, name);
    const { text, cut } = logTail(file, FAILURE_LOG_LINES);
    if (!text.trim()) continue;
    const sink = name === 'stderr.log' ? process.stderr : process.stdout;
    sink.write(`  ----- ${report.name}: ${name}${cut ? ` (last ${FAILURE_LOG_LINES} lines; full log ${file})` : ''}\n${text}\n  ----- end of ${report.name} ${name}\n`);
  }
}

function utcStamp(withMs) {
  const iso = new Date().toISOString().replace(/[:]/g, '');
  return withMs ? iso : iso.replace(/\.\d+Z$/, 'Z');
}

function sh(command, args, cwd = REPO_ROOT) {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function gitState(root) {
  const staged = sh('git', ['diff', '--cached', '--name-only'], root).split('\n').filter(Boolean);
  return { head: sh('git', ['rev-parse', 'HEAD'], root), branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root), staged_count: staged.length, staged_sample: staged.slice(0, 20) };
}

function planMeta(commands, phases) {
  const phaseOf = new Map(phases.flatMap((phase, i) => phase.map((c) => [c.index, i + 1])));
  return commands.map((c) => ({
    index: c.index, name: c.name, kind: c.kind, lane: c.lane, phase: phaseOf.get(c.index) ?? null,
    advisory: c.advisory, chain: c.chain, command: c.command,
  }));
}

// -------------------------------------------------------------------- hook

// A command line as text, for reports: words quoted only where needed.
function shellText(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}

// The budget from --budget-s and the environment; a usage error is printed
// and returned as null.
function hookBudget(hook, opts) {
  try {
    return resolveBudget({ hook, arg: opts['budget-s'], hasArg: 'budget-s' in opts, env: process.env });
  } catch (error) {
    if (!(error instanceof BudgetUsageError)) throw error;
    process.stderr.write(`${hook}: ${error.message}\n`);
    return null;
  }
}

// The block printed when the budget runs out: what was still running and how
// long it ran, and how to change the budget.
function printBudgetExpiry(budget, running) {
  const from = budget.source === 'default' ? 'the default' : `from ${budget.source}`;
  const lines = [`⏰ TIMEOUT: ${budget.hook} used its ${budget.seconds} s budget (${from}). To change it, ${budgetOverrideHint(budget.hook)}.`];
  if (!running.length) lines.push('  No step was running; the steps not yet started are skipped.');
  else lines.push('  Stopping the steps still running:');
  for (const step of running) {
    lines.push(`  - ${step.name}${step.command ? ` (${step.command.slice(0, 200)})` : ''}: ran ${step.ran_s.toFixed(1)} s`);
    for (const c of step.commands) lines.push(`      ${c.command.slice(0, 200)}${c.ran_s === null ? '' : `: ran ${c.ran_s} s`}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function runHook(opts) {
  const hook = opts.name ?? 'pre-commit';
  const budget = hookBudget(hook, opts);
  if (!budget) return 2;
  if (opts.command && !opts.command.length) {
    process.stderr.write(`${hook}: nothing to run after --\n`);
    return 2;
  }
  const root = path.resolve(opts.root ?? REPO_ROOT);
  const parent = path.join(root, '.hook-runs');
  const suffix = hook === 'pre-commit' ? 'hook' : `${hook}-hook`;
  let runDir = path.join(parent, `${utcStamp(true)}-${suffix}`);
  for (let n = 2; existsSync(runDir); n += 1) runDir = path.join(parent, `${utcStamp(true)}.${n}-${suffix}`);
  mkdirSync(runDir, { recursive: true });

  const keepGoing = !!opts['keep-going'] || process.env.ADCP_PRECOMMIT_KEEP_GOING === '1';
  // The plan, or the given command as the hook's single step.
  const commands = opts.command
    ? [{
      index: 1, name: hook, slug: `01-${hook}`, kind: 'command', lane: 'barrier', chain: [], advisory: false,
      command: shellText(opts.command), argv: opts.command, env: { ADCP_HOOK_RUNNER: hook },
    }]
    : planCommands({ root }).commands;
  const phases = phasesOf(commands);
  const meta = {
    mode: 'hook',
    hook,
    started_at: new Date().toISOString(),
    git: gitState(root),
    node: process.version,
    options: { keep_going: keepGoing },
    plan: planMeta(commands, phases),
  };
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  say(`${hook}: ${commands.length} steps in ${phases.length} phases, budget ${budget.seconds} s; logs in ${path.relative(root, runDir)}`);
  if (process.env.ADCP_TIMEOUT_SCALE) say(`${hook}: ADCP_TIMEOUT_SCALE does not apply to hooks; to change the budget, ${budgetOverrideHint(hook)}`);

  const result = await runPlan({
    root, runDir, phases, keepGoing, live: true, budget,
    launcher: leanLauncher({ root }),
    onFinish: (report, dir) => {
      say(statusLine(report));
      printStepOutput(report, dir, report.streamed);
    },
    onBudgetExpired: printBudgetExpiry,
  });
  const { exitCode, interrupted } = result;
  meta.ended_at = new Date().toISOString();
  meta.exit_code = exitCode;
  meta.budget = result.budget;
  if (interrupted) meta.interrupted_by = interrupted;
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  const summary = buildSummary(runDir);
  const keep = Number(process.env.ADCP_HOOK_RUNS_KEEP ?? DEFAULT_HOOK_RUNS_KEEP);
  pruneHookRuns(parent, Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_HOOK_RUNS_KEEP, hook);
  const verdict = interrupted ? `INTERRUPTED (${interrupted})`
    : result.budget?.expired_at ? `FAILED (the ${budget.seconds} s budget ran out; exit ${exitCode})`
      : exitCode === 0 ? 'passed' : `FAILED (exit ${exitCode})`;
  say(`${hook}: ${verdict} in ${summary.total_wall_s}s; report: ${path.join(runDir, 'summary.html')}`);
  return exitCode;
}

// ---------------------------------------------------------------- profiling

async function runAll(opts) {
  const asHook = !!opts['as-hook'];
  opts['server-unit'] ??= asHook ? 'auto' : 'full';
  if (!['full', 'skip', 'auto'].includes(opts['server-unit'])) throw new Error('--server-unit must be full, skip or auto');
  // The hook's budget under --as-hook; a standalone run has one only when asked.
  const budget = asHook || 'budget-s' in opts ? hookBudget('pre-commit', opts) : null;
  if ((asHook || 'budget-s' in opts) && !budget) return 2;
  const root = path.resolve(opts.root ?? REPO_ROOT);
  const runDir = path.resolve(root, opts.out ?? '.hook-runs', `${utcStamp(false)}${opts.label ? `-${String(opts.label).replace(/[^\w.-]+/g, '-')}` : ''}`);
  mkdirSync(runDir, { recursive: true });

  const plan = planCommands({ root });
  const only = opts.only ? String(opts.only).split(',') : null;
  const commands = only ? plan.commands.filter((c) => only.some((o) => c.name.includes(o))) : plan.commands;
  const concurrent = asHook || !!opts.concurrent;
  const phases = concurrent ? phasesOf(commands) : commands.map((c) => [c]);
  const meta = {
    mode: 'profile',
    label: opts.label ?? null,
    started_at: new Date().toISOString(),
    git: gitState(root),
    node: process.version,
    options: { 'server-unit': opts['server-unit'], concurrent, 'cpu-prof': !!opts['cpu-prof'], 'import-durations': !!opts['import-durations'], 'heap-prof': !!opts['heap-prof'], 'keep-going': !!opts['keep-going'], 'synthetic-load': Number(opts['synthetic-load'] ?? 0), only, ADCP_PRECOMMIT_SERVER_UNIT_SHARDS: process.env.ADCP_PRECOMMIT_SERVER_UNIT_SHARDS ?? null, ADCP_PRECOMMIT_SERVER_UNIT_WORKERS: process.env.ADCP_PRECOMMIT_SERVER_UNIT_WORKERS ?? null, ADCP_PRECOMMIT_SERVER_UNIT_ISOLATE_ALL: process.env.ADCP_PRECOMMIT_SERVER_UNIT_ISOLATE_ALL ?? null, NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? null, NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE ?? null },
    plan: planMeta(commands, phases),
    machine_start: machineState(new Set([process.pid])),
  };
  writeFileSync(path.join(runDir, 'machine.json'), JSON.stringify(meta.machine_start, null, 2));
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  const load = Number(opts['synthetic-load'] ?? 0);
  const hogs = Array.from({ length: Number.isInteger(load) && load > 0 ? load : 0 }, () => spawn('sh', ['-c', 'exec yes > /dev/null'], { stdio: 'ignore', detached: true }));
  const stopHogs = () => { for (const hog of hogs) killTree(hog.pid, 'SIGKILL'); };
  process.on('exit', stopHogs);
  if (hogs.length) say(`  synthetic load: ${hogs.length} busy processes`);
  say(`${asHook ? 'pre-commit' : 'profile-precommit'}: ${commands.length} commands${concurrent ? ` in ${phases.length} phases` : ''} -> ${path.relative(root, runDir)}`);

  const result = await runPlan({
    root, runDir, phases, keepGoing: !!opts['keep-going'], budget,
    launcher: profileLauncher(opts, root),
    onStart: (cmd) => { if (!asHook) say(`  [${cmd.index}/${plan.commands.length}] ${cmd.name} ...`); },
    onFinish: (report, dir) => {
      say(statusLine(report));
      if (report.profile_write_errors) {
        process.stderr.write(`  ${report.name}: ${report.profile_write_errors.length} profile write(s) failed; those profiles are missing or cut short:\n${report.profile_write_errors.map((line) => `    ${line}\n`).join('')}`);
      }
      if (asHook) printStepOutput(report, dir, false);
    },
    onBudgetExpired: printBudgetExpiry,
  });
  const { exitCode, interrupted } = result;
  stopHogs();
  meta.ended_at = new Date().toISOString();
  meta.exit_code = exitCode;
  meta.budget = result.budget;
  if (interrupted) meta.interrupted_by = interrupted;
  meta.machine_end = machineState(new Set([process.pid]));
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2));
  const summary = buildSummary(runDir);
  say(`${exitCode === 0 ? 'passed' : `FAILED (exit ${exitCode})`} in ${summary.total_wall_s}s; report: ${path.join(runDir, 'summary.html')}`);
  return exitCode;
}

// ---------------------------------------------------------------------- main

const { command, opts } = parseArgs(process.argv.slice(2));
try {
  if (process.argv[2] === 'costs') {
    const { runCostsCommand } = await import('./profile-precommit/cost-items.mjs');
    runCostsCommand(process.argv.slice(3));
  } else if (command === 'hook') {
    process.exitCode = await runHook(opts);
  } else if (command === 'run') {
    process.exitCode = await runAll(opts);
  } else if (command === 'summarize' && opts._[0]) {
    const s = buildSummary(path.resolve(opts._[0]));
    console.log(path.join(s.run_dir, 'summary.html'));
  } else if (command === 'compare' && opts._.length === 2) {
    const { base } = compareRuns(path.resolve(opts._[0]), path.resolve(opts._[1]), opts.out ? path.resolve(opts.out) : undefined);
    console.log(`${base}.html`);
  } else if (command === 'plan') {
    const root = path.resolve(opts.root ?? REPO_ROOT);
    const { commands } = planCommands({ root });
    console.log(JSON.stringify(planMeta(commands, phasesOf(commands)), null, 2));
  } else {
    console.error('usage: node scripts/profile-precommit.mjs hook [--name pre-commit|pre-push] [--budget-s N] [--root DIR] [--keep-going] [-- CMD ARGS...] | run [--root DIR] [--server-unit full|skip|auto] [--concurrent] [--cpu-prof] [--label X] | summarize <dir> | compare <a> <b> | plan');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
