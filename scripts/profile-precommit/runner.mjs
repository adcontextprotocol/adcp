// Runs a hook's steps phase by phase and writes one report directory per
// step, in the layout scripts/profile-precommit.mjs reads (report.json,
// stdout.log, stderr.log). The steps are the pre-commit plan
// (scripts/profile-precommit/plan.mjs), or one command run as the hook's
// single step (`profile-precommit.mjs hook --name pre-push -- sh .husky/pre-push`).
//
// Scheduling: the leaves of a phase start together and the phase waits for
// all of them (collect-all), so one run shows every failing light check. A
// failed phase skips the phases after it (fail-fast between phases), which
// is where the time is: the server unit phase. --keep-going runs them all.
// The exit status is the first failing leaf's, in plan order, as the old
// sequential && chain reported it.
//
// Budget: one wall-clock deadline for the whole hook (budget.mjs), counted
// from the runner's process start. When it passes, the runner names every
// step still running and how long it ran (for a command step, also the
// commands it was running), SIGTERMs the process group of each running step
// and of every process the step started (some start their children in groups
// of their own), SIGKILLs whatever is left STOP_GRACE_MS later, skips the
// steps not yet started and exits 124.
//
// Signals: SIGINT, SIGTERM and SIGHUP are forwarded to every running leaf's
// process group (leaves are detached, so the terminal's Ctrl-C reaches only
// this process); the run then exits 128 + signal number.
//
// Leftovers: each leaf runs in its own process group, and when the leaf's
// process exits, for whatever reason, the rest of its group gets SIGTERM and
// then SIGKILL after the grace period. A vitest forks-pool worker whose main
// process crashed or was OOM-killed waits on it forever; this is what stops
// it. The leaf's exit status is still the one it reported.

import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { descendantsOf, processTable } from './budget.mjs';
import { failureSummary } from './results.mjs';

const KILL_GRACE_MS = 5000;
// After the budget runs out: SIGTERM, then SIGKILL this much later (vitest
// gives its own workers the same 500 ms).
const STOP_GRACE_MS = 500;
// How long a stopped step's output pipes may stay open after the SIGKILL
// sweep before the runner stops waiting for them.
const PIPE_DRAIN_MS = 1000;
export const BUDGET_EXIT_CODE = 124;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function killPid(pid, signal) {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

function stopChild(child) {
  if (child.stopping) return;
  child.stopping = true;
  killGroup(child.pid, 'SIGTERM');
}

// After a leaf's process exits, its group can still hold processes: workers
// its main process left behind, or ones that shut down slowly or ignore
// SIGTERM. SIGTERM the group unless the runner already did, wait for it to
// go and SIGKILL it after the grace period, as with-timeout.sh's --kill-after
// does, so nothing outlives the step (or the runner).
async function reapGroup(child) {
  if (!groupAlive(child.pid)) return;
  if (!child.stopping) killGroup(child.pid, 'SIGTERM');
  const end = Date.now() + KILL_GRACE_MS;
  while (groupAlive(child.pid) && Date.now() < end) await delay(100);
  if (!groupAlive(child.pid)) return;
  killGroup(child.pid, 'SIGKILL');
  const killEnd = Date.now() + 1000;
  while (groupAlive(child.pid) && Date.now() < killEnd) await delay(50);
}

export function exitCodeOf(code, signal) {
  if (code !== null && code !== undefined) return code;
  return signal ? 128 + (os.constants.signals[signal] ?? 1) : 1;
}

// The hook's launcher. A plan leaf runs exactly as package.json has it,
// through `sh -c`; a command step (cmd.argv) runs as given, with the hook's
// standard input when that is not a terminal (git feeds pre-push the refs on
// it; a detached group reading a terminal would be stopped). Both get
// <root>/node_modules/.bin first on PATH (as .husky/* and npm run arrange)
// and cmd.env. `live` also copies the output to the terminal; used when a
// phase has a single step.
export function leanLauncher({ root, env = process.env }) {
  const baseEnv = { ...env, PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${env.PATH ?? ''}` };
  return {
    launch(cmd, dir, { live }) {
      const stdoutPath = path.join(dir, 'stdout.log');
      const stderrPath = path.join(dir, 'stderr.log');
      const [file, args] = cmd.argv ? [cmd.argv[0], cmd.argv.slice(1)] : ['sh', ['-c', cmd.command]];
      const stdin = cmd.argv && !process.stdin.isTTY ? 'inherit' : 'ignore';
      const options = { cwd: root, env: { ...baseEnv, ...cmd.env }, detached: true };
      if (!live) {
        const outFd = openSync(stdoutPath, 'w');
        const errFd = openSync(stderrPath, 'w');
        const child = spawn(file, args, { ...options, stdio: [stdin, outFd, errFd] });
        closeSync(outFd);
        closeSync(errFd);
        return { child, commandAsRun: cmd.command, done: Promise.resolve() };
      }
      const child = spawn(file, args, { ...options, stdio: [stdin, 'pipe', 'pipe'] });
      const done = Promise.all([[child.stdout, stdoutPath, process.stdout], [child.stderr, stderrPath, process.stderr]].map(([stream, file, terminal]) => {
        const sink = createWriteStream(file);
        stream.on('data', (chunk) => { sink.write(chunk); terminal.write(chunk); });
        return new Promise((resolve) => stream.on('end', () => sink.end(resolve)));
      }));
      return { child, commandAsRun: cmd.command, done };
    },
  };
}

function statusOf({ code, timedOut, interrupted, advisory }) {
  if (code === 0) return 'passed';
  if (interrupted) return 'interrupted';
  if (timedOut) return 'timed_out';
  return advisory ? 'advisory' : 'failed';
}

async function runStep(cmd, ctx, live) {
  const dir = path.join(ctx.runDir, cmd.slug);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const launched = ctx.launcher.launch(cmd, dir, { live });
  const { child } = launched;
  child.step = { name: cmd.name, startedAt: t0, command: cmd.argv ? cmd.command : null };
  ctx.running.add(child);
  ctx.onStart?.(cmd, child);

  // 'exit', not 'close': a leftover process can hold the leaf's output pipes
  // open, and only the reap below ends it.
  const [code, signal] = await new Promise((resolve) => {
    child.on('error', () => resolve([127, null]));
    child.on('exit', (c, s) => resolve([c, s]));
  });
  await reapGroup(child);
  ctx.running.delete(child);
  // A process outside the step's group that the budget sweep missed could
  // hold the pipes forever; after a budget stop, stop waiting for them. The
  // timer is unref'd so it never keeps the hook alive by itself.
  const drained = () => new Promise((r) => { setTimeout(r, PIPE_DRAIN_MS).unref(); });
  await (child.timedOut ? Promise.race([launched.done, ctx.budgetSwept.then(drained)]) : launched.done);
  const t1 = Date.now();
  const exitCode = exitCodeOf(code, signal);
  const timedOut = !!child.timedOut;

  const report = {
    name: cmd.name,
    index: cmd.index,
    kind: cmd.kind,
    lane: cmd.lane,
    chain: cmd.chain,
    command: cmd.command,
    command_as_run: launched.commandAsRun,
    advisory: !!cmd.advisory,
    budget_s: ctx.budget?.seconds ?? null,
    started_at: new Date(t0).toISOString(),
    ended_at: new Date(t1).toISOString(),
    wall_s: +((t1 - t0) / 1000).toFixed(2),
    exit_code: exitCode,
    timed_out: timedOut,
    streamed: !!live,
    status: statusOf({ code: exitCode, timedOut, interrupted: !!ctx.interrupted, advisory: cmd.advisory }),
  };
  if (launched.finish) Object.assign(report, await launched.finish(report));
  if (report.exit_code !== 0) report.failure = failureSummary(cmd, dir, report, ctx.root);
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  ctx.onFinish?.(report, dir);
  return report;
}

function writeSkipped(cmd, ctx, reason) {
  const dir = path.join(ctx.runDir, cmd.slug);
  mkdirSync(dir, { recursive: true });
  const report = {
    name: cmd.name, index: cmd.index, kind: cmd.kind, lane: cmd.lane, chain: cmd.chain, command: cmd.command,
    advisory: !!cmd.advisory, budget_s: ctx.budget?.seconds ?? null, wall_s: 0, exit_code: null, timed_out: false,
    status: 'skipped', skipped_because: reason,
  };
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  ctx.onFinish?.(report, dir);
  return report;
}

// Process groups to stop for the running steps: each step's own group and the
// group of every process it started, by parent pid (a process that moved to
// a group of its own keeps its parent). Never the runner's own group.
function stopTargets(table, children) {
  const ownGroup = table.find((p) => p.pid === process.pid)?.pgid;
  const groups = new Set();
  const pids = new Set();
  for (const child of children) {
    groups.add(child.pid);
    for (const p of descendantsOf(table, child.pid)) {
      pids.add(p.pid);
      if (p.pgid > 1) groups.add(p.pgid);
    }
  }
  groups.delete(ownGroup);
  pids.delete(process.pid);
  return { groups, pids };
}

// The budget ran out: record what was running, then stop it all.
function expireBudget(ctx) {
  const now = Date.now();
  const children = [...ctx.running];
  const table = processTable();
  const running = children.map((child) => ({
    name: child.step.name,
    ...(child.step.command ? { command: child.step.command } : {}),
    ran_s: +((now - child.step.startedAt) / 1000).toFixed(1),
    // A command step may be a script; what it was running is its own children.
    commands: child.step.command
      ? table.filter((p) => p.ppid === child.pid).map((p) => ({ command: p.command, ran_s: p.ran_s }))
      : [],
  }));
  ctx.budget.expired = { at: now, running };
  ctx.onBudgetExpired?.(ctx.budget, running);

  const first = stopTargets(table, children);
  for (const child of children) { child.timedOut = true; child.stopping = true; }
  for (const group of first.groups) killGroup(group, 'SIGTERM');
  for (const pid of first.pids) killPid(pid, 'SIGTERM');
  setTimeout(() => {
    // Processes started during the grace period, and the first snapshot's,
    // whose parents may have exited since.
    const again = stopTargets(processTable(), children);
    for (const group of new Set([...first.groups, ...again.groups])) if (groupAlive(group)) killGroup(group, 'SIGKILL');
    for (const pid of new Set([...first.pids, ...again.pids])) killPid(pid, 'SIGKILL');
    ctx.markSwept();
  }, STOP_GRACE_MS);
}

/**
 * Runs the phases. `budget` ({hook, seconds, source}, from budget.mjs) sets
 * the hook's deadline, counted from this process's start; null runs without
 * one. Returns {exitCode, reports, interrupted, budget} where budget is the
 * record for run.json.
 */
export async function runPlan({ root, runDir, phases, launcher, budget = null, keepGoing = false, live = false, onStart, onFinish, onBudgetExpired }) {
  let markSwept;
  const ctx = {
    root, runDir, launcher, running: new Set(), interrupted: null, onStart, onFinish, onBudgetExpired,
    budget: budget ? { ...budget, deadlineAt: Math.round(performance.timeOrigin + budget.seconds * 1000), expired: null } : null,
    budgetSwept: new Promise((resolve) => { markSwept = resolve; }),
    markSwept: () => markSwept(),
  };
  const onSignal = (signal) => {
    if (ctx.interrupted) return;
    ctx.interrupted = signal;
    for (const child of ctx.running) stopChild(child);
  };
  const handlers = FORWARDED_SIGNALS.map((signal) => [signal, () => onSignal(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const budgetTimer = ctx.budget
    ? setTimeout(() => { if (!ctx.interrupted) expireBudget(ctx); }, Math.max(0, ctx.budget.deadlineAt - Date.now()))
    : null;

  const reports = [];
  let exitCode = 0;
  try {
    for (const phase of phases) {
      if (ctx.interrupted) { reports.push(...phase.map((c) => writeSkipped(c, ctx, `interrupted by ${ctx.interrupted}`))); continue; }
      if (ctx.budget?.expired) { reports.push(...phase.map((c) => writeSkipped(c, ctx, 'the hook budget ran out'))); continue; }
      if (exitCode !== 0 && !keepGoing) { reports.push(...phase.map((c) => writeSkipped(c, ctx, 'an earlier phase failed'))); continue; }
      const results = await Promise.all(phase.map((c) => runStep(c, ctx, live && phase.length === 1)));
      const failed = results.filter((r) => r.exit_code !== 0 && !r.advisory).sort((a, b) => a.index - b.index);
      if (failed.length && exitCode === 0) exitCode = failed[0].exit_code || 1;
      reports.push(...results);
    }
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    // Only reached with leaves still running if a step threw; stop them.
    for (const child of ctx.running) stopChild(child);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (ctx.budget?.expired) exitCode = BUDGET_EXIT_CODE;
  if (ctx.interrupted) exitCode = 128 + (os.constants.signals[ctx.interrupted] ?? 1);
  reports.sort((a, b) => a.index - b.index);
  const budgetRecord = ctx.budget && {
    hook: ctx.budget.hook,
    seconds: ctx.budget.seconds,
    source: ctx.budget.source,
    deadline_at: new Date(ctx.budget.deadlineAt).toISOString(),
    expired_at: ctx.budget.expired ? new Date(ctx.budget.expired.at).toISOString() : null,
    running: ctx.budget.expired?.running ?? null,
  };
  return { exitCode, reports, interrupted: ctx.interrupted, budget: budgetRecord };
}

// Keep the newest `keep` hook-mode run directories of `hook` (run.json mode
// "hook"; runs without a hook name are pre-commit's); profiling runs are
// never removed.
export function pruneHookRuns(parent, keep, hook = 'pre-commit') {
  if (!Number.isInteger(keep) || keep < 1 || !existsSync(parent)) return [];
  const hookRuns = readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        const meta = JSON.parse(readFileSync(path.join(parent, name, 'run.json'), 'utf8'));
        return meta.mode === 'hook' && (meta.hook ?? 'pre-commit') === hook;
      } catch { return false; }
    })
    .sort();
  const removed = hookRuns.slice(0, Math.max(0, hookRuns.length - keep));
  for (const name of removed) rmSync(path.join(parent, name), { recursive: true, force: true });
  return removed;
}
