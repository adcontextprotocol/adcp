// Extension-module codegen, shared by scripts/codegen.mjs (packages in this repo)
// and scripts/adcp-sdk.mjs (extensions pulled by uri@digest into an app).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import ts from 'typescript';
import { toSafeString } from 'json-schema-to-typescript/dist/src/utils.js';
import { CORE_ORIGIN, coreIdFromUri, loadCoreSchemas } from '../lib/core-schemas.mjs';

export const JSTS_OPTIONS = { unreachableDefinitions: true, additionalProperties: true, strictIndexSignatures: false, maxItems: -1 };
export const stripRoot = (ts, name) => ts.replace(new RegExp(`export interface ${name} \\{[^}]*\\}\\n*`), '');
export const pascal = (s) => s.replace(/(^|[-_])([a-z])/g, (_, __, c) => c.toUpperCase());
const camel = (s) => s.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());

export function mapRefs(node, fn) {
  if (Array.isArray(node)) return node.map((v) => mapRefs(v, fn));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const replaced = fn(node.$ref, node);
    if (replaced) return replaced;
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapRefs(v, fn)]));
}

/**
 * { hook: how to reach it } from core's hook annotations:
 *   extension point -> { kind: 'extension-point', container, identity }   (property that carries the data)
 *   union           -> { kind: 'union', discriminator, body, identity, must_understand, branch_requires }
 *                      (open-union host object; identity enclosing: the declaration names the extension)
 */
export function hookInfo(schemas = loadCoreSchemas()) {
  const out = {};
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const union = n['x-adcp-open-union'];
    if (union) {
      out[union.name] = {
        kind: 'union',
        discriminator: union.discriminator,
        body: union.body,
        identity: union.identity ?? 'entry',
        must_understand: union.must_understand ?? 'always',
        branch_requires: union.branch_requires ?? [],
      };
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const [prop, sch] of Object.entries(v)) {
          const point = sch?.['x-adcp-extension-point'];
          if (point) out[point.name] = { kind: 'extension-point', container: prop, identity: point.identity ?? 'entry' };
        }
      }
      walk(v);
    }
  };
  schemas.forEach((s) => walk(s.schema));
  return out;
}

/**
 * TypeScript for one extension bundle: its types (core refs become imports from @adcp/core),
 * literal uri/digest constants, and per registration:
 *   extension point  a typed entry alias, and the runtime binding's reader (this exact uri@digest) and writer;
 *   open-union branch the branch id, a typed branch, and the runtime binding's reader and writer;
 *   task (a branch of an enclosing-identity union with a response definition)
 *                    the task id and a typed descriptor in `tasks`.
 * An app's generated layer (scripts/generated-binding.mjs) imports these types and turns each hook into a
 * plain attribute and each task into a client method and a handler. The readers and writers are the
 * runtime binding, for a runtime plug-in that enables the extension at run time (and the mock sellers).
 */
export async function generateExtensionTs({ bundle, lock, coreTypeName, hooks, coreImport = '@adcp/core' }) {
  const manifest = bundle['x-adcp-extension'];
  const imports = new Set(['ExtensionEntry']);
  const defs = mapRefs(bundle.definitions, (ref, n) => {
    if (!ref.startsWith(CORE_ORIGIN)) return null;
    const { $ref, ...rest } = n;
    const name = coreTypeName(coreIdFromUri(ref));
    imports.add(name);
    return { ...rest, tsType: name };
  });
  const rootName = `${pascal(manifest.name)}Types`;
  const body = stripRoot(
    await compile({ title: rootName, type: 'object', additionalProperties: false, definitions: defs }, rootName, {
      ...JSTS_OPTIONS,
      bannerComment: '',
    }),
    rootName
  );
  const typeName = (def) => toSafeString(defs[def].title ?? def);
  const typeOf = (e) => typeName(e.definition);
  const ext = pascal(manifest.name);
  const typedEntry = (t, pad = '') =>
    `Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {\n${pad}  uri: typeof EXTENSION_URI;\n${pad}  digest: typeof EXTENSION_DIGEST;\n${pad}  data: ${t};\n${pad}}`;
  const tasks = [];
  const perPoint = manifest.extends
    .map((e) => {
      const hook = hooks[e.point];
      if (!hook) throw new Error(`${manifest.name}: core declares no hook ${e.point}`);
      if (e.branch) {
        if (hook.kind !== 'union') throw new Error(`${manifest.name}: ${e.point} is not an open union; it cannot take branch ${e.branch}`);
        const BRANCH = e.branch.toUpperCase();
        if (hook.identity === 'enclosing') {
          // A branch the enclosing declaration identifies. With a response definition it is a task.
          if (!e.response) throw new Error(`${manifest.name}: ${e.point}#${e.branch} has no response definition`);
          imports.add('ContributedTask');
          tasks.push({ e, BRANCH });
          return [
            `/** Task id of \`${e.branch}\`: a branch of the ${e.point} union (no digest). Seller capabilities map a transport name to it. */`,
            `export const ${BRANCH} = ${JSON.stringify(`${lock.uri}#${e.branch}`)} as const;`,
          ].join('\n');
        }
        const { discriminator: d, body: b } = hook;
        return [
          `/** Branch id of ${e.point} branch \`${e.branch}\`: the discriminator value (no digest). */`,
          `export const ${BRANCH} = ${JSON.stringify(`${lock.uri}#${e.branch}`)} as const;`,
          '',
          `/** ${e.point} branch \`${e.branch}\` on a host object (must-understand). */`,
          `export type ${ext}${pascal(e.branch)}Branch = {\n  ${d}: typeof ${BRANCH};\n  ${b}: ${typedEntry(typeOf(e), '  ')};\n};`,
          '',
          `/** Runtime binding: this branch's data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */`,
          `export function read${pascal(e.branch)}(on: { ${d}?: string; ${b}?: ExtensionEntry | null } | null | undefined): ${typeOf(e)} | undefined {`,
          `  const t = on?.${d} === ${BRANCH} ? on.${b} : undefined;`,
          `  return t && t.uri === EXTENSION_URI && t.digest === EXTENSION_DIGEST ? (t.data as ${typeOf(e)}) : undefined;`,
          `}`,
          '',
          `/** Runtime binding: build the branch's discriminator and body (seller side). */`,
          `export function ${camel(e.branch)}Branch(data: ${typeOf(e)}): ${ext}${pascal(e.branch)}Branch {`,
          `  return { ${d}: ${BRANCH}, ${b}: { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data } };`,
          `}`,
        ].join('\n');
      }
      if (hook.kind !== 'extension-point') throw new Error(`${manifest.name}: ${e.point} is an open union; register a branch`);
      const container = hook.container;
      if (hook.identity === 'enclosing') {
        return [
          `/** ${e.point}: this extension's fragment in a declaration (must_understand: ${e.must_understand}). */`,
          `export function read${pascal(camel(e.point))}(on: { uri: string; digest: string; ${container}?: object } | null | undefined): ${typeOf(e)} | undefined {`,
          `  return on && on.uri === EXTENSION_URI && on.digest === EXTENSION_DIGEST ? (on.${container} as ${typeOf(e)} | undefined) : undefined;`,
          `}`,
          '',
          `/** Type-check this extension's ${e.point} fragment (seller side); pass it to server.declare(module, { ${container} }). */`,
          `export function ${camel(e.point)}Fragment(data: ${typeOf(e)}): ${typeOf(e)} {`,
          `  return data;`,
          `}`,
        ].join('\n');
      }
      return [
        `/** ${e.point}.${container}[] entry (must_understand: ${e.must_understand}). */`,
        `export type ${ext}${pascal(e.point)}Entry = ${typedEntry(typeOf(e))};`,
        '',
        `/** Runtime binding: this extension's ${e.point} data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */`,
        `export function read${pascal(camel(e.point))}(on: { ${container}?: ExtensionEntry[] | null } | null | undefined): ${typeOf(e)} | undefined {`,
        `  const t = on?.${container}?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);`,
        `  return t ? (t.data as ${typeOf(e)}) : undefined;`,
        `}`,
        '',
        `/** Runtime binding: build a ${e.point} entry for this extension (seller side). */`,
        `export function ${camel(e.point)}Entry(data: ${typeOf(e)}): ${ext}${pascal(e.point)}Entry {`,
        `  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };`,
        `}`,
      ].join('\n');
    })
    .join('\n\n');
  const taskBlock = tasks.length
    ? [
        '',
        `/**`,
        ` * Tasks this extension contributes. An app's generated layer turns each into a typed client method`,
        ` * (client.<task>(request)) and a typed handler (server.handle('<task>', handler)). Runtime binding:`,
        ` * client.ext(module).<task>(request) and server.handle(module.tasks.<task>, handler).`,
        ` */`,
        `export const tasks = {`,
        ...tasks.flatMap(({ e, BRANCH }) => [
          ...(e.semantics ? [`  /** ${e.semantics} */`] : []),
          `  ${camel(e.branch)}: {`,
          `    id: ${BRANCH},`,
          `    uri: EXTENSION_URI,`,
          `    digest: EXTENSION_DIGEST,`,
          `    branch: ${JSON.stringify(e.branch)},`,
          `    request: ${JSON.stringify(e.definition)},`,
          `    response: ${JSON.stringify(e.response)},`,
          `  } as ContributedTask<${typeOf(e)}, ${typeName(e.response)}>,`,
        ]),
        `};`,
      ].join('\n')
    : '';
  return [
    `/* Generated from ${lock.uri}@${lock.digest} (v${lock.version}). Do not edit. */`,
    `import type { ${[...imports].sort().join(', ')} } from '${coreImport}';`,
    '',
    `export const EXTENSION_URI = ${JSON.stringify(lock.uri)} as const;`,
    `export const EXTENSION_DIGEST = ${JSON.stringify(lock.digest)} as const;`,
    `export const EXTENSION_VERSION = ${JSON.stringify(lock.version)} as const;`,
    `export const EXTENSION = { name: ${JSON.stringify(manifest.name)}, uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION } as const;`,
    `/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */`,
    `export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);`,
    '',
    perPoint,
    taskBlock,
    '',
    body.trim(),
    '',
  ].join('\n');
}

/** JavaScript for a generated module (types erased), so plain-JS sellers and tools can import it. */
export function transpileExtensionTs(source) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } }).outputText;
}

export { toSafeString };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** core $id -> the type name @adcp/core exports for it (reads the generated core package). */
export function coreTypeNameFromCore() {
  const core = new Map(loadCoreSchemas().map((s) => [s.id, s.schema]));
  const ts = readFileSync(path.join(ROOT, 'packages/core/src/index.ts'), 'utf8');
  const exported = new Set([...ts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]));
  return (id) => {
    const name = toSafeString(core.get(id)?.title ?? id);
    if (!exported.has(name)) throw new Error(`core type for ${id} (${name}) is not exported by @adcp/core`);
    return name;
  };
}
