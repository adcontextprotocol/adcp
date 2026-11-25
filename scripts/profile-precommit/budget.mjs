// One wall-clock budget per git hook (tp-jyw.50). The hook runner
// (runner.mjs) owns a single deadline for the whole hook; when it passes, the
// runner stops every step and everything the steps started, names the steps
// that were still running and exits 124.
//
// The budget, first match wins:
//   --budget-s N                 argument of `profile-precommit.mjs hook`
//   ADCP_PRECOMMIT_BUDGET_S=N    pre-commit only
//   ADCP_PREPUSH_BUDGET_S=N      pre-push only
//   ADCP_HOOK_BUDGET_S=N         any hook
//   the default below
// N is a positive number of seconds (decimals allowed); anything else is a
// usage error. Git passes no arguments of ours to a hook, so the variables are
// how a slower machine, a sandbox or CI raises the budget.

import { execFileSync } from 'node:child_process';

// Together 300 s, the target for commit + push. Measured on an M4 Pro
// (14 cores): pre-commit with the full server suite 64-74 s, and up to 99 s
// with other work on the machine (143 s for a cold first run); pre-push with
// every conditional step 134-142 s.
export const DEFAULT_BUDGET_S = { 'pre-commit': 120, 'pre-push': 180 };
export const HOOK_BUDGET_ENV = { 'pre-commit': 'ADCP_PRECOMMIT_BUDGET_S', 'pre-push': 'ADCP_PREPUSH_BUDGET_S' };
export const ANY_HOOK_BUDGET_ENV = 'ADCP_HOOK_BUDGET_S';

export class BudgetUsageError extends Error {}

function seconds(raw, source) {
  const text = String(raw ?? '').trim();
  const value = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!(value > 0)) throw new BudgetUsageError(`${source} must be a positive number of seconds, got '${raw ?? ''}'`);
  return value;
}

/**
 * The budget for `hook`: {hook, seconds, source}. `arg` is the --budget-s
 * value; pass `hasArg` when the flag was given, so a missing value is an
 * error rather than "no argument".
 */
export function resolveBudget({ hook, arg, hasArg = arg !== undefined, env = process.env }) {
  if (!(hook in DEFAULT_BUDGET_S)) {
    throw new BudgetUsageError(`--name must be one of ${Object.keys(DEFAULT_BUDGET_S).join(', ')}, got '${hook}'`);
  }
  if (hasArg) return { hook, seconds: seconds(arg, '--budget-s'), source: '--budget-s' };
  for (const name of [HOOK_BUDGET_ENV[hook], ANY_HOOK_BUDGET_ENV]) {
    if (env[name] !== undefined) return { hook, seconds: seconds(env[name], name), source: name };
  }
  return { hook, seconds: DEFAULT_BUDGET_S[hook], source: 'default' };
}

/** How to change the budget of `hook`, for messages. */
export function budgetOverrideHint(hook) {
  return `set ${HOOK_BUDGET_ENV[hook]} or ${ANY_HOOK_BUDGET_ENV} to a number of seconds, or pass --budget-s to the runner`;
}

// ps elapsed time, [[dd-]hh:]mm:ss, in seconds.
function etimeSeconds(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** Every process: {pid, ppid, pgid, ran_s, command}. Empty if ps fails. */
export function processTable() {
  let text = '';
  try {
    text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,etime=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  return text.split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], ran_s: etimeSeconds(m[4]), command: m[5].trim() } : null;
  }).filter(Boolean);
}

/** The descendants of rootPid in table (children first), found by parent pid. */
export function descendantsOf(table, rootPid) {
  const children = new Map();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}
