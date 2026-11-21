#!/usr/bin/env node
/**
 * Structural guard: modules must not evaluate heavy dependencies at import
 * time when a narrower or deferred path gives callers the same objects.
 *
 *   1. No value import or re-export from the `@adcp/sdk` barrel when every
 *      imported name is exported, as the identical binding (===, resolved at
 *      runtime), by a narrower `@adcp/sdk/<subpath>`. Type-only specifiers are
 *      erased and exempt; names only the barrel exports keep the import legal.
 *      The allowlist is shrink-only: an entry that no longer needs its
 *      exemption fails the suite until it is removed.
 *   2. No static value import or re-export of isomorphic-dompurify, linkedom,
 *      pdf-parse, mammoth or @google-cloud/kms under server/src. Use the
 *      getters in server/src/utils/deferred-modules.ts or `await import()`.
 *   3. The server unit setup file, which runs before every server test file,
 *      does not statically load supertest, directly or through a relative
 *      module it statically imports.
 *   4. ESM-context files (.ts, .tsx, .mts, .mjs under server, tests and
 *      scripts; .d.ts excluded) reach @adcp/sdk only through its ESM entry
 *      points: no createRequire(...)('@adcp/sdk...'), no require('@adcp/sdk...')
 *      through a createRequire-made function (however it is named or
 *      aliased), and no <createRequire-made>.resolve('@adcp/sdk...'), except
 *      '@adcp/sdk/package.json' (JSON, no build). Those load the CommonJS
 *      build next to the ESM one, so one process holds two schema loaders
 *      with separate roots and caches. import.meta.resolve() is the ESM form
 *      and stays legal. The allowlist is shrink-only. .cjs files are out of
 *      scope (tp-n2s tracks CJS helpers loaded into ESM processes), and code
 *      inside strings (an --eval script) is not parsed.
 *
 * Imports are read with the TypeScript parser, not regexes, so multi-line
 * clauses, either quote style, aliases and `export ... from` are all seen.
 * Each check has positive and negative meta-tests on inline source fixtures.
 */

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { checkoutGitEnv } = require('./helpers/git-object-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = ['server/src', 'server/tests', 'tests', 'scripts'];
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// Narrower SDK entry points, cheapest first: a name maps to the first subpath
// that exports the identical binding.
const SDK_SUBPATHS = [
  'utils', 'errors', 'version', 'brand', 'registry', 'net', 'discovery', 'auth',
  'advanced', 'client/core', 'server', 'signing', 'testing',
];

// Barrel imports whose names have narrower homes but whose vi.mock('@adcp/sdk')
// consumers must be retargeted in the same change. Tracked by tp-dbc. Shrink
// only: do not add entries.
const BARREL_ALLOWLIST = new Set([
  'server/src/capabilities.ts',
  'server/src/health.ts',
  'server/src/http.ts',
]);

const DEFERRED_PACKAGES = ['isomorphic-dompurify', 'linkedom', 'pdf-parse', 'mammoth', '@google-cloud/kms'];

const ESM_CONTEXT_SCOPE = ['server', 'tests', 'scripts'];
const ESM_CONTEXT_FILE = /\.(?:ts|tsx|mts|mjs)$/;
const SDK_PACKAGE_JSON = '@adcp/sdk/package.json';

// ESM-context files allowed to load the CommonJS SDK build. Shrink only: an
// entry must be the only SDK build its process loads.
const CJS_SDK_ALLOWLIST = new Set([
  // A node:test file whose only other import, scripts/add-storyboard-account-
  // fixtures.mjs, does not import the SDK: the CommonJS build is its only one.
  'tests/lint-storyboard-account-fixtures.node.mjs',
  // Interop processes that load the SDK under test from a separate pinned
  // install (createRequire from <env>/node/package.json), CommonJS only, and
  // import nothing else that loads @adcp/sdk.
  'tests/interop/differential/cli-ts.mjs',
  'tests/interop/matrix/ts/buyer.mjs',
  'tests/interop/matrix/ts/seller.mjs',
]);

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(?:ts|mts|cts)$/.test(file)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isEsmContextFile(file) {
  return ESM_CONTEXT_FILE.test(file) && !file.endsWith('.d.ts');
}

// Work counters, instrumentation only: actual repository file reads, the
// distinct files asked for, git ls-files listings, and every file handed to
// ts.createSourceFile. The tree-pass work test asserts on them.
const work = { reads: 0, requested: new Set(), listings: 0, parsed: new Set() };

// ---------------------------------------------------------------------------
// Target prefilter
//
// Checks 1, 2 and 4 look for module specifiers (and check 4 for createRequire)
// that a file can hold only if their text appears in it. TypeScript cooks
// escapes in string literals and identifiers ('\x40adcp/sdk' is '@adcp/sdk'),
// so the test runs on the source with every escape decoded. No escape contains
// a quote except an identity escape that ends at one, so decoding never runs
// across a literal's opening delimiter: each cooked literal and identifier is
// a substring of the decoded text, and a raw occurrence of a target survives
// decoding. A file the prefilter rejects cannot have a violation of that
// check, so the check returns [] without parsing it.
// ---------------------------------------------------------------------------

// \xHH, \uHHHH, \u{H+}, legacy octal (\0-\3 plus up to two octal digits, \4-\7
// plus one), line continuations (LF, CR, CRLF, U+2028, U+2029) removed, and any
// other escaped character as itself. A malformed \x or \u decodes to x or u,
// which keeps every character after it: still a superset for targets with no
// backslash.
const ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g;

function decodeEscapes(source) {
  return source.replace(ESCAPE, (raw, hex, braced, u4, octal, continuation, other) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    if (braced !== undefined) return parseInt(braced, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(braced, 16)) : raw;
    if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
    if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8));
    if (continuation !== undefined) return '';
    return other;
  });
}

// One decoded text per file and source text.
const decodedCache = new Map();
function decodedText(file, source) {
  if (!source.includes('\\')) return source;
  const hit = decodedCache.get(file);
  if (hit && hit.source === source) return hit.text;
  const text = decodeEscapes(source);
  decodedCache.set(file, { source, text });
  return text;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Check 1: an import or re-export whose StringLiteral specifier is exactly
// '@adcp/sdk'; the closing quote is never escaped.
const BARREL_SPECIFIER = /@adcp\/sdk['"]/;
// Check 2: a specifier equal to a deferred package or under it.
const DEFERRED_SPECIFIER = new RegExp(`(?:${DEFERRED_PACKAGES.map(escapeRegExp).join('|')})['"/]`);

function mayHoldBarrelImport(file, source) {
  return BARREL_SPECIFIER.test(decodedText(file, source));
}

function mayHoldDeferredImport(file, source) {
  return DEFERRED_SPECIFIER.test(decodedText(file, source));
}

// Check 4: a call needs a createRequire-made function and an '@adcp/sdk...'
// literal argument.
function mayReachCommonJsSdk(file, source) {
  const text = decodedText(file, source);
  return text.includes('createRequire') && text.includes('@adcp/sdk');
}

// One parse per file and source text. The tree checks read the same files;
// a file's import list and its check 4 result come from one syntax tree, and
// only those results are kept, not the tree. No check reads node.parent, so
// the parser does not set it.
const factsCache = new Map();
let parseCount = 0;
function fileFacts(file, source) {
  const hit = factsCache.get(file);
  if (hit && hit.source === source) return hit;
  parseCount += 1;
  work.parsed.add(file);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKind(file));
  const facts = {
    source,
    imports: importsOf(sf),
    commonJsSdkReach: isEsmContextFile(file) && mayReachCommonJsSdk(file, source) ? commonJsSdkReachOf(file, sf) : [],
  };
  factsCache.set(file, facts);
  return facts;
}

/**
 * Static declarations that evaluate a module at runtime: value imports,
 * side-effect imports, `import x = require()` and `export ... from`.
 * `names` lists the imported binding names (original names, not aliases),
 * or is null when the whole module namespace is taken (`* as`, `export *`).
 * Side-effect imports have `names: []`. Type-only forms are omitted.
 */
function staticValueImports(file, source) {
  return fileFacts(file, source).imports;
}

function importsOf(sf) {
  const found = [];
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const spec = node.moduleSpecifier.text;
      if (!clause) {
        found.push({ spec, names: [], line: line(node) });
        continue;
      }
      if (clause.isTypeOnly) continue;
      const names = [];
      let namespace = false;
      if (clause.name) names.push('default');
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespace = true;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
        }
      }
      // `import { type A } from 'x'` is elided entirely under isolatedModules.
      if (!namespace && names.length === 0) continue;
      found.push({ spec, names: namespace ? null : names, line: line(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.isTypeOnly) continue;
      const spec = node.moduleSpecifier.text;
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        found.push({ spec, names: null, line: line(node) });
        continue;
      }
      const names = node.exportClause.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text);
      if (names.length) found.push({ spec, names, line: line(node) });
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push({ spec: node.moduleReference.expression.text, names: null, line: line(node) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Checks. Each returns violation strings `file:line: detail`.
// ---------------------------------------------------------------------------

/** Check 1. `sdk` = { barrel, subpaths: { [subpath]: module } }. */
function checkBarrelImports(file, source, sdk) {
  if (!mayHoldBarrelImport(file, source)) return [];
  const violations = [];
  for (const imp of staticValueImports(file, source)) {
    if (imp.spec !== '@adcp/sdk' || !imp.names || imp.names.length === 0) continue;
    const mapping = imp.names.map((name) => [name, narrowestSubpath(name, sdk)]);
    if (mapping.some(([, subpath]) => !subpath)) continue;
    violations.push(`${file}:${imp.line}: @adcp/sdk barrel import of ${mapping.map(([n, s]) => `${n} -> @adcp/sdk/${s}`).join(', ')}`);
  }
  return violations;
}

function narrowestSubpath(name, sdk) {
  if (name === 'default' || !(name in sdk.barrel)) return undefined;
  return SDK_SUBPATHS.find((s) => sdk.subpaths[s] && name in sdk.subpaths[s] && sdk.subpaths[s][name] === sdk.barrel[name]);
}

/** Drops violations in allowlisted files; reports allowlist entries that no longer need it. */
function applyAllowlist(violationsByFile, allowlist) {
  const kept = [];
  const usedEntries = new Set();
  for (const [file, violations] of violationsByFile) {
    if (allowlist.has(file)) {
      if (violations.length) usedEntries.add(file);
      continue;
    }
    kept.push(...violations);
  }
  const stale = [...allowlist].filter((entry) => !usedEntries.has(entry));
  return { violations: kept, stale };
}

/** Check 2. */
function checkDeferredPackageImports(file, source) {
  if (!file.startsWith('server/src/') || !mayHoldDeferredImport(file, source)) return [];
  return staticValueImports(file, source)
    .filter((imp) => DEFERRED_PACKAGES.some((pkg) => imp.spec === pkg || imp.spec.startsWith(`${pkg}/`)))
    .map((imp) => `${file}:${imp.line}: static value import of ${imp.spec}`);
}

/**
 * Check 3. Walks static value imports from each setup file through relative
 * modules; `read(file)` returns source or undefined.
 */
function checkSetupSupertest(setupFiles, read) {
  const violations = [];
  for (const setupFile of setupFiles) {
    const queue = [[setupFile, [setupFile]]];
    const visited = new Set();
    while (queue.length) {
      const [file, chain] = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = read(file);
      if (source === undefined) continue;
      for (const imp of staticValueImports(file, source)) {
        if (imp.spec === 'supertest' || imp.spec.startsWith('supertest/')) {
          violations.push(`${file}:${imp.line}: static import of ${imp.spec} (via ${chain.join(' -> ')})`);
        } else if (imp.spec.startsWith('.')) {
          const target = resolveRelative(file, imp.spec, read);
          if (target) queue.push([target, [...chain, target]]);
        }
      }
    }
  }
  return violations;
}

function resolveRelative(fromFile, spec, read) {
  const base = path.posix.join(path.posix.dirname(fromFile), spec);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.js`];
  return candidates.find((c) => read(c) !== undefined);
}

/** The module text of a string literal or substitution-free template, else undefined. */
function literalText(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

function isSdkSpecifier(spec) {
  return spec !== undefined && spec !== SDK_PACKAGE_JSON && (spec === '@adcp/sdk' || spec.startsWith('@adcp/sdk/'));
}

/** Check 4. */
function checkCommonJsSdkReach(file, source) {
  if (!isEsmContextFile(file) || !mayReachCommonJsSdk(file, source)) return [];
  return fileFacts(file, source).commonJsSdkReach;
}

function commonJsSdkReachOf(file, sf) {
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // Local names of createRequire, and of the node:module namespace.
  const createRequireNames = new Set(['createRequire']);
  const moduleNamespaces = new Set();
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    if (node.moduleSpecifier.text !== 'module' && node.moduleSpecifier.text !== 'node:module') continue;
    const clause = node.importClause;
    if (!clause) continue;
    if (clause.name) moduleNamespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === 'createRequire') createRequireNames.add(el.name.text);
      }
    }
  }
  const isCreateRequireCall = (node) => ts.isCallExpression(node) && (
    (ts.isIdentifier(node.expression) && createRequireNames.has(node.expression.text))
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createRequire'
      && (!ts.isIdentifier(node.expression.expression) || moduleNamespaces.has(node.expression.expression.text)
        || node.expression.expression.text === 'module'))
  );

  // Variables holding a createRequire-made function, through any alias chain.
  const requireNames = new Set();
  const bindings = [];
  (function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.push([node.name.text, node.initializer]);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      bindings.push([node.left.text, node.right]);
    }
    ts.forEachChild(node, collect);
  })(sf);
  const unwrap = (node) => {
    let n = node;
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isNonNullExpression(n))) n = n.expression;
    return n;
  };
  const isRequireFunction = (node) => {
    const n = unwrap(node);
    return isCreateRequireCall(n) || (ts.isIdentifier(n) && requireNames.has(n.text));
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, value] of bindings) {
      if (!requireNames.has(name) && isRequireFunction(value)) {
        requireNames.add(name);
        grew = true;
      }
    }
  }

  const violations = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const spec = literalText(node.arguments[0]);
      if (isSdkSpecifier(spec)) {
        const callee = unwrap(node.expression);
        if (isRequireFunction(callee)) {
          violations.push(`${file}:${line(node.arguments[0])}: ${callee.getText(sf)}('${spec}') loads the CommonJS @adcp/sdk build`);
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && isRequireFunction(callee.expression)) {
          violations.push(`${file}:${line(node.arguments[0])}: ${callee.getText(sf)}('${spec}') resolves the CommonJS @adcp/sdk build`);
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return violations;
}

// ---------------------------------------------------------------------------
// Repository access
// ---------------------------------------------------------------------------

// One listing per scope per process; callers get their own copy.
const listings = new Map();
function trackedCodeFiles(scope = SCOPE) {
  const key = scope.join('\0');
  if (!listings.has(key)) {
    work.listings += 1;
    // Directory pathspecs, not 'dir/**/*.ts' globs, so top-level files count.
    // lint-allow-caller-git: lists the enclosing checkout's own files
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', ...scope], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: checkoutGitEnv() });
    listings.set(key, out.split('\0').filter((f) => f && CODE_FILE.test(f) && !f.endsWith('.d.ts')));
  }
  return [...listings.get(key)];
}

// One read per file per process: the tree checks, the allowlist checks and
// the setup walk all ask for the same files.
const sourceCache = new Map();
function readRepoFile(file) {
  work.requested.add(file);
  if (sourceCache.has(file)) return sourceCache.get(file);
  work.reads += 1;
  let source;
  try {
    source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    source = undefined;
  }
  sourceCache.set(file, source);
  return source;
}

/**
 * setupFiles of every server-suite worker, repo-relative: the first
 * setupFiles list of server/vitest.projects.ts (serverTestBase), which
 * server/vitest.config.ts and the root config's precommit:server-* projects
 * both use.
 */
function serverSetupFiles() {
  const config = readRepoFile('server/vitest.projects.ts');
  const list = /setupFiles\s*:\s*\[([^\]]*)\]/.exec(config ?? '');
  if (!list) return [];
  return [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map(([, p]) => path.posix.join('server', p));
}

let sdkPromise;
function loadSdk() {
  sdkPromise ??= (async () => {
    const barrel = await import('@adcp/sdk');
    const subpaths = Object.fromEntries(await Promise.all(SDK_SUBPATHS.map(async (s) => [s, await import(`@adcp/sdk/${s}`)])));
    return { barrel, subpaths };
  })();
  return sdkPromise;
}

function report(title, violations) {
  return `${title} (${violations.length}):\n${violations.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Tree pipelines: each tree check over a file list and a reader, so the tree
// tests, the work-count test and the negative control run the same code.
// ---------------------------------------------------------------------------

function barrelTreeViolations(files, read, sdk) {
  const byFile = files.map((f) => [f, checkBarrelImports(f, read(f), sdk)]);
  return applyAllowlist(byFile, BARREL_ALLOWLIST).violations;
}

function staleBarrelAllowlist(read, sdk) {
  const byFile = [...BARREL_ALLOWLIST].map((f) => [f, checkBarrelImports(f, read(f) ?? '', sdk)]);
  return applyAllowlist(byFile, BARREL_ALLOWLIST).stale;
}

function deferredTreeViolations(files, read) {
  return files.flatMap((f) => checkDeferredPackageImports(f, read(f)));
}

function cjsReachTreeViolations(files, read) {
  const byFile = files.map((f) => [f, checkCommonJsSdkReach(f, read(f))]);
  return applyAllowlist(byFile, CJS_SDK_ALLOWLIST).violations;
}

function staleCjsAllowlist(read) {
  const byFile = [...CJS_SDK_ALLOWLIST].map((f) => [f, checkCommonJsSdkReach(f, read(f) ?? '')]);
  return applyAllowlist(byFile, CJS_SDK_ALLOWLIST).stale;
}

// Reference escape decoder for the work-count oracle, independent of the
// prefilter it audits: \xHH, \uHHHH, \u{H+}, legacy octal (\0-\3 plus up to two
// octal digits, \4-\7 plus one), line continuations (LF, CR, CRLF, U+2028,
// U+2029) removed, a malformed \x or \u kept raw, any other char as identity.
function referenceDecode(source) {
  return source.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\u2028\u2029])|([xu])|([\s\S]))/g,
    (raw, hex, braced, u4, octal, continuation, malformed, other) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (braced) return parseInt(braced, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(braced, 16)) : raw;
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (octal) return String.fromCharCode(parseInt(octal, 8));
      if (continuation) return '';
      if (malformed) return raw;
      return other;
    },
  );
}

const DEFERRED_TARGET = new RegExp(`(?:${DEFERRED_PACKAGES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})['"/]`);

/** Whether `text` can hold a target of check 1, 2 or 4 for `file` (the design's prefilter conditions). */
function textMayHoldTarget(file, text) {
  return /@adcp\/sdk['"]/.test(text)
    || (file.startsWith('server/src/') && DEFERRED_TARGET.test(text))
    || (isEsmContextFile(file) && text.includes('createRequire') && text.includes('@adcp/sdk'));
}

/** Oracle read straight from disk so it does not move the work counters. */
function fileMayHoldTarget(file) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return false;
  }
  return textMayHoldTarget(file, raw) || textMayHoldTarget(file, referenceDecode(raw));
}

/** Files that seed one violation per check, each spelled with an escape so only a decoding prefilter keeps them. */
function seededViolationOverlay() {
  return {
    'server/src/zz-seeded-barrel.ts': "import { canonicalize } from '\\x40adcp/sdk';\nexport const c = canonicalize;\n",
    'server/src/zz-seeded-deferred.ts': "import { parseHTML } from 'linked\\u006fm';\nexport const p = parseHTML;\n",
    'scripts/zz-seeded-cjs.ts': "import { createRequire } from 'node:module';\nconst sdk = createRequire(import.meta.url)('\\u{40}adcp/sdk');\nexport default sdk;\n",
  };
}

// ---------------------------------------------------------------------------
// Tree checks
// ---------------------------------------------------------------------------

test('tree pass work: each file read once, each scope listed once, only files that can hold a target parsed', async () => {
  const sdk = await loadSdk();
  const before = { reads: work.reads, listings: work.listings, parsed: work.parsed.size };
  // The tree tests' pipelines, called as the tree tests call them.
  const files = trackedCodeFiles();
  barrelTreeViolations(files, readRepoFile, sdk);
  staleBarrelAllowlist(readRepoFile, sdk);
  deferredTreeViolations(trackedCodeFiles(), readRepoFile);
  const setupChain = new Set();
  checkSetupSupertest(serverSetupFiles(), (f) => {
    const source = readRepoFile(f);
    if (source !== undefined) setupChain.add(f);
    return source;
  });
  const esmFiles = trackedCodeFiles(ESM_CONTEXT_SCOPE);
  cjsReachTreeViolations(esmFiles, readRepoFile);
  staleCjsAllowlist(readRepoFile);

  const treeFiles = new Set([...files, ...esmFiles]);
  const pass = { reads: work.reads - before.reads, listings: work.listings - before.listings, parsed: work.parsed.size - before.parsed };
  const repoFiles = new Set([...treeFiles, ...BARREL_ALLOWLIST, ...CJS_SDK_ALLOWLIST, ...setupChain]);
  const parsedRepoFiles = [...work.parsed].filter((f) => repoFiles.has(f));
  const needless = parsedRepoFiles.filter((f) => !setupChain.has(f) && !fileMayHoldTarget(f)).sort();
  const summary = `this pass: ${pass.reads} reads over ${treeFiles.size} tracked files `
    + `(${files.length} in SCOPE, ${esmFiles.length} in ESM_CONTEXT_SCOPE), ${pass.listings} git ls-files listings, ${pass.parsed} newly parsed; `
    + `process totals: ${work.reads} reads of ${work.requested.size} distinct files, ${work.listings} listings, `
    + `${parsedRepoFiles.length} repository files parsed, ${needless.length} of them unable to hold a target and outside the setup chain`
    + `${needless.length ? ` (e.g. ${needless.slice(0, 5).join(', ')})` : ''}`;
  assert.deepEqual(
    { reads: work.reads, listings: work.listings, needlessParses: needless.length },
    { reads: work.requested.size, listings: 2, needlessParses: 0 },
    summary,
  );
});

test('negative control: the tree pipelines over the tracked tree plus seeded files report exactly the seeded violations', async () => {
  const sdk = await loadSdk();
  const overlay = seededViolationOverlay();
  const read = (f) => (Object.hasOwn(overlay, f) ? overlay[f] : readRepoFile(f));
  const seededIn = (scope) => Object.keys(overlay).filter((f) => scope.some((dir) => f.startsWith(`${dir}/`)));
  assert.deepEqual(barrelTreeViolations([...trackedCodeFiles(), ...seededIn(SCOPE)], read, sdk), [
    'server/src/zz-seeded-barrel.ts:1: @adcp/sdk barrel import of canonicalize -> @adcp/sdk/utils',
  ]);
  assert.deepEqual(deferredTreeViolations([...trackedCodeFiles(), ...seededIn(SCOPE)], read), [
    'server/src/zz-seeded-deferred.ts:1: static value import of linkedom',
  ]);
  assert.deepEqual(cjsReachTreeViolations([...trackedCodeFiles(ESM_CONTEXT_SCOPE), ...seededIn(ESM_CONTEXT_SCOPE)], read), [
    "scripts/zz-seeded-cjs.ts:2: createRequire(import.meta.url)('@adcp/sdk') loads the CommonJS @adcp/sdk build",
  ]);
});

test('tree: no @adcp/sdk barrel value import whose names all have a narrower subpath', async () => {
  const sdk = await loadSdk();
  const violations = barrelTreeViolations(trackedCodeFiles(), readRepoFile, sdk);
  assert.deepEqual(violations, [], report('Import these names from the narrower @adcp/sdk subpath', violations));
});

test('tree: the barrel allowlist is shrink-only (every entry still needs its exemption)', async () => {
  const sdk = await loadSdk();
  const stale = staleBarrelAllowlist(readRepoFile, sdk);
  assert.deepEqual(stale, [], `Remove these entries from BARREL_ALLOWLIST: ${stale.join(', ')}`);
});

test('tree: server/src has no static value import of the deferred heavy packages', () => {
  const violations = deferredTreeViolations(trackedCodeFiles(), readRepoFile);
  assert.deepEqual(violations, [], report('Load these through server/src/utils/deferred-modules.ts or await import()', violations));
});

test('tree: the server unit setup file does not statically load supertest', () => {
  const setupFiles = serverSetupFiles();
  assert.ok(setupFiles.length > 0, 'expected setupFiles in server/vitest.projects.ts');
  const violations = checkSetupSupertest(setupFiles, readRepoFile);
  assert.deepEqual(violations, [], report('Load supertest on demand (CONDUCTOR_IS_LOCAL only)', violations));
});

test('tree: ESM-context files reach @adcp/sdk only through its ESM entry points', () => {
  const violations = cjsReachTreeViolations(trackedCodeFiles(ESM_CONTEXT_SCOPE), readRepoFile);
  assert.deepEqual(violations, [], report(
    "Import @adcp/sdk (static import, import(), or import.meta.resolve); createRequire picks the CommonJS build",
    violations,
  ));
});

test('tree: the CommonJS SDK allowlist is shrink-only (every entry still needs its exemption)', () => {
  const stale = staleCjsAllowlist(readRepoFile);
  assert.deepEqual(stale, [], `Remove these entries from CJS_SDK_ALLOWLIST: ${stale.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Meta-tests: check 1 (barrel)
// ---------------------------------------------------------------------------

test('check 1 flags a barrel import whose names all have narrower homes', async () => {
  const sdk = await loadSdk();
  const v = checkBarrelImports('server/src/x.ts', "import { canonicalize, LIBRARY_VERSION } from '@adcp/sdk';\n", sdk);
  assert.deepEqual(v, ['server/src/x.ts:1: @adcp/sdk barrel import of canonicalize -> @adcp/sdk/utils, LIBRARY_VERSION -> @adcp/sdk/version']);
});

test('check 1 passes barrel-only names, type-only specifiers, dynamic imports and subpath imports', async () => {
  const sdk = await loadSdk();
  const clean = [
    "import { closeMCPConnections, canonicalize } from '@adcp/sdk';",
    "import type { AgentConfig } from '@adcp/sdk';",
    "import { type AgentConfig, type TaskResult } from '@adcp/sdk';",
    "export type { AgentConfig } from '@adcp/sdk';",
    "const { canonicalize } = await import('@adcp/sdk');",
    "type Sdk = typeof import('@adcp/sdk');",
    "import { canonicalize } from '@adcp/sdk/utils';",
    "import * as sdk from '@adcp/sdk';",
    "vi.mock('@adcp/sdk', async (orig) => ({ ...(await orig()) }));",
  ].join('\n');
  assert.deepEqual(checkBarrelImports('server/src/x.ts', clean, sdk), []);
});

test('check 1 keeps the value part of a mixed type/value import', async () => {
  const sdk = await loadSdk();
  const v = checkBarrelImports('server/src/x.ts', "import { type AgentConfig, AuthenticationRequiredError } from '@adcp/sdk';", sdk);
  assert.deepEqual(v, ['server/src/x.ts:1: @adcp/sdk barrel import of AuthenticationRequiredError -> @adcp/sdk/errors']);
});

test('check 1 resists regex slips: multi-line clause, double quotes, aliases, export-from, .mjs', async () => {
  const sdk = await loadSdk();
  const multi = 'const a = 1;\nimport {\n  canonicalize,\n  LIBRARY_VERSION as V,\n} from "@adcp/sdk";\n';
  assert.deepEqual(checkBarrelImports('tests/a.test.ts', multi, sdk), [
    'tests/a.test.ts:2: @adcp/sdk barrel import of canonicalize -> @adcp/sdk/utils, LIBRARY_VERSION -> @adcp/sdk/version',
  ]);
  assert.deepEqual(checkBarrelImports('server/src/r.ts', 'export { canonicalize as c } from "@adcp/sdk";', sdk), [
    'server/src/r.ts:1: @adcp/sdk barrel import of canonicalize -> @adcp/sdk/utils',
  ]);
  assert.deepEqual(checkBarrelImports('scripts/s.mjs', "import { ssrfSafeFetch } from '@adcp/sdk';", sdk), [
    'scripts/s.mjs:1: @adcp/sdk barrel import of ssrfSafeFetch -> @adcp/sdk/net',
  ]);
});

test('check 1 allowlist suppresses listed files and reports entries that no longer need it', async () => {
  const sdk = await loadSdk();
  const violating = "import { getPropertyIndex } from '@adcp/sdk';";
  const clean = "import { getPropertyIndex } from '@adcp/sdk/discovery';";
  const allowlist = new Set(['server/src/a.ts', 'server/src/b.ts']);
  const result = applyAllowlist([
    ['server/src/a.ts', checkBarrelImports('server/src/a.ts', violating, sdk)],
    ['server/src/b.ts', checkBarrelImports('server/src/b.ts', clean, sdk)],
    ['server/src/c.ts', checkBarrelImports('server/src/c.ts', violating, sdk)],
  ], allowlist);
  assert.deepEqual(result.violations, ['server/src/c.ts:1: @adcp/sdk barrel import of getPropertyIndex -> @adcp/sdk/discovery']);
  assert.deepEqual(result.stale, ['server/src/b.ts']);
});

test('check 1 requires the identical binding, not just the same name', async () => {
  const sdk = await loadSdk();
  const fake = { barrel: { foo: () => 1 }, subpaths: { utils: { foo: () => 1 } } };
  assert.deepEqual(checkBarrelImports('server/src/x.ts', "import { foo } from '@adcp/sdk';", fake), []);
  const shared = () => 1;
  const same = { barrel: { foo: shared }, subpaths: { utils: { foo: shared } } };
  assert.equal(checkBarrelImports('server/src/x.ts', "import { foo } from '@adcp/sdk';", same).length, 1);
  assert.ok(sdk.barrel.canonicalize === sdk.subpaths.utils.canonicalize, 'real SDK sanity: canonicalize is shared');
});

// ---------------------------------------------------------------------------
// Meta-tests: check 2 (deferred packages)
// ---------------------------------------------------------------------------

test('check 2 flags a static value import of each deferred package under server/src', () => {
  const source = [
    "import DOMPurify from 'isomorphic-dompurify';",
    "import { parseHTML } from 'linkedom';",
    "import { PDFParse } from 'pdf-parse';",
    "import mammoth from 'mammoth';",
    "import { KeyManagementServiceClient } from '@google-cloud/kms';",
  ].join('\n');
  assert.deepEqual(checkDeferredPackageImports('server/src/x.ts', source), [
    'server/src/x.ts:1: static value import of isomorphic-dompurify',
    'server/src/x.ts:2: static value import of linkedom',
    'server/src/x.ts:3: static value import of pdf-parse',
    'server/src/x.ts:4: static value import of mammoth',
    'server/src/x.ts:5: static value import of @google-cloud/kms',
  ]);
});

test('check 2 passes type-only imports, dynamic imports, typeof import() and files outside server/src', () => {
  const clean = [
    "import type { KeyManagementServiceClient } from '@google-cloud/kms';",
    "import { type PDFParse } from 'pdf-parse';",
    "type Purify = typeof import('isomorphic-dompurify');",
    "export async function f() { const { PDFParse } = await import('pdf-parse'); return import('mammoth'); }",
    "const linkedom = loadEsmSync('linkedom');",
  ].join('\n');
  assert.deepEqual(checkDeferredPackageImports('server/src/x.ts', clean), []);
  assert.deepEqual(checkDeferredPackageImports('server/tests/unit/x.test.ts', "import DOMPurify from 'isomorphic-dompurify';"), []);
});

test('check 2 resists regex slips: multi-line clause, double quotes, export-from, side-effect and subpath imports', () => {
  const source = [
    'import {',
    '  parseHTML,',
    '  DOMParser,',
    '} from "linkedom";',
    'export { default as mammoth } from "mammoth";',
    'export * from "@google-cloud/kms";',
    'import "pdf-parse";',
    "import worker from 'pdf-parse/worker';",
  ].join('\n');
  assert.deepEqual(checkDeferredPackageImports('server/src/x.ts', source), [
    'server/src/x.ts:1: static value import of linkedom',
    'server/src/x.ts:5: static value import of mammoth',
    'server/src/x.ts:6: static value import of @google-cloud/kms',
    'server/src/x.ts:7: static value import of pdf-parse',
    'server/src/x.ts:8: static value import of pdf-parse/worker',
  ]);
});

// ---------------------------------------------------------------------------
// Meta-tests: check 3 (setup file supertest)
// ---------------------------------------------------------------------------

function memoryRead(files) {
  return (file) => files[file];
}

test('check 3 finds the server vitest setup file it guards', () => {
  assert.ok(serverSetupFiles().includes('server/tests/setup/revenue-tracking-env.ts'), JSON.stringify(serverSetupFiles()));
});

test('check 3 flags a direct and a transitive static supertest import', () => {
  const read = memoryRead({
    'server/tests/setup/env.ts': "import request from 'supertest';\n",
    'server/tests/setup/env2.ts': "import { install } from './loopback.js';\ninstall();\n",
    'server/tests/setup/loopback.ts': "import type { Server } from 'node:net';\nimport request from 'supertest';\n",
  });
  assert.deepEqual(checkSetupSupertest(['server/tests/setup/env.ts', 'server/tests/setup/env2.ts'], read), [
    'server/tests/setup/env.ts:1: static import of supertest (via server/tests/setup/env.ts)',
    'server/tests/setup/loopback.ts:2: static import of supertest (via server/tests/setup/env2.ts -> server/tests/setup/loopback.ts)',
  ]);
});

test('check 3 passes an on-demand import and type-only imports', () => {
  const read = memoryRead({
    'server/tests/setup/env.ts': [
      "import type { Test } from 'supertest';",
      "if (process.env.CONDUCTOR_IS_LOCAL === '1') {",
      "  const { install } = await import('./loopback.js');",
      '  install();',
      '}',
    ].join('\n'),
    'server/tests/setup/loopback.ts': "import request from 'supertest';\n",
  });
  assert.deepEqual(checkSetupSupertest(['server/tests/setup/env.ts'], read), []);
});

test('check 3 resists regex slips: multi-line clause and double quotes', () => {
  const read = memoryRead({ 'server/tests/setup/env.ts': '// setup\nimport\n  request\nfrom "supertest";\n' });
  assert.deepEqual(checkSetupSupertest(['server/tests/setup/env.ts'], read), [
    'server/tests/setup/env.ts:2: static import of supertest (via server/tests/setup/env.ts)',
  ]);
});

// ---------------------------------------------------------------------------
// Meta-tests: check 4 (CommonJS SDK build from ESM-context files)
// ---------------------------------------------------------------------------

test('the checks parse a file once per source text, and again when the text changes', () => {
  const file = 'server/src/parse-once-fixture.ts';
  const source = "import { createRequire } from 'node:module';\nimport { x } from '@adcp/sdk';\ncreateRequire(import.meta.url)('@adcp/sdk');\n";
  const start = parseCount;
  assert.equal(checkDeferredPackageImports(file, source).length, 0);
  assert.equal(staticValueImports(file, source).length, 2);
  assert.equal(checkCommonJsSdkReach(file, source).length, 1);
  assert.equal(parseCount - start, 1, 'checks 1, 2 and 4 must share one parse of the same source');
  assert.equal(checkCommonJsSdkReach(file, `${source}// edited\n`).length, 1);
  assert.equal(parseCount - start, 2, 'a changed source must be parsed again');
});

test('check 4 flags createRequire calls, createRequire-made requires and their resolve()', () => {
  const source = [
    "import { createRequire } from 'node:module';",
    "import { dirname, join } from 'node:path';",
    "const testing = createRequire(import.meta.url)('@adcp/sdk/testing');",
    'const requireFromHere = createRequire(import.meta.url);',
    "const loader = join(dirname(requireFromHere.resolve('@adcp/sdk')), 'validation', 'schema-loader.js');",
    "const sdk = requireFromHere('@adcp/sdk');",
    'const require = createRequire(import.meta.url);',
    "const tracks = require(join(dirname(require.resolve('@adcp/sdk/testing')), 'compliance/storyboard-tracks.js'));",
  ].join('\n');
  assert.deepEqual(checkCommonJsSdkReach('server/src/x.ts', source), [
    "server/src/x.ts:3: createRequire(import.meta.url)('@adcp/sdk/testing') loads the CommonJS @adcp/sdk build",
    "server/src/x.ts:5: requireFromHere.resolve('@adcp/sdk') resolves the CommonJS @adcp/sdk build",
    "server/src/x.ts:6: requireFromHere('@adcp/sdk') loads the CommonJS @adcp/sdk build",
    "server/src/x.ts:8: require.resolve('@adcp/sdk/testing') resolves the CommonJS @adcp/sdk build",
  ]);
});

test('check 4 passes ESM entry points, package.json, other packages and non-ESM-context files', () => {
  const clean = [
    "import { createRequire } from 'node:module';",
    "import { registerExternalSchemaRoot } from '@adcp/sdk/testing';",
    "import type { AgentConfig } from '@adcp/sdk';",
    "const sdk = await import('@adcp/sdk');",
    "const tracks = await import(new URL('compliance/storyboard-tracks.mjs', import.meta.resolve('@adcp/sdk/testing')).href);",
    'const requireFromHere = createRequire(import.meta.url);',
    "const pkg = requireFromHere(requireFromHere.resolve('@adcp/sdk/package.json'));",
    "const pkg2 = createRequire(import.meta.url)('@adcp/sdk/package.json');",
    "const yaml = requireFromHere('yaml');",
    "const cached = Object.keys(createRequire(import.meta.url).cache);",
    "const other = { resolve: (s) => s }; other.resolve('@adcp/sdk');",
  ].join('\n');
  assert.deepEqual(checkCommonJsSdkReach('server/src/x.ts', clean), []);
  assert.deepEqual(checkCommonJsSdkReach('scripts/s.mjs', clean), []);
  const commonJs = "const { createRequire } = require('node:module');\nconst sdk = require('@adcp/sdk');\ncreateRequire(__filename)('@adcp/sdk/testing');";
  assert.deepEqual(checkCommonJsSdkReach('tests/a.test.cjs', commonJs), []);
  assert.deepEqual(checkCommonJsSdkReach('server/src/types.d.ts', "createRequire(import.meta.url)('@adcp/sdk');"), []);
});

test('check 4 resists slips: aliased require variable, aliased createRequire, double quotes, multi-line call, node:module namespace', () => {
  const source = [
    "import { createRequire as makeRequire } from 'module';",
    "import * as nodeModule from 'node:module';",
    'const req = makeRequire(import.meta.url);',
    'const load = req;',
    'load("@adcp/sdk/server");',
    'let later;',
    'later = load;',
    'later.resolve(`@adcp/sdk/schemas`);',
    'makeRequire(',
    '  import.meta.url,',
    ')(',
    '  "@adcp/sdk/testing",',
    ');',
    "(nodeModule.createRequire(import.meta.url) as NodeRequire)('@adcp/sdk');",
  ].join('\n');
  assert.deepEqual(checkCommonJsSdkReach('tests/helpers/h.ts', source), [
    "tests/helpers/h.ts:5: load('@adcp/sdk/server') loads the CommonJS @adcp/sdk build",
    "tests/helpers/h.ts:8: later.resolve('@adcp/sdk/schemas') resolves the CommonJS @adcp/sdk build",
    "tests/helpers/h.ts:12: makeRequire(\n  import.meta.url,\n)('@adcp/sdk/testing') loads the CommonJS @adcp/sdk build",
    "tests/helpers/h.ts:14: nodeModule.createRequire(import.meta.url)('@adcp/sdk') loads the CommonJS @adcp/sdk build",
  ]);
});

test('check 4 allowlist suppresses listed files and reports entries that no longer need it', () => {
  const violating = "import { createRequire } from 'node:module';\nconst sdk = createRequire(import.meta.url)('@adcp/sdk');";
  const clean = "import * as sdk from '@adcp/sdk';";
  const allowlist = new Set(['tests/a.node.mjs', 'tests/b.node.mjs']);
  const result = applyAllowlist([
    ['tests/a.node.mjs', checkCommonJsSdkReach('tests/a.node.mjs', violating)],
    ['tests/b.node.mjs', checkCommonJsSdkReach('tests/b.node.mjs', clean)],
    ['tests/c.node.mjs', checkCommonJsSdkReach('tests/c.node.mjs', violating)],
  ], allowlist);
  assert.deepEqual(result.violations, ["tests/c.node.mjs:2: createRequire(import.meta.url)('@adcp/sdk') loads the CommonJS @adcp/sdk build"]);
  assert.deepEqual(result.stale, ['tests/b.node.mjs']);
});

// ---------------------------------------------------------------------------
// Meta-tests: escaped specifiers (what a target prefilter must still let
// through: TypeScript cooks every escape form into the literal's text)
// ---------------------------------------------------------------------------

// Each form spells the specifier's '@' with an escape, or splits the literal
// with a line continuation right after it.
const ESCAPE_FORMS = [
  ['hex \\x40', '\\x40'],
  ['unicode \\u0040', '\\u0040'],
  ['code point with leading zeros \\u{000040}', '\\u{000040}'],
  ['legacy octal \\100', '\\100'],
  ['identity \\@', '\\@'],
  ['continuation LF', '@\\\n'],
  ['continuation CR', '@\\\r'],
  ['continuation CRLF', '@\\\r\n'],
  ['continuation U+2028', '@\\\u2028'],
  ['continuation U+2029', '@\\\u2029'],
];

function escapeAt(spec, spelling) {
  return spec.replace('@', () => spelling);
}

test('checks 1, 2 and 4 flag specifiers spelled with every escape form', async () => {
  const sdk = await loadSdk();
  const actual = {};
  const expected = {};
  ESCAPE_FORMS.forEach(([form, spelling], i) => {
    const file = `server/src/escape-form-fixture-${i}.ts`;
    actual[form] = {
      barrel: checkBarrelImports(file, `import { canonicalize } from '${escapeAt('@adcp/sdk', spelling)}';\n`, sdk),
      deferred: checkDeferredPackageImports(file, `import { KeyManagementServiceClient } from '${escapeAt('@google-cloud/kms', spelling)}';\n`),
      cjs: checkCommonJsSdkReach(file, `import { createRequire } from 'node:module';\nconst sdk = createRequire(import.meta.url)('${escapeAt('@adcp/sdk', spelling)}');\n`),
    };
    expected[form] = {
      barrel: [`${file}:1: @adcp/sdk barrel import of canonicalize -> @adcp/sdk/utils`],
      deferred: [`${file}:1: static value import of @google-cloud/kms`],
      cjs: [`${file}:2: createRequire(import.meta.url)('@adcp/sdk') loads the CommonJS @adcp/sdk build`],
    };
  });
  assert.deepEqual(actual, expected);
});

test('check 4 flags a createRequire spelled with a unicode escape in the identifier', () => {
  const file = 'server/src/escape-identifier-fixture.ts';
  const source = [
    "import { \\u0063reateRequire } from 'node:module';",
    "import * as nodeModule from 'node:module';",
    "const sdk = \\u0063reateRequire(import.meta.url)('\\x40adcp/sdk');",
    "const testing = nodeModule.\\u{63}reateRequire(import.meta.url)('@adcp/sdk/testing');",
  ].join('\n');
  assert.ok(!source.includes('createRequire'), 'fixture must not spell createRequire plainly');
  assert.deepEqual(checkCommonJsSdkReach(file, source), [
    `${file}:3: \\u0063reateRequire(import.meta.url)('@adcp/sdk') loads the CommonJS @adcp/sdk build`,
    `${file}:4: nodeModule.\\u{63}reateRequire(import.meta.url)('@adcp/sdk/testing') loads the CommonJS @adcp/sdk build`,
  ]);
});
