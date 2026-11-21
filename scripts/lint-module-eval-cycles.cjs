#!/usr/bin/env node
/**
 * Fail if a server/src module, while it is being evaluated, uses a binding
 * imported from a module that is still evaluating.
 *
 * Why this exists: in an import cycle, the module entered first finishes
 * last. Every module in the cycle that it reaches runs its top level before
 * the first module's own top level has run. Vite's SSR transform (the
 * vitest module runner) wraps each export in a getter that swallows the
 * temporal-dead-zone error, so a `const`, `let` or `class` read from a module
 * that is still evaluating returns `undefined` instead of throwing. Production
 * always enters at server/src/index.ts, which hides the bug. A test that
 * imports a module inside the cycle first gets, for example, a tool list with
 * an undefined entry, and every module graph that test leaves cached in a
 * shared worker is broken for the next file.
 *
 * Model: every server/src module is taken in turn as the first entry. The
 * lint walks static imports and `export ... from` in source order, as ESM
 * evaluation does (type-only imports are elided first, as the transform does),
 * and checks each module at the moment its own top level runs. A use at
 * evaluation time (outside any function body that is not called right away)
 * is a violation when:
 *   - it reads a non-function binding (const, let, var, class, enum,
 *     `export default <expression>`) whose defining module is in progress;
 *   - it calls an imported binding (any kind, function declarations included)
 *     whose defining module is in progress, because the callee runs before
 *     its own module has initialised anything it reads;
 *   - the binding is reached through a re-export chain (`export { X } from`,
 *     `export *`, or an imported name exported again) in which any module is
 *     still in progress.
 * Referencing an imported function declaration without calling it is safe:
 * function declarations are initialised before any module body runs.
 * Top-level IIFEs and top-level calls of local functions are followed into
 * their bodies. Class static initialisers, static blocks, computed member
 * names, decorators and `extends` clauses run at evaluation time; method
 * bodies and instance field initialisers do not.
 *
 * Fix a violation by moving the binding to a module with no imports from the
 * cycle (a leaf) and importing it from there. A re-export left in the old
 * module does not help: the importer must import from the leaf directly.
 *
 * Cost: a module's analysis (a TypeScript pass for type elision, then its
 * imports, exports and evaluation-time uses) is most of the run. lint() keeps
 * each module's record in a cache file across processes (openCache) and
 * reuses a record only when every input it was computed from is unchanged:
 * the module's source text, the resolution of every relative specifier it
 * resolved, this script's source and the TypeScript build. The cache lives in
 * ADCP_LINT_CACHE_DIR (default <repo>/node_modules/.cache/adcp-lint); '' turns
 * it off, and CI runs uncached, as the SDK validator cache does.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const { isCi } = require('./sdk-validator-cache.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = 'server/src';
const MODULE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const EXCLUDED = /\.(?:test|spec)\.[cm]?tsx?$|\.d\.ts$/;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '/index.ts', '/index.tsx'];

function unwrap(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
    || ts.isTypeAssertionExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) {
    n = n.expression;
  }
  return n;
}

function hasModifier(node, kind) {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Builds the analyser over a source reader. `read(file)` returns the source of
 * a posix path, or undefined when no such module exists. `cache` is an
 * optional record store (openCache) shared across processes: a module whose
 * stored record still matches its source text and the resolution of every
 * specifier it resolved is not analysed again. `stats` counts the modules
 * analysed and the records reused.
 */
function createAnalyzer(read, { cache } = {}) {
  const modules = new Map();
  const stats = { analysed: 0, reused: 0 };
  // Every resolve() made from `resolving` while it is analysed: spec -> target | null.
  let resolving = null;
  let resolutions = null;

  function resolve(fromFile, spec) {
    if (!spec.startsWith('.')) return null;
    const recording = fromFile === resolving ? resolutions : null;
    if (recording?.has(spec)) return recording.get(spec);
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
    let target = null;
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${suffix === '' ? base : stem}${suffix}`;
      if (MODULE_FILE.test(candidate) && read(candidate) !== undefined) {
        target = candidate;
        break;
      }
    }
    recording?.set(spec, target);
    return target;
  }

  /**
   * One TypeScript pass over a module: its parsed (and bound, so parent-linked)
   * source file, and the module specifiers that survive type elision, in source
   * order. The specifiers are read from the transformed tree, which is then
   * replaced by an empty file so the printer has nothing to emit.
   *
   * transpileModule sets noCheck, so TypeScript marks which import bindings are
   * referenced on the original source file before any transformer runs; import
   * elision reads only those marks. The before-transformer therefore hands the
   * transformers just the import and export declarations: elision is the same,
   * and the rest of the module is not transformed only to be thrown away.
   */
  function parseModule(file, source) {
    let sf;
    const specifiers = [];
    ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true, jsx: ts.JsxEmit.Preserve },
      transformers: {
        before: [() => (original) => {
          sf = original;
          return ts.factory.updateSourceFile(original, original.statements.filter((st) => ts.isImportDeclaration(st) || ts.isExportDeclaration(st)));
        }],
        after: [() => (transformed) => {
          for (const st of transformed.statements) {
            if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) specifiers.push(st.moduleSpecifier.text);
            else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) specifiers.push(st.moduleSpecifier.text);
          }
          return ts.factory.updateSourceFile(transformed, []);
        }],
      },
    });
    return { sf, specifiers };
  }

  /** Runtime import order: resolved specifiers that survive type elision, in source order. */
  function runtimeDeps(file, specifiers) {
    const deps = [];
    for (const spec of specifiers) {
      const target = resolve(file, spec);
      if (target && !deps.includes(target)) deps.push(target);
    }
    return deps;
  }

  /**
   * A module's record: { file, imports, locals, exports, stars, deps, uses }.
   * From the cache when the stored record's source hash matches and every
   * specifier it resolved still resolves to the same target; otherwise
   * analysed, and stored with those inputs.
   */
  function analyzeModule(file) {
    if (modules.has(file)) return modules.get(file);
    const source = read(file);
    const sourceHash = cache && source !== undefined ? sha256(source) : null;
    const stored = sourceHash && cache.get(file);
    if (stored && stored.sourceHash === sourceHash && stored.resolutions.every(([spec, target]) => resolve(file, spec) === target)) {
      stats.reused += 1;
      const mod = {
        file,
        imports: new Map(stored.imports),
        locals: new Map(stored.locals),
        exports: new Map(stored.exports),
        stars: stored.stars,
        deps: stored.deps,
        uses: stored.uses,
      };
      modules.set(file, mod);
      return mod;
    }
    stats.analysed += 1;
    resolving = file;
    resolutions = new Map();
    try {
      const mod = analyzeSource(file, source);
      if (sourceHash) {
        cache.set(file, {
          sourceHash,
          resolutions: [...resolutions],
          imports: [...mod.imports],
          locals: [...mod.locals],
          exports: [...mod.exports],
          stars: mod.stars,
          deps: mod.deps,
          uses: mod.uses,
        });
      }
      return mod;
    } finally {
      resolving = null;
      resolutions = null;
    }
  }

  function analyzeSource(file, source) {
    const { sf, specifiers } = parseModule(file, source);
    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const imports = new Map(); // local -> { file, imported, line }
    const locals = new Map(); // local -> 'function' | 'value'
    const exports = new Map(); // exported -> { local } | { file, imported } | { namespaceOf }
    const stars = [];
    const localFunctions = new Map(); // local function name -> body node, for top-level calls

    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const target = resolve(file, st.moduleSpecifier.text);
        if (!target) continue;
        if (clause.name) imports.set(clause.name.text, { file: target, imported: 'default', line: lineOf(st) });
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, { file: target, imported: '*', line: lineOf(st) });
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (!el.isTypeOnly) imports.set(el.name.text, { file: target, imported: (el.propertyName ?? el.name).text, line: lineOf(st) });
          }
        }
      } else if (ts.isExportDeclaration(st)) {
        if (st.isTypeOnly) continue;
        const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? resolve(file, st.moduleSpecifier.text) : null;
        if (st.moduleSpecifier && !target) continue;
        if (!st.exportClause) {
          stars.push(target);
        } else if (ts.isNamespaceExport(st.exportClause)) {
          exports.set(st.exportClause.name.text, { namespaceOf: target });
        } else {
          for (const el of st.exportClause.elements) {
            if (el.isTypeOnly) continue;
            const local = (el.propertyName ?? el.name).text;
            exports.set(el.name.text, target ? { file: target, imported: local } : { local });
          }
        }
      } else if (ts.isExportAssignment(st)) {
        const expr = unwrap(st.expression);
        exports.set('default', ts.isIdentifier(expr) ? { local: expr.text } : { local: '\0default' });
        if (!ts.isIdentifier(expr)) locals.set('\0default', 'value');
      } else if (ts.isFunctionDeclaration(st)) {
        const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
        const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
        const name = st.name ? st.name.text : '\0default';
        if (st.body) {
          locals.set(name, 'function');
          localFunctions.set(name, st.body);
        }
        if (exported) exports.set(isDefault ? 'default' : name, { local: name });
      } else if (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
        const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
        const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
        const name = st.name ? st.name.text : '\0default';
        if (ts.isEnumDeclaration(st) && hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
        locals.set(name, 'value');
        if (exported) exports.set(isDefault ? 'default' : name, { local: name });
      } else if (ts.isVariableStatement(st)) {
        if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
        const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
        for (const decl of st.declarationList.declarations) {
          for (const name of bindingNames(decl.name)) {
            locals.set(name, 'value');
            if (exported) exports.set(name, { local: name });
          }
          const init = decl.initializer && unwrap(decl.initializer);
          if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            localFunctions.set(decl.name.text, init.body);
          }
        }
      }
    }

    // The tree is needed only to find the uses; the record keeps none of it.
    const uses = evaluationUses({ sf, lineOf, imports, localFunctions });
    const mod = { file, imports, locals, exports, stars, deps: runtimeDeps(file, specifiers), uses };
    modules.set(file, mod);
    return mod;
  }

  function bindingNames(name) {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
  }

  /**
   * Uses of imported bindings while the module's top level runs:
   * [{ local, member, call, line }]. `member` is the property read on a
   * namespace import (`ns.X`), or null.
   */
  function evaluationUses(mod) {
    const { sf, imports, localFunctions, lineOf } = mod;
    const uses = [];
    const followed = new Set();

    const isDeclarationName = (node) => {
      const p = node.parent;
      return ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)
        || ts.isClassDeclaration(p) || ts.isEnumDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)
        || ts.isPropertySignature(p) || ts.isEnumMember(p) || ts.isLabeledStatement(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p))
        && p.name === node)
        || (ts.isBindingElement(p) && p.propertyName === node)
        || (ts.isPropertyAccessExpression(p) && p.name === node)
        || (ts.isPropertyAssignment(p) && p.name === node)
        || (ts.isQualifiedName(p) && p.right === node)
        || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)
        || ts.isBreakOrContinueStatement(p);
    };

    const isCallee = (node) => {
      let n = node;
      while (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent)) n = n.parent;
      const p = n.parent;
      return ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n)
        || (ts.isTaggedTemplateExpression(p) && p.tag === n)
        || (ts.isDecorator(p) && p.expression === n);
    };

    const followBody = (body) => {
      if (!body || followed.has(body)) return;
      followed.add(body);
      visit(body);
    };

    const visitClass = (node) => {
      for (const dec of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) visit(dec);
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const t of clause.types) visit(t.expression);
      }
      for (const member of node.members) {
        for (const dec of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) visit(dec);
        if (member.name && ts.isComputedPropertyName(member.name)) visit(member.name.expression);
        if (ts.isClassStaticBlockDeclaration(member)) visit(member.body);
        else if (ts.isPropertyDeclaration(member) && hasModifier(member, ts.SyntaxKind.StaticKeyword) && member.initializer) visit(member.initializer);
      }
    };

    function visit(node) {
      if (!node) return;
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node)
        || ts.isExportDeclaration(node) || ts.isModuleDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return visitClass(node);
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return;
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        // Default parameter values and the body run only when called.
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = unwrap(node.expression);
        if ((ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) && ts.isCallExpression(node)) {
          followBody(callee.body);
        } else if (ts.isIdentifier(callee) && localFunctions.has(callee.text) && !imports.has(callee.text)) {
          followBody(localFunctions.get(callee.text));
        }
      }
      if (ts.isIdentifier(node) && imports.has(node.text) && !isDeclarationName(node)) {
        const binding = imports.get(node.text);
        const p = node.parent;
        if (binding.imported === '*' && ts.isPropertyAccessExpression(p) && p.expression === node) {
          uses.push({ local: node.text, member: p.name.text, call: isCallee(p), line: lineOf(node) });
        } else if (binding.imported !== '*') {
          uses.push({ local: node.text, member: null, call: isCallee(node), line: lineOf(node) });
        }
      }
      ts.forEachChild(node, visit);
    }

    for (const st of sf.statements) visit(st);
    return uses;
  }

  const bindingCache = new Map();

  /**
   * Resolves an exported name to its defining module:
   * { definer, kind: 'function' | 'value', chain: [module, ...] } where chain
   * lists every module the lookup passed through, ending at the definer.
   * Null when the name is not found in relative modules.
   */
  function resolveBinding(file, name, seen = new Set()) {
    const key = `${file}\0${name}`;
    if (bindingCache.has(key)) return bindingCache.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = analyzeModule(file);
    let result = null;
    const entry = mod.exports.get(name);
    if (entry && 'namespaceOf' in entry) {
      result = { definer: file, kind: 'value', chain: [file] };
    } else if (entry && 'file' in entry) {
      const inner = resolveBinding(entry.file, entry.imported, seen);
      result = inner && { ...inner, chain: [file, ...inner.chain] };
    } else if (entry) {
      const imported = mod.imports.get(entry.local);
      if (imported && imported.imported !== '*') {
        const inner = resolveBinding(imported.file, imported.imported, seen);
        result = inner && { ...inner, chain: [file, ...inner.chain] };
      } else if (imported) {
        result = { definer: file, kind: 'value', chain: [file] };
      } else {
        result = { definer: file, kind: mod.locals.get(entry.local) === 'function' ? 'function' : 'value', chain: [file] };
      }
    } else if (name !== 'default') {
      for (const star of mod.stars) {
        const inner = resolveBinding(star, name, seen);
        if (inner) {
          result = { ...inner, chain: [file, ...inner.chain] };
          break;
        }
      }
    }
    bindingCache.set(key, result);
    return result;
  }

  /** Violations found while this module's top level runs, given the modules in progress. */
  function checkModule(mod, inProgress) {
    const found = [];
    for (const use of mod.uses) {
      const binding = mod.imports.get(use.local);
      const name = use.member ?? binding.imported;
      const resolved = resolveBinding(binding.file, name);
      if (!resolved) continue;
      const pending = resolved.chain.filter((f) => inProgress.has(f) && f !== mod.file);
      if (pending.length === 0) continue;
      const throughPendingBarrel = pending.some((f) => f !== resolved.definer);
      if (!use.call && resolved.kind === 'function' && !throughPendingBarrel) continue;
      found.push({
        importer: mod.file,
        importLine: binding.line,
        useLine: use.line,
        name,
        verb: use.call ? 'calls' : 'reads',
        definer: resolved.definer,
        via: resolved.chain.slice(0, -1),
        pending,
      });
    }
    return found;
  }

  /** Simulates evaluation with `entry` imported first; returns violations in evaluation order. */
  function evaluate(entry) {
    const state = new Map();
    const inProgress = new Set();
    const found = [];
    const visitModule = (file) => {
      state.set(file, 'in');
      inProgress.add(file);
      const mod = analyzeModule(file);
      for (const dep of mod.deps) if (!state.has(dep)) visitModule(dep);
      found.push(...checkModule(mod, inProgress));
      inProgress.delete(file);
      state.set(file, 'done');
    };
    visitModule(entry);
    return found;
  }

  return { analyzeModule, evaluate, resolveBinding, stats };
}

/**
 * A record store backed by one JSON file: { version, records: { file: record } }.
 * Records saved under another `version` are ignored. save() writes the loaded
 * records (minus those `keep(file)` rejects) and the new ones together, through
 * a temp file renamed into place, so concurrent writers never leave a torn
 * file. A failed write leaves the lint result unchanged and only warns.
 */
function openCache({ file, version }) {
  let loaded = {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.version === version && data.records && typeof data.records === 'object') loaded = data.records;
  } catch {
    // No cache yet, or an unreadable one: start empty.
  }
  const added = new Map();
  return {
    get(f) {
      return added.get(f) ?? (Object.hasOwn(loaded, f) ? loaded[f] : undefined);
    },
    set(f, record) {
      added.set(f, record);
    },
    save({ keep = () => true } = {}) {
      if (added.size === 0) return;
      const records = {};
      for (const [f, record] of Object.entries(loaded)) if (!added.has(f) && keep(f)) records[f] = record;
      for (const [f, record] of added) records[f] = record;
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ version, records }));
        fs.renameSync(tmp, file);
        loaded = records;
        added.clear();
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        process.emitWarning(`lint-module-eval-cycles: cache not saved to ${file}: ${err.message}`);
      }
    },
  };
}

// Records depend on this script's code and on the TypeScript build that did
// the elision pass: every file whose module exports this `ts` object (the
// typescript package may be a shim that re-exports another one).
const CACHE_FORMAT = 1;
function cacheVersion() {
  const tsFiles = Object.values(require.cache)
    .filter((m) => m && m.exports === ts)
    .map((m) => fs.realpathSync(m.filename))
    .sort();
  return sha256(JSON.stringify([CACHE_FORMAT, ts.version, tsFiles, fs.readFileSync(__filename, 'utf8')]));
}

/** The repository reader's store, or null when ADCP_LINT_CACHE_DIR is '' or CI runs. */
let defaultCache;
function repoCache() {
  if (defaultCache !== undefined) return defaultCache;
  const dir = process.env.ADCP_LINT_CACHE_DIR;
  if (dir === '' || (dir === undefined && isCi(process.env))) {
    defaultCache = null;
  } else {
    const root = dir ?? path.join(ROOT, 'node_modules', '.cache', 'adcp-lint');
    defaultCache = openCache({ file: path.join(root, 'module-eval-cycles.json'), version: cacheVersion() });
  }
  return defaultCache;
}

function holeKey(h) {
  return `${h.importer}:${h.importLine} ${h.verb} ${h.name} from in-progress ${h.definer}`;
}

/**
 * Every distinct violation over the given entries:
 * [{ importer, importLine, useLine, name, verb, definer, via, pending, entries }],
 * where `entries` lists the first entries that trigger it.
 */
// One analyser per reader: a module is parsed and analysed once per process,
// however many scans (entry sets) read it through the same reader.
// The first scan through a reader picks the analyser's record store.
const analyzers = new WeakMap();
function analyzerFor(read, cache) {
  if (!analyzers.has(read)) analyzers.set(read, createAnalyzer(read, { cache }));
  return analyzers.get(read);
}

function scan({ entries, read, cache }) {
  const analyzer = analyzerFor(read, cache);
  const byKey = new Map();
  for (const entry of entries) {
    for (const hole of analyzer.evaluate(entry)) {
      const key = holeKey(hole);
      if (!byKey.has(key)) byKey.set(key, { ...hole, entries: [] });
      const agg = byKey.get(key);
      if (!agg.entries.includes(entry)) agg.entries.push(entry);
    }
  }
  return [...byKey.values()].sort((a, b) => holeKey(a).localeCompare(holeKey(b)));
}

function* walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(rel);
    else yield rel;
  }
}

/** Repo-relative modules in scope (each one is taken as the first entry). */
function scopeFiles() {
  return [...walk(SRC_ROOT)].filter((f) => MODULE_FILE.test(f) && !EXCLUDED.test(f)).sort();
}

const sourceCache = new Map();
function readRepoFile(file) {
  if (sourceCache.has(file)) return sourceCache.get(file);
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
 * Violations over `entries` (default: every module in scope). With the
 * repository reader and no `cache` given, records come from and go back to
 * the repository store (repoCache); a caller that passes `cache` saves it.
 */
function lint({ entries = scopeFiles(), read = readRepoFile, cache } = {}) {
  const store = cache === undefined && read === readRepoFile ? repoCache() : cache;
  const violations = scan({ entries, read, cache: store ?? undefined });
  if (store && cache === undefined) store.save({ keep: (f) => readRepoFile(f) !== undefined });
  return violations;
}

function formatViolation(h) {
  const via = h.via.length ? ` via ${h.via.join(' -> ')}` : '';
  return `${holeKey(h)}${via} (used at line ${h.useLine}; in progress: ${h.pending.join(', ')}; ` +
    `when ${h.entries.length} module(s) are imported first, e.g. ${h.entries.slice(0, 3).join(', ')}). ` +
    'Move the binding to a leaf module and import it from there.';
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-module-eval-cycles: ok (no violations)');
    process.exit(0);
  }
  console.error(`lint-module-eval-cycles: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`${formatViolation(v)}\n`);
  process.exit(1);
}

module.exports = { createAnalyzer, formatViolation, holeKey, lint, openCache, scan, scopeFiles };
