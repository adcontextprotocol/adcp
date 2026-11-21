import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/* Structural guard (tp-jyw.6). Evaluation and provider code rebuilds the same
 * tool catalog for every trace, arm and dispatch. Two forms of repeating that
 * work on unchanged input are banned there:
 *   - constructing an Ajv instance to compile tool schemas: compile through
 *     model-providers/tool-schema-validator.ts, which caches by schema;
 *   - deep-cloning a tool's input schema per call: share a frozen projection
 *     (see toOpenAITool/frozenOpenAITool in openai-responses-provider.ts). */

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARDED_DIRECTORIES = ['src/addie/eval', 'src/addie/model-providers'];
const AJV_CONSTRUCTORS = new Set(['Ajv', 'Ajv2019', 'Ajv2020', 'AjvJTD']);
const SCHEMA_PROPERTIES = new Set(['inputSchema', 'input_schema']);

/** Files allowed to construct Ajv, each with its reason. */
const AJV_ALLOWLIST: Readonly<Record<string, string>> = {
  'src/addie/model-providers/tool-schema-validator.ts': 'the shared validator cache itself',
  'src/addie/model-providers/read-only-tool-loop.ts': 'deferred to tp-jyw.12',
};

interface Finding {
  kind: 'ajv_construction' | 'tool_schema_clone';
  line: number;
}

function findRepeatedToolSchemaWork(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const calleeName = (expression: ts.Expression): string | undefined => {
    let callee = expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name && AJV_CONSTRUCTORS.has(name)) findings.push({ kind: 'ajv_construction', line: line(node) });
    }
    if (ts.isCallExpression(node) && calleeName(node.expression) === 'structuredClone') {
      let argument = node.arguments[0];
      while (argument && (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument)
        || ts.isNonNullExpression(argument))) argument = argument.expression;
      const property = argument && (ts.isPropertyAccessExpression(argument)
        ? argument.name.text
        : ts.isElementAccessExpression(argument) && ts.isStringLiteralLike(argument.argumentExpression)
          ? argument.argumentExpression.text
          : undefined);
      if (property && SCHEMA_PROPERTIES.has(property)) findings.push({ kind: 'tool_schema_clone', line: line(node) });
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

describe('no repeated tool-schema work in Addie evaluation and provider code', () => {
  it('constructs Ajv only in allowlisted files and never deep-clones a tool input schema', () => {
    const files = guardedSourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap((file) => findRepeatedToolSchemaWork(
      file,
      readFileSync(join(SERVER_ROOT, file), 'utf8'),
    )
      .filter((finding) => finding.kind !== 'ajv_construction' || !(file in AJV_ALLOWLIST))
      .map((finding) => `${file}:${finding.line} ${finding.kind}`));
    expect(violations).toEqual([]);
  });

  it('keeps every allowlist entry live, so a fixed file leaves the list', () => {
    for (const file of Object.keys(AJV_ALLOWLIST)) {
      const findings = findRepeatedToolSchemaWork(file, readFileSync(join(SERVER_ROOT, file), 'utf8'));
      expect(findings.some((finding) => finding.kind === 'ajv_construction'), file).toBe(true);
    }
  });

  it('detects each banned form (positive meta-test)', () => {
    const banned = [
      "const ajv = new Ajv({ strict: false });",
      "const ajv = new (Ajv)();",
      "const ajv = new ajvModule.Ajv2020();",
      "const copy = structuredClone(tool.inputSchema);",
      "const copy = structuredClone(definition.input_schema as JsonObject);",
      "const copy = structuredClone((tool!.inputSchema));",
      "const copy = structuredClone(definition['input_schema']);",
    ];
    for (const text of banned) {
      expect(findRepeatedToolSchemaWork('sample.ts', text), text).toHaveLength(1);
    }
  });

  it('ignores lookalikes that are not the banned forms (negative meta-test)', () => {
    const allowed = [
      "// new Ajv() in a comment",
      "const text = 'structuredClone(tool.inputSchema)';",
      "const validate = compileToolInputSchema(schema, 'tool_loop');",
      "const copy = structuredClone(tool);",
      "const copy = structuredClone(request.inputSchemaVersion);",
      "const ajv = newToolSchemaAjv('tool_loop');",
      "const instance = new AjvCache();",
    ];
    for (const text of allowed) {
      expect(findRepeatedToolSchemaWork('sample.ts', text), text).toEqual([]);
    }
  });
});
