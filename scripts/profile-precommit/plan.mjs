// The pre-commit plan: the leaf commands the hook runs, derived from
// package.json so that `npm run precommit` stays the single definition.
//
// Roots are fixed: the advisory image check, then `npm run precommit`. Every
// `npm run X` is expanded through package.json into its leaf commands (split
// on &&); `bash scripts/with-timeout.sh N cmd` opens a budget group whose
// deadline covers every leaf beneath it (ADCP_TIMEOUT_SCALE honoured).
//
// phasesOf() groups the leaves for concurrent runs. Leaves of a known
// read-only kind (vitest, node:test, tsc and its wrapper, plus an allowlist)
// share one phase; the server unit step runs in its own phase after them
// because it already uses every core (overlapping it with root vitest made
// load-sensitive root tests time out); any other leaf is a barrier that runs
// alone, in plan order. A new leaf that builds or writes something is
// therefore serialized automatically until it is added to the allowlist.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// .husky/pre-commit ran these two lines; the image check's exit status was
// discarded there (no `set -e`), so it stays advisory.
export const PLAN_ROOTS = [
  { line: 'bash scripts/check-image-quality.sh', name: 'check-image-quality', advisory: true },
  { line: 'npm run precommit' },
];

const LIGHT_KINDS = new Set(['vitest', 'node-test', 'tsc', 'tsc-wrapper']);
// Leaves of kind "other" that only read the tree.
const READ_ONLY_COMMANDS = [
  /^bash scripts\/check-image-quality\.sh$/,
  /^node scripts\/generate-governance-jws-vectors\.mjs --check$/,
];

export function scaleBudget(seconds, env = process.env) {
  const scale = Number(env.ADCP_TIMEOUT_SCALE);
  return Number.isFinite(scale) && scale >= 1 ? Math.ceil(seconds * scale) : seconds;
}

export function classify(command) {
  if (/precommit-server-unit\.cjs/.test(command)) return 'server-unit';
  if (/(^|\s)vitest run\b/.test(command)) return 'vitest';
  if (/\bnode\b.*\s--test(\s|$)/.test(command)) return 'node-test';
  if (/^tsc\b/.test(command)) return 'tsc';
  if (/typecheck/.test(command)) return 'tsc-wrapper';
  return 'other';
}

function expand(command, scripts, ctx, out, env) {
  const clauses = command.split(/\s+&&\s+/).map((c) => c.trim()).filter(Boolean);
  clauses.forEach((clause, index) => {
    if (/(\|\||;|\|)/.test(clause.replace(/'[^']*'|"[^"]*"/g, ''))) {
      throw new Error(`Cannot expand clause with shell operators: ${clause}`);
    }
    let budget = ctx.budget;
    let inner = clause;
    const timeout = /^bash scripts\/with-timeout\.sh (\d+) (.+)$/.exec(clause);
    if (timeout) {
      budget = { id: out.budgets.length, seconds: scaleBudget(Number(timeout[1]), env), label: timeout[2], startedAt: null };
      out.budgets.push(budget);
      inner = timeout[2];
    }
    const npmRun = /^npm run (?:--silent )?([\w:.-]+)$/.exec(inner);
    if (npmRun) {
      const name = npmRun[1];
      if (!(name in scripts)) throw new Error(`package.json has no script ${name}`);
      expand(scripts[name], scripts, { budget, chain: [...ctx.chain, name] }, out, env);
      return;
    }
    const owner = ctx.chain.at(-1) ?? 'hook';
    const name = clauses.length > 1 ? `${owner}#${index + 1}` : owner;
    out.commands.push({ name, chain: ctx.chain, command: inner, budget });
  });
}

export function planCommands({ root, env = process.env } = {}) {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  const out = { commands: [], budgets: [] };
  for (const { line, name, advisory } of PLAN_ROOTS) {
    const before = out.commands.length;
    expand(line, scripts, { budget: null, chain: [] }, out, env);
    for (const c of out.commands.slice(before)) {
      if (name) c.name = name;
      c.advisory = !!advisory;
    }
  }
  out.commands.forEach((c, i) => {
    c.index = i + 1;
    c.slug = `${String(i + 1).padStart(2, '0')}-${c.name.replace(/[^\w.-]+/g, '-')}`;
    c.kind = classify(c.command);
    c.lane = c.kind === 'server-unit' ? 'server'
      : LIGHT_KINDS.has(c.kind) || READ_ONLY_COMMANDS.some((re) => re.test(c.command)) ? 'light' : 'barrier';
  });
  return out;
}

// Phases in run order, each a list of commands that run at the same time.
export function phasesOf(commands) {
  const phases = [];
  let light = [];
  let server = [];
  const flush = () => {
    if (light.length) phases.push(light);
    if (server.length) phases.push(server);
    light = [];
    server = [];
  };
  for (const c of commands) {
    if (c.lane === 'barrier') { flush(); phases.push([c]); continue; }
    (c.lane === 'server' ? server : light).push(c);
  }
  flush();
  return phases;
}
