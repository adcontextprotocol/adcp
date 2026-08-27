#!/usr/bin/env tsx
/**
 * Build the Addie tool-reference page.
 *
 * Walks `server/src/addie/mcp/*-tools.ts` (plus the actively registered
 * `knowledge-search.ts`) for AddieTool definitions, cross-references them against
 * the curated TOOL_SETS in `server/src/addie/tool-sets.ts`, and writes the
 * combined reference to `docs/aao/addie-tools.mdx`.
 *
 * Goal: every Addie tool has a public, search_docs-indexable entry so Addie
 * can answer "what can you do?" / "can you do X?" without fabricating, and so
 * humans landing on the docs site can see the surface area at a glance.
 *
 * Usage:
 *   npx tsx scripts/build-addie-tool-reference.ts            # write the file
 *   npx tsx scripts/build-addie-tool-reference.ts --check    # exit 1 if stale
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { fileURLToPath } from 'node:url';

type ExtractedTool = {
  name: string;
  description: string;
  sourceFile: string;
};

type ExtractedToolSet = {
  name: string;
  description: string;
  tools: string[];
  adminOnly: boolean;
  routerVisible: boolean;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_DIR = path.join(REPO_ROOT, 'server/src/addie/mcp');
const TOOL_SETS_FILE = path.join(REPO_ROOT, 'server/src/addie/tool-sets.ts');
const OUTPUT_FILE = path.join(REPO_ROOT, 'docs/aao/addie-tools.mdx');
const CATALOG_OUTPUT_FILE = path.join(REPO_ROOT, 'server/src/addie/generated/tool-catalog.generated.ts');

function parseFile(filePath: string): ts.SourceFile {
  const source = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'join'
    && ts.isArrayLiteralExpression(node.expression.expression)
  ) {
    const separator = node.arguments.length === 0 ? ',' : literalText(node.arguments[0]);
    const parts = node.expression.expression.elements.map(literalText);
    return separator !== null && parts.every((part): part is string => part !== null)
      ? parts.join(separator)
      : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += '${...}';
      out += span.literal.text;
    }
    return out;
  }
  return null;
}

function extractToolsFromFile(filePath: string): ExtractedTool[] {
  const sf = parseFile(filePath);
  const fileBase = path.basename(filePath);
  const tools: ExtractedTool[] = [];

  function extractObject(node: ts.ObjectLiteralExpression): void {
    let name: string | null = null;
    let description: string | null = null;
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteralLike(prop.name) ? prop.name.text
        : null;
      if (key === 'name') name = literalText(prop.initializer);
      else if (key === 'description') description = literalText(prop.initializer);
    }
    if (name && description) tools.push({ name, description, sourceFile: fileBase });
  }

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer) &&
      ts.isIdentifier(node.name) &&
      /_TOOLS$/.test(node.name.text)
    ) {
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        extractObject(el);
      }
    } else if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
      && node.type?.getText(sf).replace(/\s/g, '') === 'AddieTool'
    ) {
      // Some modules compose their exported *_TOOLS array from named,
      // individually typed definitions. Capture those definitions too.
      extractObject(node.initializer);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return tools;
}

function extractToolSets(filePath: string): ExtractedToolSet[] {
  const sf = parseFile(filePath);
  const sets: ExtractedToolSet[] = [];
  const objectArrayConstants = new Map<string, Map<string, string[]>>();

  function unwrap(node: ts.Node): ts.Node {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      return unwrap(node.expression);
    }
    return node;
  }

  function readArrayOfStrings(node: ts.Node): string[] {
    const unwrapped = unwrap(node);
    if (!ts.isArrayLiteralExpression(unwrapped)) return [];
    const out: string[] = [];
    for (const el of unwrapped.elements) {
      const t = literalText(el);
      if (t) out.push(t);
      if (
        ts.isSpreadElement(el)
        && ts.isPropertyAccessExpression(el.expression)
        && ts.isIdentifier(el.expression.expression)
      ) {
        const values = objectArrayConstants
          .get(el.expression.expression.text)
          ?.get(el.expression.name.text);
        if (values) out.push(...values);
      }
    }
    return out;
  }

  // Resolve the bounded domain arrays referenced by TOOL_SETS without
  // executing application code during generation.
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      const entries = new Map<string, string[]>();
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) ? property.name.text
          : ts.isStringLiteralLike(property.name) ? property.name.text
          : null;
        if (!key) continue;
        const values = readArrayOfStrings(property.initializer);
        if (values.length > 0) entries.set(key, values);
      }
      if (entries.size > 0) objectArrayConstants.set(declaration.name.text, entries);
    }
  }

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'TOOL_SETS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (!ts.isObjectLiteralExpression(prop.initializer)) continue;
        let setName: string | null = null;
        let description: string | null = null;
        let toolList: string[] = [];
        let adminOnly = false;
        let routerVisible = true;
        for (const inner of prop.initializer.properties) {
          if (!ts.isPropertyAssignment(inner)) continue;
          const key = ts.isIdentifier(inner.name) ? inner.name.text
            : ts.isStringLiteralLike(inner.name) ? inner.name.text
            : null;
          if (key === 'name') setName = literalText(inner.initializer);
          else if (key === 'description') description = literalText(inner.initializer);
          else if (key === 'tools') toolList = readArrayOfStrings(inner.initializer);
          else if (key === 'adminOnly' && inner.initializer.kind === ts.SyntaxKind.TrueKeyword) adminOnly = true;
          else if (key === 'routerVisible' && inner.initializer.kind === ts.SyntaxKind.FalseKeyword) routerVisible = false;
        }
        if (setName && description) {
          sets.push({ name: setName, description, tools: toolList, adminOnly, routerVisible });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return sets;
}

function extractAlwaysAvailable(filePath: string, exportName: string): string[] {
  const sf = parseFile(filePath);
  let result: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exportName &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        const t = literalText(el);
        if (t) result.push(t);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

function indentDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return '';
  // Escape MDX-hostile characters in tool descriptions. The descriptions are
  // LLM-facing prose that occasionally quotes literal HTML or uses '<' as a
  // less-than operator; both crash MDX 3 parsers. Replace ALL `<` with `&lt;`
  // — tool descriptions don't legitimately use HTML/JSX tags, and any quoted
  // machine-protocol fragments render the same way after escaping.
  // Template expressions are represented as the literal placeholder
  // `${...}` by literalText(). Encode its delimiters so MDX does not try to
  // parse the placeholder as a JavaScript expression.
  const escaped = trimmed
    .replace(/</g, '&lt;')
    .replaceAll('${...}', '&#36;&#123;...&#125;');
  return escaped.split('\n').map(line => line.trimEnd()).join('\n');
}

function render(
  tools: ExtractedTool[],
  toolSets: ExtractedToolSet[],
  alwaysAvailable: string[],
  alwaysAvailableAdmin: string[],
): string {
  const byName = new Map<string, ExtractedTool>();
  for (const t of tools) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }

  const grouped = new Set<string>();
  const sections: string[] = [];

  // Capability sets first — they're the curated, human-readable spine.
  for (const set of toolSets) {
    const visibleTools = set.tools.filter(name => byName.has(name));
    if (visibleTools.length === 0) continue;
    const adminBadge = set.adminOnly ? ' (admin only)' : '';
    sections.push(`## ${set.name}${adminBadge}\n\n${set.description.trim()}\n`);
    for (const toolName of visibleTools) {
      const tool = byName.get(toolName);
      if (!tool) continue;
      grouped.add(toolName);
      sections.push(`### \`${tool.name}\`\n\n${indentDescription(tool.description)}\n\n*Source: \`server/src/addie/mcp/${tool.sourceFile}\`*\n`);
    }
  }

  // Always-available tools
  if (alwaysAvailable.length > 0) {
    sections.push(`## Always available\n\nThese tools are reachable in every conversation regardless of router intent. Both authenticated and anonymous users can use them when their handlers permit.\n`);
    for (const toolName of alwaysAvailable) {
      const tool = byName.get(toolName);
      if (!tool) continue;
      grouped.add(toolName);
      sections.push(`### \`${tool.name}\`\n\n${indentDescription(tool.description)}\n\n*Source: \`server/src/addie/mcp/${tool.sourceFile}\`*\n`);
    }
  }

  // Always-available admin tools
  if (alwaysAvailableAdmin.length > 0) {
    sections.push(`## Always available (admin)\n\nAdmin-only tools reachable in every conversation regardless of router intent.\n`);
    for (const toolName of alwaysAvailableAdmin) {
      const tool = byName.get(toolName);
      if (!tool) continue;
      grouped.add(toolName);
      sections.push(`### \`${tool.name}\`\n\n${indentDescription(tool.description)}\n\n*Source: \`server/src/addie/mcp/${tool.sourceFile}\`*\n`);
    }
  }

  // Anything left over — tools defined but not referenced by any tool set
  // or always-available list. Surface them so Addie still has docs for them.
  const ungrouped = tools.filter(t => !grouped.has(t.name));
  if (ungrouped.length > 0) {
    sections.push(`## Other tools\n\nTools defined in the code but not referenced by any tool set above. These typically require specific channel/auth conditions to register; see the source for details.\n`);
    for (const tool of ungrouped) {
      sections.push(`### \`${tool.name}\`\n\n${indentDescription(tool.description)}\n\n*Source: \`server/src/addie/mcp/${tool.sourceFile}\`*\n`);
    }
  }

  const generatedAt = '{/* This file is auto-generated by scripts/build-addie-tool-reference.ts. Do not edit by hand. Run `npm run build:addie-tools` to regenerate. */}';
  const frontmatter = `---
title: Addie Tool Reference
description: Every tool Addie has access to, grouped by capability set.
"og:title": "AdCP — Addie Tool Reference"
---

${generatedAt}

# Addie Tool Reference

This page lists every tool Addie can call. Each tool's description is the same one that ships into Addie's prompt, so the language is router-facing rather than tutorial-style — but it tells you exactly what Addie *can* do, *when* she should reach for the tool, and *what* fields it accepts.

Tools are grouped by **capability set** (router category). The router selects one or more sets based on the user's intent, then Addie picks specific tools within those sets. A handful of tools are *always available* regardless of routing — bug-report flow, content submission, escalation — see the **Always available** section.

If you're an integrator or admin and you want to know whether Addie can do X: search this page first. If you can't find a tool here, Addie can't do X — please don't ask her to invent one.

`;

  return frontmatter + sections.join('\n') + '\n';
}

/**
 * Render the compact catalog that gets injected into Addie's system prompt.
 *
 * This is the *authoritative* tool list Addie sees at runtime. It's generated
 * from the same registrations as the public docs page, so the two never drift.
 * Addie should treat anything not on this list as nonexistent — and the
 * matching behavior rule in `rules/behaviors.md` enforces that.
 */
function renderCatalog(
  tools: ExtractedTool[],
  toolSets: ExtractedToolSet[],
  alwaysAvailable: string[],
  alwaysAvailableAdmin: string[],
): string {
  const byName = new Map<string, ExtractedTool>();
  for (const t of tools) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }

  const lines: string[] = [
    '## Authoritative tool catalog (auto-generated)',
    '',
    'This catalog is the source of truth for what tools exist. If a tool is not listed here, it is not registered — do not invent one, do not promise capability you cannot verify, and do not claim a tool "is not loaded in this conversation."',
    '',
    'Full descriptions live in `docs/aao/addie-tools.mdx` — use `search_docs` with "addie tools" or `get_doc` on that page when you need usage detail.',
    '',
    '### Capability sets',
    '',
    'Treat every tool listed here as available. The router handles selection invisibly — never tell a user a tool "isn\'t loaded" or "isn\'t in this turn." If a tool name is in this catalog, you can act on it.',
    '',
  ];

  for (const set of toolSets) {
    const visibleTools = set.tools.filter(name => byName.has(name));
    if (visibleTools.length === 0) continue;
    const adminBadge = set.adminOnly ? ' *(admin only)*' : '';
    lines.push(`- **${set.name}**${adminBadge} — ${visibleTools.join(', ')}`);
  }

  if (alwaysAvailable.length > 0) {
    const visible = alwaysAvailable.filter(name => byName.has(name));
    if (visible.length > 0) {
      lines.push('', '### Always available', '', `${visible.join(', ')}`);
    }
  }

  if (alwaysAvailableAdmin.length > 0) {
    const visible = alwaysAvailableAdmin.filter(name => byName.has(name));
    if (visible.length > 0) {
      lines.push('', '### Always available (admin)', '', `${visible.join(', ')}`);
    }
  }

  // Tools registered but not in any TOOL_SETS group or always-available list.
  // These typically register conditionally (channel-gated, env-gated) and
  // would otherwise be invisible to the catalog. We surface them so Addie's
  // catalog stays a complete inventory, matching the docs page's "Other"
  // section. See render() for the parallel logic.
  const grouped = new Set<string>();
  for (const set of toolSets) {
    for (const t of set.tools) grouped.add(t);
  }
  for (const t of alwaysAvailable) grouped.add(t);
  for (const t of alwaysAvailableAdmin) grouped.add(t);
  const ungrouped = tools.filter(t => !grouped.has(t.name)).map(t => t.name);
  if (ungrouped.length > 0) {
    lines.push('', '### Other tools', '', 'Conditionally registered (channel- or env-gated). Available when their preconditions are met.', '', ungrouped.join(', '));
  }

  return lines.join('\n') + '\n';
}

function renderCatalogModule(catalogBody: string, toolNames: string[]): string {
  const escaped = catalogBody.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `// AUTO-GENERATED by scripts/build-addie-tool-reference.ts
// Do not edit by hand. Run \`npm run build:addie-tools\` to regenerate.
// Source: server/src/addie/mcp/*-tools.ts + server/src/addie/tool-sets.ts

/**
 * Compact authoritative catalog of Addie's tools, appended to her system
 * prompt. Generated from the same registrations as docs/aao/addie-tools.mdx
 * so the two cannot drift.
 */
export const ADDIE_TOOL_CATALOG = \`${escaped}\`;

/** Explicit catalog names for runtime/inventory parity checks. */
export const ADDIE_TOOL_NAMES = ${JSON.stringify(toolNames, null, 2)} as const;
`;
}

function main() {
  const checkMode = process.argv.includes('--check');

  // Discover all *-tools.ts files plus the active non-suffix search module.
  // docs-search.ts is a legacy, unregistered implementation whose duplicate
  // search_docs/get_doc names must not override the runtime definitions.
  const toolFiles = fs.readdirSync(MCP_DIR)
    .filter(f => (f.endsWith('-tools.ts') && f !== 'story-tools.ts')
      || f === 'knowledge-search.ts'
      || f === 'admin-analytics.ts'
      || f === 'google-docs.ts')
    .map(f => path.join(MCP_DIR, f))
    .sort();

  const allTools: ExtractedTool[] = [];
  for (const file of toolFiles) {
    allTools.push(...extractToolsFromFile(file));
  }

  const toolSets = extractToolSets(TOOL_SETS_FILE).filter((set) => set.routerVisible);
  const alwaysAvailable = extractAlwaysAvailable(TOOL_SETS_FILE, 'ALWAYS_AVAILABLE_TOOLS');
  const alwaysAvailableAdmin = extractAlwaysAvailable(TOOL_SETS_FILE, 'ALWAYS_AVAILABLE_ADMIN_TOOLS');

  const rendered = render(allTools, toolSets, alwaysAvailable, alwaysAvailableAdmin);
  const catalogBody = renderCatalog(allTools, toolSets, alwaysAvailable, alwaysAvailableAdmin);
  const catalogModule = renderCatalogModule(
    catalogBody,
    [...new Set(allTools.map((tool) => tool.name))],
  );

  if (checkMode) {
    const existing = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
    const existingCatalog = fs.existsSync(CATALOG_OUTPUT_FILE) ? fs.readFileSync(CATALOG_OUTPUT_FILE, 'utf8') : '';
    const stale: string[] = [];
    if (existing !== rendered) stale.push(OUTPUT_FILE);
    if (existingCatalog !== catalogModule) stale.push(CATALOG_OUTPUT_FILE);
    if (stale.length > 0) {
      console.error(`Stale: ${stale.join(', ')}`);
      console.error(`Run: npx tsx scripts/build-addie-tool-reference.ts`);
      process.exit(1);
    }
    console.log(`✓ Addie tool reference up to date (${allTools.length} tools, ${toolSets.length} sets).`);
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, rendered);
  fs.mkdirSync(path.dirname(CATALOG_OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_OUTPUT_FILE, catalogModule);
  console.log(`✓ Wrote ${OUTPUT_FILE}`);
  console.log(`✓ Wrote ${CATALOG_OUTPUT_FILE}`);
  console.log(`  Tools: ${allTools.length}`);
  console.log(`  Sets:  ${toolSets.length}`);
  console.log(`  Always available: ${alwaysAvailable.length} (+ ${alwaysAvailableAdmin.length} admin)`);
}

main();
