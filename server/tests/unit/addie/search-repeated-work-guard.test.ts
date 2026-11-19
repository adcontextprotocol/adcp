import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/* Structural guard (tp-jyw.42). Addie's search and evaluation code loops over
 * whole indexes and corpora, so work repeated per element multiplies. Two
 * forms are banned there:
 *   - a linear scan of an index (an identifier or property named `...Index`)
 *     inside a callback or loop body that iterates another collection, the
 *     O(H x D) parent lookup searchHeadings used to do: build a map once (see
 *     docsByIdFor in mcp/docs-indexer.ts);
 *   - building a merged set only to read its size, as a pairwise similarity
 *     loop did per pair: |a ∪ b| = |a| + |b| - |a ∩ b| (see similarPairCount
 *     in eval/fixed-trace-suite.ts). */

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARDED_DIRECTORIES = ['src/addie'];
const LINEAR_LOOKUPS = new Set(['find', 'findIndex', 'findLast', 'findLastIndex', 'filter', 'some', 'every', 'includes', 'indexOf']);
const ITERATING_METHODS = new Set([
  'map', 'flatMap', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'reduce', 'reduceRight', 'sort', 'toSorted',
]);

interface Finding {
  kind: 'index_scan_in_loop' | 'merged_set_size';
  line: number;
}

function receiverName(expression: ts.Expression): string | undefined {
  let receiver = expression;
  while (ts.isParenthesizedExpression(receiver) || ts.isNonNullExpression(receiver)) receiver = receiver.expression;
  if (ts.isIdentifier(receiver)) return receiver.text;
  if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text;
  return undefined;
}

function isIterationContext(node: ts.Node): boolean {
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node)) return true;
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return false;
  const call = node.parent;
  return ts.isCallExpression(call)
    && call.arguments.includes(node as ts.Expression)
    && ts.isPropertyAccessExpression(call.expression)
    && ITERATING_METHODS.has(call.expression.name.text);
}

function insideIteration(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (isIterationContext(current)) return true;
    // A named function or method is its own unit of work; its callers decide
    // how often it runs.
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return false;
  }
  return false;
}

// Each banned form names an `...Index` receiver or a `Set` read for its
// `.size`, so a file whose text has neither cannot have one and is not parsed.
function mayRepeatSearchWork(text: string): boolean {
  return text.includes('Index') || (text.includes('Set') && text.includes('.size'));
}

function findRepeatedSearchWork(fileName: string, text: string): Finding[] {
  if (!mayRepeatSearchWork(text)) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && LINEAR_LOOKUPS.has(node.expression.name.text)) {
      const receiver = receiverName(node.expression.expression);
      if (receiver && /Index$/.test(receiver) && insideIteration(node)) {
        findings.push({ kind: 'index_scan_in_loop', line: line(node) });
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'size') {
      let target = node.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isNewExpression(target) && receiverName(target.expression) === 'Set') {
        const [argument] = target.arguments ?? [];
        if (argument && ts.isArrayLiteralExpression(argument)
          && argument.elements.filter(ts.isSpreadElement).length >= 2) {
          findings.push({ kind: 'merged_set_size', line: line(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function guardedSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(SERVER_ROOT, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  for (const directory of GUARDED_DIRECTORIES) walk(directory);
  return files.sort();
}

describe('no per-element repeated work in Addie search and evaluation loops', () => {
  it('scans no index inside a loop and builds no merged set for its size', () => {
    const files = guardedSourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join('src/addie/mcp', 'docs-indexer.ts'));
    const violations = files.flatMap((file) => findRepeatedSearchWork(
      file,
      readFileSync(join(SERVER_ROOT, file), 'utf8'),
    ).map((finding) => `${file}:${finding.line} ${finding.kind}`));
    expect(violations).toEqual([]);
  });

  it('detects each banned form (positive meta-test)', () => {
    const banned = [
      // The searchHeadings parent lookup before tp-jyw.42.
      `const scored = headingsIndex.filter((heading) => {
         const parentDoc = docsIndex.find((doc) => doc.id === heading.doc_id);
         return parentDoc?.version === selected;
       });`,
      'for (const heading of headings) { const doc = docsIndex.find((d) => d.id === heading.doc_id); }',
      'items.map(function (item) { return this.docsIndex.findIndex((d) => d.id === item.id); });',
      'rows.forEach((row) => { if (state.headingsIndex.some((h) => h.id === row.id)) count++; });',
      'while (queue.length) { const next = queue.pop(); docsIndex!.filter((d) => d.id === next); }',
      // The fixedTraceCoverageInventory pair loop before tp-jyw.42.
      'const union = new Set([...values[index], ...values[other]]).size;',
      'const union = (new Set([...left, ...right])).size;',
    ];
    for (const text of banned) {
      expect(findRepeatedSearchWork('sample.ts', text), text).toHaveLength(1);
    }
  });

  it('ignores lookalikes that are not the banned forms (negative meta-test)', () => {
    const allowed = [
      // One linear lookup per call, as getDocById and getHeadingById do.
      'export function getDocById(id: string) { return docsIndex.find((doc) => doc.id === id) || null; }',
      // A named helper is judged at its own call sites, not where it is declared.
      'items.map((item) => { function byId(id: string) { return docsIndex.find((d) => d.id === id); } return item; });',
      // A lookup in something that is not an index.
      'headings.filter((heading) => parentDocs.get(heading.doc_id));',
      'headings.filter((heading) => candidates.find((id) => id === heading.id));',
      "const text = 'headingsIndex.filter((h) => docsIndex.find((d) => d.id === h.doc_id))';",
      // A set of one collection, and a merged set that is used, not just sized.
      'const distinct = new Set([...values]).size;',
      'const merged = new Set([...left, ...right]); for (const token of merged) use(token);',
      'const union = left.size + right.size - overlap;',
    ];
    for (const text of allowed) {
      expect(findRepeatedSearchWork('sample.ts', text), text).toEqual([]);
    }
  });
});
