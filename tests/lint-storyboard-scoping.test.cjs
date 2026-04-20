#!/usr/bin/env node
/**
 * Parity test for the storyboard scoping lint.
 *
 * The lint (`scripts/lint-storyboard-scoping.cjs`) hardcodes
 * TENANT_SCOPED_TASKS and EXEMPT_FROM_LINT. If someone adds a new tool to
 * the training-agent dispatch table without updating those sets, the lint
 * silently skips it. This test closes that gap: it parses the HANDLER_MAP
 * dispatch table from `server/src/training-agent/task-handlers.ts` and
 * asserts every registered task appears in exactly one set.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { TENANT_SCOPED_TASKS, EXEMPT_FROM_LINT } = require('../scripts/lint-storyboard-scoping.cjs');

const TASK_HANDLERS = path.resolve(
  __dirname,
  '..',
  'server',
  'src',
  'training-agent',
  'task-handlers.ts',
);

function parseHandlerMap(source) {
  // Match `const HANDLER_MAP: ...  = {\n  key: handler,\n  ...\n};`
  const match = source.match(/const\s+HANDLER_MAP[^=]*=\s*\{([^}]+)\}/);
  if (!match) {
    throw new Error('HANDLER_MAP not found in task-handlers.ts');
  }
  const tasks = [];
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[a-zA-Z_][a-zA-Z0-9_]*,?\s*$/);
    if (m) tasks.push(m[1]);
  }
  return tasks;
}

test('TENANT_SCOPED_TASKS and EXEMPT_FROM_LINT are disjoint', () => {
  for (const task of TENANT_SCOPED_TASKS) {
    assert.ok(
      !EXEMPT_FROM_LINT.has(task),
      `task "${task}" appears in both TENANT_SCOPED_TASKS and EXEMPT_FROM_LINT`,
    );
  }
});

test('every HANDLER_MAP task is classified in exactly one set', () => {
  const source = fs.readFileSync(TASK_HANDLERS, 'utf8');
  const tasks = parseHandlerMap(source);
  assert.ok(tasks.length > 0, 'HANDLER_MAP parser returned no tasks — parser is broken');

  const unclassified = [];
  for (const task of tasks) {
    const inScoped = TENANT_SCOPED_TASKS.has(task);
    const inExempt = EXEMPT_FROM_LINT.has(task);
    if (!inScoped && !inExempt) unclassified.push(task);
  }

  assert.deepEqual(
    unclassified,
    [],
    `tasks in HANDLER_MAP but missing from scoping classification: ${unclassified.join(', ')}\n` +
      `Add each to TENANT_SCOPED_TASKS (handler calls getSession(sessionKeyFromArgs(...)))` +
      ` or EXEMPT_FROM_LINT (global / payload-array-keyed).`,
  );
});

test('no stale entries — every classified task is actually registered', () => {
  const source = fs.readFileSync(TASK_HANDLERS, 'utf8');
  const registered = new Set(parseHandlerMap(source));

  const stale = [];
  for (const task of TENANT_SCOPED_TASKS) {
    if (!registered.has(task)) stale.push(`TENANT_SCOPED_TASKS: ${task}`);
  }
  for (const task of EXEMPT_FROM_LINT) {
    if (!registered.has(task)) stale.push(`EXEMPT_FROM_LINT: ${task}`);
  }

  assert.deepEqual(
    stale,
    [],
    `classified tasks not in HANDLER_MAP (stale after rename/removal): ${stale.join(', ')}`,
  );
});
