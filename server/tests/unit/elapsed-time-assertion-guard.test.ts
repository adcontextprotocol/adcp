import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/* Structural guard (tp-jyw.39). A server unit test must not assert that work
 * finished within a wall-clock budget: the result then depends on how loaded
 * the machine is, and a shuffled suite on a busy box fails it. Assert the
 * bound the budget stands for instead (calls made, items read, which timer
 * ended an attempt), or drive the timers with a fake clock.
 *
 * Banned: an upper bound on `now() - start`, where `now()` is Date.now() or
 * performance.now() and `start` is a variable read from one of them. The
 * difference may appear directly in expect(), through a variable that holds
 * it, or as the left side of a `<` or `<=` comparison inside expect(). */

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARDED_DIRECTORIES = ['tests/unit', 'src'];
const UPPER_BOUND_MATCHERS = new Set(['toBeLessThan', 'toBeLessThanOrEqual']);

function isClockRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length > 0) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee)
    && callee.name.text === 'now'
    && ts.isIdentifier(callee.expression)
    && (callee.expression.text === 'Date' || callee.expression.text === 'performance');
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

// Every banned form contains a clock read, so a file whose text has no
// `now` next to `Date` or `performance` cannot have one and is not parsed.
function mayReadClock(text: string): boolean {
  return text.includes('now') && (text.includes('Date') || text.includes('performance'));
}

function findElapsedTimeAssertions(fileName: string, text: string): number[] {
  if (!mayReadClock(text)) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const starts = new Set<string>();
  const elapsed = new Set<string>();

  const isElapsed = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) return elapsed.has(expression.text);
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.MinusToken) return false;
    const right = unwrap(expression.right);
    return isClockRead(unwrap(expression.left)) && ts.isIdentifier(right) && starts.has(right.text);
  };

  // Pass 1: variables that hold a clock read, then variables that hold an
  // elapsed time computed from one (in source order, as they are declared).
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isClockRead(unwrap(node.initializer))) starts.add(node.name.text);
      else if (isElapsed(node.initializer)) elapsed.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  // Pass 2: expect(<elapsed>).toBeLessThan(...) and expect(<elapsed> < n).
  const findings: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect'
      && node.arguments.length > 0) {
      const subject = unwrap(node.arguments[0]);
      const matcher = node.parent && ts.isPropertyAccessExpression(node.parent) ? node.parent.name.text : undefined;
      const boundedDirectly = matcher !== undefined && UPPER_BOUND_MATCHERS.has(matcher) && isElapsed(subject);
      const boundedByComparison = ts.isBinaryExpression(subject)
        && (subject.operatorToken.kind === ts.SyntaxKind.LessThanToken
          || subject.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken)
        && isElapsed(subject.left);
      if (boundedDirectly || boundedByComparison) findings.push(line(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function serverTestFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(SERVER_ROOT, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  for (const directory of GUARDED_DIRECTORIES) walk(directory);
  return files.sort();
}

describe('no wall-clock budgets in server unit tests', () => {
  it('asserts no upper bound on an elapsed time in any server unit test', () => {
    const files = serverTestFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(join('tests/unit', 'docs-indexer.test.ts'));
    const violations = files.flatMap((file) => findElapsedTimeAssertions(
      file,
      readFileSync(join(SERVER_ROOT, file), 'utf8'),
    ).map((lineNumber) => `${file}:${lineNumber}`));
    expect(violations).toEqual([]);
  });

  it('detects each banned form (positive meta-test)', () => {
    const banned = [
      // The forms tp-jyw.39 removed.
      'const started = Date.now(); await search(); expect(Date.now() - started).toBeLessThan(5_000);',
      'const start = performance.now(); await run(); expect(performance.now() - start).toBeLessThan(2000);',
      'const start = Date.now(); parse(); const elapsed = Date.now() - start; expect(elapsed).toBeLessThan(100);',
      // Other spellings of the same budget.
      'let t0 = performance.now(); work(); expect((performance.now() - t0)).toBeLessThanOrEqual(1500);',
      'const t0 = Date.now(); work(); expect(Date.now() - t0 < 1000).toBe(true);',
      'const t0 = Date.now(); work(); const took = (Date.now() - t0) as number; expect(took <= 50, "fast").toBeTruthy();',
      'const t0 = Date.now(); work(); expect(Date.now() - t0, "within budget").toBeLessThan(1000);',
    ];
    for (const text of banned) {
      expect(findElapsedTimeAssertions('sample.ts', text), text).toHaveLength(1);
    }
  });

  it('ignores lookalikes that are not wall-clock budgets (negative meta-test)', () => {
    const allowed = [
      // A time a fixed offset in the past, not an elapsed time.
      'expect(new Date(Date.now() - 86_400_000).getTime()).toBeLessThan(Date.now());',
      'const COOLDOWN = 1000; expect(Date.now() - COOLDOWN).toBeLessThan(limit);',
      // A lower bound: the code waited at least this long.
      'const start = Date.now(); await sleep(10); expect(Date.now() - start).toBeGreaterThanOrEqual(10);',
      // A count bound, and an elapsed time that is only logged.
      'const start = Date.now(); const calls = run(); expect(calls).toBeLessThan(5); log(Date.now() - start);',
      // Text that only looks like the banned form.
      "const text = 'expect(Date.now() - start).toBeLessThan(5)';",
      // A difference of two recorded stamps from a fake clock.
      'const before = clock.now(); tick(); expect(clock.now() - before).toBeLessThan(10);',
    ];
    for (const text of allowed) {
      expect(findElapsedTimeAssertions('sample.ts', text), text).toEqual([]);
    }
  });
});
