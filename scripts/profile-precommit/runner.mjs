// Runs a pre-commit plan (scripts/profile-precommit/plan.mjs) phase by phase
// and writes one report directory per step, in the layout
// scripts/profile-precommit.mjs reads (report.json, stdout.log, stderr.log).
//
// Scheduling: the leaves of a phase start together and the phase waits for
// all of them (collect-all), so one run shows every failing light check. A
// failed phase skips the phases after it (fail-fast between phases), which
// is where the time is: the server unit phase. --keep-going runs them all.
// The exit status is the first failing leaf's, in plan order, as the old
// sequential && chain reported it.
//
// Budgets: a `with-timeout.sh N` group's deadline runs from its first leaf's
// start. On expiry its leaves get SIGTERM, then SIGKILL 5 s later, and the
// runner prints with-timeout.sh's marker once for the group.
//
// Signals: SIGINT, SIGTERM and SIGHUP are forwarded to every running leaf's
// process group (leaves are detached, so the terminal's Ctrl-C reaches only
// this process); the run then exits 128 + signal number.

import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failureSummary } from './results.mjs';

const KILL_GRACE_MS = 5000;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

function stopChild(child) {
  if (child.stopping) return;
  child.stopping = true;
  killGroup(child.pid, 'SIGTERM');
}

// After a stopped leaf's shell exits, its group can still hold processes that
// shut down slowly or ignore SIGTERM. Wait for the group to go, SIGKILL it
// after the grace period, as with-timeout.sh's --kill-after does, so nothing
// outlives the step (or the runner).
async function reapStoppedGroup(child) {
  const end = Date.now() + KILL_GRACE_MS;
  while (groupAlive(child.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  if (!groupAlive(child.pid)) return;
  killGroup(child.pid, 'SIGKILL');
  const killEnd = Date.now() + 1000;
  while (groupAlive(child.pid) && Date.now() < killEnd) await new Promise((r) => setTimeout(r, 50));
}

export function exitCodeOf(code, signal) {
  if (code !== null && code !== undefined) return code;
  return signal ? 128 + (os.constants.signals[signal] ?? 1) : 1;
}

// The hook's launcher: the leaf string exactly as package.json has it,
// through `sh -c`, with <root>/node_modules/.bin first on PATH (as
// .husky/pre-commit and npm run both arrange). `live` also copies the
// output to the terminal; used when a phase has a single step.
export function leanLauncher({ root, env = process.env }) {
  const childEnv = { ...env, PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${env.PATH ?? ''}` };
  return {
    launch(cmd, dir, { live }) {
      const stdoutPath = path.join(dir, 'stdout.log');
      const stderrPath = path.join(dir, 'stderr.log');
      if (!live) {
        const outFd = openSync(stdoutPath, 'w');
        const errFd = openSync(stderrPath, 'w');
        const child = spawn('sh', ['-c', cmd.command], { cwd: root, env: childEnv, detached: true, stdio: ['ignore', outFd, errFd] });
        closeSync(outFd);
        closeSync(errFd);
        return { child, commandAsRun: cmd.command, done: Promise.resolve() };
      }
      const child = spawn('sh', ['-c', cmd.command], { cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (cmd.budget) cmd.budget.startedAt ??= t0;
  const launched = ctx.launcher.launch(cmd, dir, { live });
  const { child } = launched;
  ctx.running.add(child);
  ctx.onStart?.(cmd, child);

  let timedOut = false;
  let budgetTimer = null;
  if (cmd.budget) {
    const remaining = Math.max(0, cmd.budget.startedAt + cmd.budget.seconds * 1000 - Date.now());
    budgetTimer = setTimeout(() => {
      timedOut = true;
      cmd.budget.fired ??= { at: Date.now() };
      stopChild(child);
    }, remaining);
  }
  const [code, signal] = await new Promise((resolve) => {
    child.on('error', () => resolve([127, null]));
    child.on('close', (c, s) => resolve([c, s]));
  });
  if (budgetTimer) clearTimeout(budgetTimer);
  if (child.stopping) await reapStoppedGroup(child);
  ctx.running.delete(child);
  await launched.done;
  const t1 = Date.now();
  const exitCode = exitCodeOf(code, signal);
  if (timedOut && cmd.budget.fired.code === undefined) Object.assign(cmd.budget.fired, { code: exitCode, endedAt: t1 });

  const report = {
    name: cmd.name,
    index: cmd.index,
    kind: cmd.kind,
    lane: cmd.lane,
    chain: cmd.chain,
    command: cmd.command,
    command_as_run: launched.commandAsRun,
    advisory: !!cmd.advisory,
    budget_s: cmd.budget?.seconds ?? null,
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
    advisory: !!cmd.advisory, budget_s: cmd.budget?.seconds ?? null, wall_s: 0, exit_code: null, timed_out: false,
    status: 'skipped', skipped_because: reason,
  };
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  ctx.onFinish?.(report, dir);
  return report;
}

// The line scripts/with-timeout.sh prints, so a reader still sees "budget,
// not bug". Elapsed runs to the killed leaf's exit, as there.
function timeoutMarker(budget) {
  const elapsed = Math.floor((budget.fired.endedAt - budget.startedAt) / 1000);
  return `⏰ TIMEOUT: with-timeout killed the command after ${budget.seconds}s (exit ${budget.fired.code}, elapsed ${elapsed}s): ${budget.label}`;
}

export async function runPlan({ root, runDir, phases, launcher, keepGoing = false, live = false, onStart, onFinish, onMarker }) {
  const ctx = { root, runDir, launcher, running: new Set(), interrupted: null, onStart, onFinish };
  const onSignal = (signal) => {
    if (ctx.interrupted) return;
    ctx.interrupted = signal;
    for (const child of ctx.running) stopChild(child);
  };
  const handlers = FORWARDED_SIGNALS.map((signal) => [signal, () => onSignal(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  const reports = [];
  let exitCode = 0;
  try {
    for (const phase of phases) {
      if (ctx.interrupted) { reports.push(...phase.map((c) => writeSkipped(c, ctx, `interrupted by ${ctx.interrupted}`))); continue; }
      if (exitCode !== 0 && !keepGoing) { reports.push(...phase.map((c) => writeSkipped(c, ctx, 'an earlier phase failed'))); continue; }
      const results = await Promise.all(phase.map((c) => runStep(c, ctx, live && phase.length === 1)));
      for (const budget of new Set(phase.map((c) => c.budget).filter(Boolean))) {
        // As with-timeout.sh: only when the kill is what ended the leaf.
        if (budget.fired && !budget.reported && [124, 137, 143].includes(budget.fired.code)) {
          budget.reported = true;
          onMarker?.(timeoutMarker(budget));
        }
      }
      const failed = results.filter((r) => r.exit_code !== 0 && !r.advisory).sort((a, b) => a.index - b.index);
      if (failed.length && exitCode === 0) exitCode = failed[0].exit_code || 1;
      reports.push(...results);
    }
  } finally {
    // Only reached with leaves still running if a step threw; stop them.
    for (const child of ctx.running) stopChild(child);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (ctx.interrupted) exitCode = 128 + (os.constants.signals[ctx.interrupted] ?? 1);
  reports.sort((a, b) => a.index - b.index);
  return { exitCode, reports, interrupted: ctx.interrupted };
}

// Keep the newest `keep` hook-mode run directories (run.json mode "hook");
// profiling runs are never removed.
export function pruneHookRuns(parent, keep) {
  if (!Number.isInteger(keep) || keep < 1 || !existsSync(parent)) return [];
  const hookRuns = readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try { return JSON.parse(readFileSync(path.join(parent, name, 'run.json'), 'utf8')).mode === 'hook'; } catch { return false; }
    })
    .sort();
  const removed = hookRuns.slice(0, Math.max(0, hookRuns.length - keep));
  for (const name of removed) rmSync(path.join(parent, name), { recursive: true, force: true });
  return removed;
}
