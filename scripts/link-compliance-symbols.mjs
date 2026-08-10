#!/usr/bin/env node

/**
 * Link machine-readable AdCP symbols in a bounded set of reference docs.
 *
 * The Markdown AST chooses eligible inline-code nodes; edits are applied to
 * the original source offsets so this tool never reformats an author's MDX.
 * Known symbols are linked once per H2 section. Unknown error/task claims only
 * fail in structural contexts (or explicit adcp: pseudo-links), avoiding the
 * false positives inherent in treating every snake-case token as a symbol.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import yaml from 'js-yaml';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visitParents } from 'unist-util-visit-parents';
import buildSchemas from './build-schemas.cjs';

const { discoverTools } = buildSchemas;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_SOURCE = 'static/schemas/source';
const COMPLIANCE_SOURCE = 'static/compliance/source';
const IGNORE_FILE = 'scripts/compliance-symbol-ignore.json';
const STANDARD_ERROR_SCHEMA = `${SCHEMA_SOURCE}/enums/error-code.json`;
const PARTICIPATING_GLOBS = [
  'docs/accounts/tasks/**/*.{md,mdx}',
  'docs/brand-protocol/tasks/**/*.{md,mdx}',
  'docs/creative/task-reference/**/*.{md,mdx}',
  'docs/governance/**/tasks/**/*.{md,mdx}',
  'docs/media-buy/task-reference/**/*.{md,mdx}',
  'docs/signals/tasks/**/*.{md,mdx}',
  'docs/sponsored-intelligence/tasks/**/*.{md,mdx}',
  'docs/protocol/**/*.{md,mdx}',
  'docs/building/verification/**/*.{md,mdx}',
  'docs/building/by-layer/L3/comply-test-controller.mdx',
  'docs/building/by-layer/L3/error-handling.mdx',
  'docs/governance/creative/get_creative_features.mdx',
];
const ERROR_CANDIDATE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const TASK_CANDIDATE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const PSEUDO_LINK = /^adcp:(error-code|task|storyboard|field)\/(.+)$/;
const PARSER = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml']);

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function relativeInside(repoRoot, filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path resolves outside the repository: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function readRegularFileRecord(repoRoot, relative) {
  const filePath = path.resolve(repoRoot, relative);
  relativeInside(repoRoot, filePath);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('not a regular file');
    return {
      content: fs.readFileSync(descriptor, 'utf8'),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    throw new Error(`Unable to read regular file ${relative}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readRegularFile(repoRoot, relative) {
  return readRegularFileRecord(repoRoot, relative).content;
}

function readJson(repoRoot, relative) {
  try {
    return JSON.parse(readRegularFile(repoRoot, relative));
  } catch (error) {
    throw new Error(`Unable to read JSON ${relative}: ${error.message}`);
  }
}

function discoverFiles(repoRoot, patterns = PARTICIPATING_GLOBS) {
  const files = globSync(patterns, {
    cwd: repoRoot,
    nodir: true,
    posix: true,
    follow: false,
  }).sort(compareText);
  if (files.length === 0) {
    throw new Error(`No participating docs matched: ${patterns.join(', ')}`);
  }
  for (const relative of files) readRegularFile(repoRoot, relative);
  return files;
}

function addUniqueAuthority(map, symbol, authority) {
  const entries = map.get(symbol) ?? [];
  if (!entries.some(entry => entry.family === authority.family && entry.target === authority.target)) {
    entries.push(authority);
    entries.sort((a, b) => compareText(a.family, b.family));
    map.set(symbol, entries);
  }
}

function enumAt(document, pathSegments, source) {
  let value = document;
  for (const segment of pathSegments) value = value?.[segment];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${source}: expected a string enum at ${pathSegments.join('.')}`);
  }
  return value;
}

function collectErrorAuthorities(repoRoot) {
  const errors = new Map();
  const standard = readJson(repoRoot, STANDARD_ERROR_SCHEMA);
  for (const code of enumAt(standard, ['enum'], STANDARD_ERROR_SCHEMA)) {
    addUniqueAuthority(errors, code, {
      family: 'standard',
      target: `/docs/building/verification/compliance-catalog#error-code-${code.toLowerCase().replaceAll('_', '-')}`,
    });
  }

  const enumSources = [
    {
      family: 'controller',
      file: `${SCHEMA_SOURCE}/compliance/comply-test-controller-response.json`,
      path: ['oneOf', 7, 'properties', 'error', 'enum'],
      target: '/docs/building/by-layer/L3/comply-test-controller#error-codes',
    },
    {
      family: 'property',
      file: `${SCHEMA_SOURCE}/property/property-error.json`,
      path: ['properties', 'code', 'enum'],
      target: '/docs/governance/property/specification#error-codes',
    },
    {
      family: 'trusted-match',
      file: `${SCHEMA_SOURCE}/trusted-match/error.json`,
      path: ['properties', 'code', 'enum'],
      target: '/docs/trusted-match/specification#error-response',
    },
  ];
  for (const source of enumSources) {
    const document = readJson(repoRoot, source.file);
    for (const code of enumAt(document, source.path, source.file)) {
      addUniqueAuthority(errors, code, { family: source.family, target: source.target });
    }
  }

  for (const relative of globSync(
    `${COMPLIANCE_SOURCE}/test-vectors/request-signing/**/negative/*.json`,
    { cwd: repoRoot, nodir: true, posix: true, follow: false },
  ).sort(compareText)) {
    const document = readJson(repoRoot, relative);
    const code = document?.expected_outcome?.error_code;
    if (typeof code !== 'string' || !code) {
      throw new Error(`${relative}: expected_outcome.error_code must be a nonempty string`);
    }
    addUniqueAuthority(errors, code, {
      family: 'request-signing',
      target: '/docs/building/by-layer/L1/request-signing#error-codes',
    });
  }
  return errors;
}

function discoverTaskAuthorities(repoRoot) {
  if (typeof discoverTools !== 'function') {
    throw new Error('scripts/build-schemas.cjs must export discoverTools');
  }
  const docsByBasename = new Map();
  for (const relative of globSync('docs/**/*.{md,mdx}', {
    cwd: repoRoot,
    nodir: true,
    posix: true,
    follow: false,
  })) {
    const basename = path.posix.basename(relative).replace(/\.mdx?$/, '').replaceAll('-', '_');
    const entries = docsByBasename.get(basename) ?? [];
    entries.push(relative);
    docsByBasename.set(basename, entries);
  }

  const headingsByTask = new Map();
  const headingDocs = globSync([
    'docs/**/tasks/**/*.{md,mdx}',
    'docs/**/task-reference/**/*.{md,mdx}',
    'docs/building/by-layer/L3/comply-test-controller.mdx',
    'docs/building/by-layer/L3/task-lifecycle.mdx',
    'docs/creative/canonical-formats.mdx',
  ], {
    cwd: repoRoot,
    nodir: true,
    posix: true,
    follow: false,
  }).sort(compareText);
  for (const relative of headingDocs) {
    let tree;
    try {
      tree = PARSER.parse(readRegularFile(repoRoot, relative));
    } catch (error) {
      throw new Error(`Unable to parse task destination ${relative}: ${error.message}`);
    }
    visitParents(tree, 'heading', node => {
      const task = nodeText(node).trim().replaceAll('-', '_');
      if (!TASK_CANDIDATE.test(task)) return;
      const entries = headingsByTask.get(task) ?? [];
      entries.push({
        relative,
        target: `/${relative.replace(/\.mdx?$/, '')}#${task}`,
      });
      headingsByTask.set(task, entries);
    });
  }

  const tasks = new Map();
  for (const tool of discoverTools(path.join(repoRoot, SCHEMA_SOURCE))) {
    const matches = (docsByBasename.get(tool.name) ?? []).sort(compareText);
    if (matches.length > 1) {
      throw new Error(`Task ${tool.name} has ambiguous reference pages: ${matches.join(', ')}`);
    }
    const headingMatches = headingsByTask.get(tool.name) ?? [];
    const uniqueHeadingTargets = [...new Map(
      headingMatches.map(entry => [entry.target, entry]),
    ).values()];
    if (matches.length === 0 && uniqueHeadingTargets.length > 1) {
      throw new Error(
        `Task ${tool.name} has ambiguous heading destinations: ` +
        uniqueHeadingTargets.map(entry => entry.target).join(', '),
      );
    }
    const released = globSync(`dist/schemas/3.*.*/${tool.request_schema}`, {
      cwd: repoRoot,
      nodir: true,
      posix: true,
      follow: false,
    }).length > 0;
    const target = matches.length === 1
      ? `/${matches[0].replace(/\.mdx?$/, '')}`
      : uniqueHeadingTargets.length === 1
        ? uniqueHeadingTargets[0].target
        : `https://adcontextprotocol.org/schemas/${released ? 'v3' : 'latest'}/${tool.request_schema}`;
    tasks.set(tool.name, { ...tool, target });
  }
  return tasks;
}

function collectSchemaFields(repoRoot) {
  const names = new Set();
  const qualified = new Map();
  for (const relative of globSync(`${SCHEMA_SOURCE}/**/*.json`, {
    cwd: repoRoot,
    nodir: true,
    posix: true,
    follow: false,
  })) {
    const document = readJson(repoRoot, relative);
    const schemaRelative = relative.slice(`${SCHEMA_SOURCE}/`.length);
    const released = globSync(`dist/schemas/3.*.*/${schemaRelative}`, {
      cwd: repoRoot,
      nodir: true,
      posix: true,
      follow: false,
    }).length > 0;
    const visit = (value, pointer = '') => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${pointer}/${index}`));
      } else if (value && typeof value === 'object') {
        if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
          for (const key of Object.keys(value.properties)) {
            names.add(key);
            const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
            const fieldPointer = `${pointer}/properties/${escaped}`;
            qualified.set(`${schemaRelative}#${fieldPointer}`, {
              name: key,
              target:
                `https://adcontextprotocol.org/schemas/${released ? 'v3' : 'latest'}/` +
                `${schemaRelative}#${fieldPointer}`,
            });
          }
        }
        for (const [key, child] of Object.entries(value)) {
          const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
          visit(child, `${pointer}/${escaped}`);
        }
      }
    };
    visit(document);
  }
  return { names, qualified };
}

function collectStoryboardAuthorities(repoRoot) {
  const storyboards = new Map();
  for (const relative of globSync(`${COMPLIANCE_SOURCE}/**/*.yaml`, {
    cwd: repoRoot,
    nodir: true,
    posix: true,
    follow: false,
  }).sort(compareText)) {
    let document;
    try {
      document = yaml.load(readRegularFile(repoRoot, relative));
    } catch (error) {
      throw new Error(`Unable to parse storyboard source ${relative}: ${error.message}`);
    }
    if (!document || typeof document !== 'object' || typeof document.id !== 'string') continue;
    if (storyboards.has(document.id)) {
      throw new Error(
        `Duplicate storyboard id ${document.id}: ${storyboards.get(document.id).source}, ${relative}`,
      );
    }
    storyboards.set(document.id, {
      source: relative,
      target: `/compliance/latest/${relative.slice(`${COMPLIANCE_SOURCE}/`.length)}`,
    });
  }
  return storyboards;
}

function loadAuthorities(repoRoot) {
  return {
    errors: collectErrorAuthorities(repoRoot),
    fields: collectSchemaFields(repoRoot),
    storyboards: collectStoryboardAuthorities(repoRoot),
    tasks: discoverTaskAuthorities(repoRoot),
  };
}

function loadIgnoreList(repoRoot, participating, relative = IGNORE_FILE) {
  const document = readJson(repoRoot, relative);
  if (document.version !== 1 || !Array.isArray(document.entries)) {
    throw new Error(`${relative}: expected { "version": 1, "entries": [] }`);
  }
  const allowedFamilies = new Set(['error_code', 'task']);
  const ignores = new Map();
  let previous = '';
  for (const entry of document.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${relative}: each entry must be an object`);
    }
    const keys = Object.keys(entry).sort(compareText).join(',');
    if (keys !== 'family,path,reason,symbol') {
      throw new Error(`${relative}: ignore entries require exactly family, symbol, path, and reason`);
    }
    if (!allowedFamilies.has(entry.family)) {
      throw new Error(`${relative}: unsupported family ${entry.family}`);
    }
    if (typeof entry.symbol !== 'string' || !entry.symbol ||
        typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`${relative}: ignore symbol and reason must be nonempty strings`);
    }
    if (!participating.has(entry.path)) {
      throw new Error(`${relative}: ignore path is not a participating doc: ${entry.path}`);
    }
    const key = `${entry.path}\0${entry.family}\0${entry.symbol}`;
    if (key <= previous) {
      throw new Error(`${relative}: entries must be unique and sorted by path, family, symbol`);
    }
    previous = key;
    ignores.set(key, entry);
  }
  return ignores;
}

function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.value === 'string') return node.value;
  return Array.isArray(node.children) ? node.children.map(nodeText).join('') : '';
}

function sectionFor(offset, headings) {
  let section = '__root__';
  for (const heading of headings) {
    if (heading.offset >= offset) break;
    if (heading.depth <= 2) section = `${heading.depth}:${heading.text}`;
  }
  return section;
}

function tableColumnHeader(ancestors) {
  const table = [...ancestors].reverse().find(node => node.type === 'table');
  const row = [...ancestors].reverse().find(node => node.type === 'tableRow');
  const cell = [...ancestors].reverse().find(node => node.type === 'tableCell');
  if (!table || !row || !cell) return '';
  const column = row.children.indexOf(cell);
  return nodeText(table.children?.[0]?.children?.[column]).trim().toLowerCase();
}

function tableClaimFamily(ancestors) {
  const row = [...ancestors].reverse().find(node => node.type === 'tableRow');
  const cell = [...ancestors].reverse().find(node => node.type === 'tableCell');
  if (!row || !cell || row.children.indexOf(cell) !== 0) return null;
  const header = tableColumnHeader(ancestors);
  if (/^(error )?code$/.test(header)) return 'error_code';
  if (/^(task|tool|operation)( name)?$/.test(header)) return 'task';
  return null;
}

function isFieldContext(token, ancestors, source, start) {
  if (/^(field|property)( name)?$/.test(tableColumnHeader(ancestors))) return true;
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextNewline = source.indexOf('\n', start + token.length);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  const line = source
    .slice(lineStart, lineEnd)
    .replace(/\[(`[^`]+`)\]\([^)]*\)/g, '$1')
    .toLowerCase();
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = `\\\`${escaped}\\\``;
  return new RegExp(
    `(?:\\b(?:field|property)(?:\\s+named)?\\s+${code}|${code}\\s+(?:field|property)\\b)`,
  ).test(line);
}

function isStoryboardContext(token, ancestors, source, start) {
  if (/storyboard|scenario/.test(tableColumnHeader(ancestors))) return true;
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextNewline = source.indexOf('\n', start + token.length);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  const line = source
    .slice(lineStart, lineEnd)
    .replace(/\[(`[^`]+`)\]\([^)]*\)/g, '$1')
    .toLowerCase();
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = `\\\`${escaped}\\\``;
  return new RegExp(
    `(?:\\b(?:storyboard|scenario)(?:\\s+id)?\\s+(?:named\\s+)?${code}|` +
    `${code}\\s+(?:storyboard|scenario)\\b|` +
    `(?:^|\\s)(?:run|exercise)(?:s|d|ing)?\\s+${code})`,
  ).test(line);
}

function classifyUnknown(token, { ancestors = [], explicitFamily = null, source = '', start = 0 } = {}) {
  if (explicitFamily === 'error-code') return 'error_code';
  if (explicitFamily === 'task') return 'task';
  if (explicitFamily === 'storyboard') return 'storyboard';
  if (explicitFamily === 'field') return 'field';
  const tableFamily = tableClaimFamily(ancestors);
  if (tableFamily === 'error_code' && ERROR_CANDIDATE.test(token)) return 'error_code';
  if (tableFamily === 'task' && TASK_CANDIDATE.test(token)) return 'task';
  if (TASK_CANDIDATE.test(token) && isFieldContext(token, ancestors, source, start)) return 'field';
  if (TASK_CANDIDATE.test(token) && isStoryboardContext(token, ancestors, source, start)) {
    return 'storyboard';
  }
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextNewline = source.indexOf('\n', start + token.length);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  const nearby = source.slice(lineStart, lineEnd).toLowerCase();
  if (ERROR_CANDIDATE.test(token) && /error[ -]?code/.test(nearby)) return 'error_code';
  if (TASK_CANDIDATE.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const code = `\\\`${escaped}\\\``;
    const claimedTask = new RegExp(
      `(?:\\b(?:task|tool|operation)\\s+(?:named\\s+)?${code}|` +
      `${code}\\s+(?:(?:task|operation)\\b|tool\\b(?!\\s+family))|` +
      `(?:^|\\s)(?:call|invoke|execute)(?:s|d|ing)?\\s+(?:the\\s+)?${code})`,
    );
    if (claimedTask.test(nearby)) return 'task';
  }
  return null;
}

function isGeneratedTaskTarget(token, url) {
  if (!TASK_CANDIDATE.test(token) || typeof url !== 'string') return false;
  const [pathname, fragment = ''] = url.split('#', 2);
  const slug = token.replaceAll('_', '-');
  if (/\/(?:tasks|task-reference)\//.test(pathname)) return true;
  if (fragment === token || fragment === slug) return true;
  return pathname.endsWith(`/${token}`) ||
    pathname.endsWith(`/${slug}`) ||
    pathname.endsWith(`/${slug}-request.json`);
}

function resolveError(token, file, source, start, entries, explicitFamily = null) {
  const nearby = source
    .slice(Math.max(0, start - 180), start + token.length + 180)
    .replace(/\]\([^)]*\)/g, ']')
    .toLowerCase();
  const controllerContext = file.includes('comply-test-controller') ||
    file.includes('verification/get-test-ready') || /controller|comply[_ -]test/.test(nearby);
  if (controllerContext) {
    const controller = entries.find(entry => entry.family === 'controller');
    if (controller) return controller;
  }
  const scopedFamilies = [
    ['property', 'docs/governance/property/'],
    ['trusted-match', 'docs/trusted-match/'],
    ['request-signing', 'docs/building/by-layer/L1/request-signing'],
  ];
  for (const [family, prefix] of scopedFamilies) {
    const entry = entries.find(candidate => candidate.family === family);
    if (entry && (file.startsWith(prefix) || (explicitFamily === 'error-code' && entries.length === 1))) {
      return entry;
    }
  }
  const standard = entries.find(entry => entry.family === 'standard');
  return standard ?? null;
}

function canonicalSymbol(token, context) {
  const errorEntries = context.authorities.errors.get(token);
  if (errorEntries) {
    const resolved = resolveError(
      token,
      context.file,
      context.source,
      context.start,
      errorEntries,
      context.explicitFamily,
    );
    if (!resolved) {
      return { outOfScope: errorEntries.map(entry => entry.family), family: 'error_code' };
    }
    return { family: 'error_code', target: resolved.target };
  }
  const task = context.authorities.tasks.get(token);
  if (task) return { family: 'task', target: task.target };
  const storyboard = context.authorities.storyboards.get(token);
  if (storyboard) return { family: 'storyboard', target: storyboard.target };
  if (context.authorities.fields.names.has(token)) return { family: 'field', advisory: true };
  return null;
}

function lineFor(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function addWarning(context, key, message) {
  if (!context.warningKeys) context.warningKeys = new Set();
  if (context.warningKeys.has(key)) return;
  context.warningKeys.add(key);
  context.warnings.push(message);
}

function transformDocument(source, context) {
  let tree;
  try {
    tree = PARSER.parse(source);
  } catch (error) {
    context.errors.push(`${context.file}: unable to parse MDX: ${error.message}`);
    return source;
  }
  const headings = [];
  visitParents(tree, 'heading', node => {
    headings.push({ depth: node.depth, offset: node.position.start.offset, text: nodeText(node) });
  });
  headings.sort((a, b) => a.offset - b.offset);

  const edits = [];
  const linkedInSection = new Set();
  const handledLinks = new Set();
  visitParents(tree, 'inlineCode', (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (ancestors.some(ancestor => ancestor.type === 'heading')) return;
    const link = parent?.type === 'link' ? parent : null;
    const pseudo = link ? PSEUDO_LINK.exec(link.url) : null;
    if (link && !pseudo) {
      const known = canonicalSymbol(node.value, {
        ...context,
        source,
        start: node.position.start.offset,
      });
      if (known?.outOfScope) {
        edits.push({
          end: link.position.end.offset,
          replacement: `\`${node.value}\``,
          start: link.position.start.offset,
        });
        return;
      }
      if (known?.advisory) {
        return;
      }
      if (known?.family === 'storyboard' &&
          !isStoryboardContext(node.value, ancestors, source, node.position.start.offset)) {
        if (known.target === link.url) {
          edits.push({
            end: link.position.end.offset,
            replacement: `\`${node.value}\``,
            start: link.position.start.offset,
          });
        }
        return;
      }
      if (known?.target) {
        const selfTarget = `/${context.file.replace(/\.mdx?$/, '')}`;
        const richerAuthoredText = link.children.length !== 1 || link.children[0] !== node;
        const authoredDeepLink = link.url.includes('#');
        if (known.target !== selfTarget && link.url !== known.target &&
            !richerAuthoredText && !authoredDeepLink) {
          edits.push({
            end: link.position.end.offset,
            replacement: `[\`${node.value}\`](${known.target})`,
            start: link.position.start.offset,
          });
        }
        linkedInSection.add(
          `${sectionFor(node.position.start.offset, headings)}\0${known.family}\0${node.value}`,
        );
        context.references.push({ file: context.file, token: node.value, target: link.url });
        return;
      }
    }

    const explicitFamily = pseudo?.[1] ?? null;
    const pseudoValue = pseudo?.[2] ?? null;
    const token = node.value;
    let known;
    if (explicitFamily === 'field') {
      const qualifiedField = context.authorities.fields.qualified.get(pseudoValue);
      if (!qualifiedField) {
        addWarning(
          context,
          `field-qualified\0${pseudoValue}`,
          `${context.file}:${lineFor(source, node.position.start.offset)}: ` +
            `unresolved qualified field \`${pseudoValue}\``,
        );
        return;
      }
      if (qualifiedField.name !== token) {
        addWarning(
          context,
          `field-mismatch\0${pseudoValue}\0${token}`,
          `${context.file}:${lineFor(source, node.position.start.offset)}: qualified field ` +
            `${JSON.stringify(pseudoValue)} does not name inline code ${JSON.stringify(token)}`,
        );
        return;
      }
      known = { family: 'field', target: qualifiedField.target };
    } else if (pseudo && pseudoValue !== token) {
      context.errors.push(
        `${context.file}:${lineFor(source, node.position.start.offset)}: pseudo-link token ` +
        `${JSON.stringify(pseudoValue)} must match inline code ${JSON.stringify(token)}`,
      );
      return;
    }
    known ??= canonicalSymbol(token, {
        ...context,
        explicitFamily,
        source,
        start: node.position.start.offset,
      });
    if (known?.ambiguous) {
      context.errors.push(
        `${context.file}:${lineFor(source, node.position.start.offset)}: ambiguous error symbol ` +
        `\`${token}\` (${known.ambiguous.join(', ')})`,
      );
      return;
    }
    if (known?.advisory) {
      return;
    }
    if (known?.target) {
      const selfTarget = `/${context.file.replace(/\.mdx?$/, '')}`;
      if (!pseudo && known.target === selfTarget) return;
      if (!pseudo && known.family === 'storyboard' &&
          !isStoryboardContext(token, ancestors, source, node.position.start.offset)) return;
      if (explicitFamily && explicitFamily.replace('-', '_') !== known.family &&
          !(explicitFamily === 'error-code' && known.family === 'error_code')) {
        context.errors.push(
          `${context.file}:${lineFor(source, node.position.start.offset)}: ` +
          `${link.url} resolves as ${known.family}, not ${explicitFamily}`,
        );
        return;
      }
      const sectionKey = `${sectionFor(node.position.start.offset, headings)}\0${known.family}\0${token}`;
      if (!pseudo && linkedInSection.has(sectionKey)) return;
      const editNode = pseudo ? link : node;
      if (pseudo && handledLinks.has(link)) return;
      if (pseudo) handledLinks.add(link);
      edits.push({
        end: editNode.position.end.offset,
        replacement: `[\`${token}\`](${known.target})`,
        start: editNode.position.start.offset,
      });
      linkedInSection.add(sectionKey);
      context.references.push({ file: context.file, token, target: known.target });
      return;
    }

    const family = isGeneratedTaskTarget(token, link?.url)
      ? 'task'
      : classifyUnknown(token, {
      ancestors,
      explicitFamily,
      source,
      start: node.position.start.offset,
    });
    if (!family) return;
    if (family === 'storyboard' || family === 'field') {
      addWarning(
        context,
        `${family}\0${token}`,
        `${context.file}:${lineFor(source, node.position.start.offset)}: unresolved ${family} \`${token}\``,
      );
      return;
    }
    const ignoreKey = `${context.file}\0${family}\0${token}`;
    if (context.ignores.has(ignoreKey)) {
      context.usedIgnores.add(ignoreKey);
      return;
    }
    context.errors.push(
      `${context.file}:${lineFor(source, node.position.start.offset)}: unresolved ${family} symbol \`${token}\``,
    );
  });

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) {
      context.errors.push(`${context.file}: overlapping symbol-link edits`);
      return source;
    }
  }
  let output = source;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

function validateIgnoreUsage(ignores, usedIgnores, authorities) {
  const errors = [];
  for (const [key, entry] of ignores) {
    const errorEntries = entry.family === 'error_code'
      ? authorities.errors.get(entry.symbol)
      : null;
    const nowKnown = entry.family === 'error_code'
      ? Boolean(errorEntries && resolveError(entry.symbol, entry.path, '', 0, errorEntries))
      : authorities.tasks.has(entry.symbol);
    if (nowKnown) {
      errors.push(`${IGNORE_FILE}: ${entry.path} ${entry.family} ${entry.symbol} now resolves`);
    } else if (!usedIgnores.has(key)) {
      errors.push(`${IGNORE_FILE}: unused ignore for ${entry.path} ${entry.family} ${entry.symbol}`);
    }
  }
  return errors;
}

function writeTransactional(repoRoot, changes, {
  link = fs.linkSync,
  rename = fs.renameSync,
} = {}) {
  const staged = [];
  const backedUp = [];
  const committed = [];
  try {
    changes.forEach((change, index) => {
      const destination = path.resolve(repoRoot, change.relative);
      relativeInside(repoRoot, destination);
      const suffix = `${process.pid}-${index}-${randomUUID()}`;
      const temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.adcp-symbols-${suffix}`,
      );
      const backup = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.adcp-symbols-backup-${suffix}`,
      );
      const recovery = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.adcp-symbols-recovery-${suffix}`,
      );
      // Track the paths before opening so a failure during staging cannot leak
      // the partially written temporary file.
      staged.push({ ...change, backup, destination, recovery, temporary });
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.fchmodSync(descriptor, change.mode);
        fs.writeFileSync(descriptor, change.after, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    });

    // Revalidate the complete set only after every replacement is durable.
    for (const item of staged) {
      if (readRegularFile(repoRoot, item.relative) !== item.before) {
        throw new Error(`${item.relative} changed while compliance symbols were being linked`);
      }
    }

    // Move originals aside first. Replacements are installed with hard links,
    // which are atomic and fail with EEXIST if another process recreates a
    // destination. Temporary files live beside their destinations, so the
    // hard-link operation is always on the same filesystem.
    for (const item of staged) {
      rename(item.destination, item.backup);
      backedUp.push(item);
      if (fs.readFileSync(item.backup, 'utf8') !== item.before) {
        throw new Error(`${item.relative} changed while compliance symbols were being linked`);
      }
    }
    for (const item of staged) {
      link(item.temporary, item.destination);
      committed.push(item);
      fs.unlinkSync(item.temporary);
    }
    for (const item of backedUp) {
      try { fs.unlinkSync(item.backup); } catch {}
    }
  } catch (error) {
    const rollbackErrors = [];
    const recoveryNotes = [];
    for (const item of [...committed].reverse()) {
      try {
        // Never discard an installed inode during rollback: another process
        // may have edited it in place. Moving it atomically preserves either
        // the generated content or the concurrent edit before restoration.
        rename(item.destination, item.recovery);
        recoveryNotes.push(`${item.relative} replacement retained at ${item.recovery}`);
      } catch (rollbackError) {
        if (rollbackError.code !== 'ENOENT') {
          rollbackErrors.push(`could not preserve ${item.relative}: ${rollbackError.message}`);
        }
      }
    }
    for (const item of [...backedUp].reverse()) {
      if (!fs.existsSync(item.backup)) continue;
      try {
        // A hard link is a no-clobber restore: if a process recreated the
        // destination, preserve it and retain the original backup for recovery.
        link(item.backup, item.destination);
        fs.unlinkSync(item.backup);
      } catch (rollbackError) {
        rollbackErrors.push(
          `could not restore ${item.relative}; original retained at ${item.backup}: ` +
          rollbackError.message,
        );
      }
    }
    for (const item of staged) {
      try { fs.unlinkSync(item.temporary); } catch {}
    }
    if (rollbackErrors.length) {
      throw new Error(
        `${error.message || error}\nRollback incomplete:\n  - ${rollbackErrors.join('\n  - ')}` +
        (recoveryNotes.length ? `\nRecovery copies:\n  - ${recoveryNotes.join('\n  - ')}` : ''),
        { cause: error },
      );
    }
    if (recoveryNotes.length) {
      throw new Error(
        `${error.message || error}\nRecovery copies:\n  - ${recoveryNotes.join('\n  - ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function linkComplianceSymbols({
  repoRoot = REPO_ROOT,
  check = false,
  patterns = PARTICIPATING_GLOBS,
} = {}) {
  const files = discoverFiles(repoRoot, patterns);
  const participating = new Set(files);
  const authorities = loadAuthorities(repoRoot);
  const ignores = loadIgnoreList(repoRoot, participating);
  const usedIgnores = new Set();
  const errors = [];
  const warnings = [];
  const references = [];
  const changes = [];

  for (const relative of files) {
    const record = readRegularFileRecord(repoRoot, relative);
    const before = record.content;
    const after = transformDocument(before, {
      authorities,
      errors,
      file: relative,
      ignores,
      references,
      usedIgnores,
      warnings,
    });
    if (after !== before) changes.push({ after, before, mode: record.mode, relative });
  }
  errors.push(...validateIgnoreUsage(ignores, usedIgnores, authorities));
  if (check && changes.length) {
    errors.push(
      `Compliance symbol links are stale in ${changes.length} file(s): ` +
      `${changes.map(change => change.relative).join(', ')}. Run \`npm run build:compliance\`.`,
    );
  }
  if (!check && errors.length === 0) writeTransactional(repoRoot, changes);
  return {
    changed: changes.map(change => change.relative),
    errors,
    references,
    warnings,
  };
}

function main() {
  const allowed = new Set(['--check', '--fix']);
  const unknown = process.argv.slice(2).filter(argument => !allowed.has(argument));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
  if (process.argv.includes('--check') && process.argv.includes('--fix')) {
    throw new Error('--check and --fix are mutually exclusive');
  }
  const check = process.argv.includes('--check');
  const result = linkComplianceSymbols({ check });
  if (result.warnings.length) {
    console.warn(
      `warning: ${result.warnings.length} advisory symbol candidate(s); ` +
      'error codes and tasks become blocking only in structurally claimed contexts',
    );
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  }
  if (result.errors.length) {
    throw new Error(`Compliance symbol linking failed:\n  - ${result.errors.join('\n  - ')}`);
  }
  console.log(check
    ? `✓ compliance symbol links are current (${result.references.length} references)`
    : `✓ linked compliance symbols (${result.changed.length} files updated, ${result.references.length} references)`);
}

try {
  const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (isMain) main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

export {
  ERROR_CANDIDATE,
  PARTICIPATING_GLOBS,
  TASK_CANDIDATE,
  classifyUnknown,
  collectSchemaFields,
  discoverTaskAuthorities,
  linkComplianceSymbols,
  loadAuthorities,
  loadIgnoreList,
  readRegularFileRecord,
  transformDocument,
  validateIgnoreUsage,
  writeTransactional,
};
