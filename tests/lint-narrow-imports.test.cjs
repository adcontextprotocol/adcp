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
const test = require('node:test');
const ts = require('typescript');

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

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(?:ts|mts|cts)$/.test(file)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Static declarations that evaluate a module at runtime: value imports,
 * side-effect imports, `import x = require()` and `export ... from`.
 * `names` lists the imported binding names (original names, not aliases),
 * or is null when the whole module namespace is taken (`* as`, `export *`).
 * Side-effect imports have `names: []`. Type-only forms are omitted.
 */
function staticValueImports(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
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
  if (!file.startsWith('server/src/')) return [];
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

// ---------------------------------------------------------------------------
// Repository access
// ---------------------------------------------------------------------------

function trackedCodeFiles() {
  // Directory pathspecs, not 'dir/**/*.ts' globs, so top-level files count.
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', ...SCOPE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f && CODE_FILE.test(f) && !f.endsWith('.d.ts'));
}

function readRepoFile(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** setupFiles of server/vitest.config.ts, repo-relative. */
function serverSetupFiles() {
  const config = readRepoFile('server/vitest.config.ts');
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
// Tree checks
// ---------------------------------------------------------------------------

test('tree: no @adcp/sdk barrel value import whose names all have a narrower subpath', async () => {
  const sdk = await loadSdk();
  const byFile = trackedCodeFiles().map((f) => [f, checkBarrelImports(f, readRepoFile(f), sdk)]);
  const { violations } = applyAllowlist(byFile, BARREL_ALLOWLIST);
  assert.deepEqual(violations, [], report('Import these names from the narrower @adcp/sdk subpath', violations));
});

test('tree: the barrel allowlist is shrink-only (every entry still needs its exemption)', async () => {
  const sdk = await loadSdk();
  const byFile = [...BARREL_ALLOWLIST].map((f) => [f, checkBarrelImports(f, readRepoFile(f) ?? '', sdk)]);
  const { stale } = applyAllowlist(byFile, BARREL_ALLOWLIST);
  assert.deepEqual(stale, [], `Remove these entries from BARREL_ALLOWLIST: ${stale.join(', ')}`);
});

test('tree: server/src has no static value import of the deferred heavy packages', () => {
  const violations = trackedCodeFiles().flatMap((f) => checkDeferredPackageImports(f, readRepoFile(f)));
  assert.deepEqual(violations, [], report('Load these through server/src/utils/deferred-modules.ts or await import()', violations));
});

test('tree: the server unit setup file does not statically load supertest', () => {
  const setupFiles = serverSetupFiles();
  assert.ok(setupFiles.length > 0, 'expected setupFiles in server/vitest.config.ts');
  const violations = checkSetupSupertest(setupFiles, readRepoFile);
  assert.deepEqual(violations, [], report('Load supertest on demand (CONDUCTOR_IS_LOCAL only)', violations));
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
