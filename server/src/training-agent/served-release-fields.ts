import { getSchemaDocumentByRef } from '@adcp/sdk/schemas';
import { sourceSchemaDocument } from './source-schema.js';

/**
 * Fields a response must not carry because the source schemas mark them as
 * added after the release it is served at.
 *
 * versioning.mdx ("Server shapes to the served release"): a response echoing
 * release R validates against R's schema, and the seller omits what R does
 * not define. A field added in 3.3 breaks a 3.2 consumer outright when 3.2
 * closes the object (`core/canonical-product.json` and `installments`, #8487)
 * and is still a claim 3.2 never defined when the object is open (a 3.2
 * `media_buy.features` map accepts any boolean).
 *
 * `x-added-in` is the machine-readable "new in this release" marker the
 * schemas carry for SDK generators (tests/x-added-in-3-3-sweep.test.cjs pins
 * it on the 3.3 additions). Reading it from the source schema keeps this gate
 * in step with the fields a later release adds, with no hand-kept list.
 *
 * The walk follows the source schema alongside the value. Composition
 * (`allOf`/`oneOf`/`anyOf`, `if`/`then`/`else`) is walked as a union: a
 * property is withheld only when every declaration of it the walk reaches is
 * newer than the served release, so a name some branch already had in that
 * release is always kept. Undeclared keys under an open object, `ext` and
 * `context` included, are left alone.
 *
 * The marker describes the declaration, not always the wire: a release can
 * require a key it never declared (3.2 `validate_input` warnings require an
 * undeclared `field`, which 3.3 declares with `x-added-in`). Gate a response
 * only where the served release's own bundle agrees;
 * tenants/served-release-shape.test.ts grades each gated response against it.
 */

type Schema = Readonly<Record<string, unknown>>;

interface Located {
  node: Schema;
  file: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointerTarget(document: Schema, fragment: string): unknown {
  if (!fragment) return document;
  return fragment.slice(1).split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((node, segment) => (isRecord(node) ? node[segment] : undefined), document);
}

/** Follow a `$ref` chain to the schema node it names. */
function dereference(node: unknown, file: string, seen = new Set<string>()): Located | undefined {
  if (!isRecord(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref !== 'string') return { node, file };
  const hash = ref.indexOf('#');
  const target = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  const targetFile = target ? target.replace(/^\/schemas\//, '') : file;
  const key = `${targetFile}#${fragment}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  return dereference(pointerTarget(sourceSchemaDocument(targetFile), fragment), targetFile, seen);
}

const alternativesCache = new WeakMap<object, Map<string, Located[]>>();

/** Every schema a value at this node may satisfy, composition flattened. */
function alternatives(node: unknown, file: string): Located[] {
  if (!isRecord(node)) return [];
  let byFile = alternativesCache.get(node);
  const cached = byFile?.get(file);
  if (cached) return cached;
  const out: Located[] = [];
  const visited = new Set<object>();
  const visit = (candidate: unknown, candidateFile: string) => {
    const located = dereference(candidate, candidateFile);
    if (!located || visited.has(located.node)) return;
    visited.add(located.node);
    out.push(located);
    for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
      const branches = located.node[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, located.file);
    }
    for (const keyword of ['then', 'else'] as const) {
      if (located.node[keyword] !== undefined) visit(located.node[keyword], located.file);
    }
  };
  visit(node, file);
  if (!byFile) {
    byFile = new Map();
    alternativesCache.set(node, byFile);
  }
  byFile.set(file, out);
  return out;
}

function releaseLine(version: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function addedAfter(addedIn: unknown, servedLine: [number, number]): boolean {
  if (typeof addedIn !== 'string') return false;
  const added = releaseLine(addedIn);
  if (!added) return false;
  return added[0] > servedLine[0] || (added[0] === servedLine[0] && added[1] > servedLine[1]);
}

/** A property declaration is newer when it, or the whole schema file it
 * points at (`"hold_policy": { "$ref": "/schemas/core/hold-policy.json" }`),
 * carries a newer `x-added-in`. */
function declaredAfter(declaration: Located, servedLine: [number, number]): boolean {
  if (addedAfter(declaration.node['x-added-in'], servedLine)) return true;
  const target = dereference(declaration.node, declaration.file);
  return target !== undefined && addedAfter(target.node['x-added-in'], servedLine);
}

/** Union of the alternatives of several schemas, each node once. Shared
 * `$ref` targets would otherwise repeat once per branch and compound at every
 * level of a deep value. */
function alternativesOf(schemas: readonly Located[]): Located[] {
  const seen = new Set<object>();
  const out: Located[] = [];
  for (const { node, file } of schemas) {
    for (const located of alternatives(node, file)) {
      if (seen.has(located.node)) continue;
      seen.add(located.node);
      out.push(located);
    }
  }
  return out;
}

function collect(
  value: unknown,
  schemas: readonly Located[],
  servedLine: [number, number],
  path: string[],
  found: string[][],
): void {
  if (schemas.length === 0) return;
  if (Array.isArray(value)) {
    const items = alternativesOf(schemas
      .filter(({ node }) => node.items !== undefined)
      .map(({ node, file }) => ({ node: node.items as Schema, file })));
    value.forEach((item, index) => collect(item, items, servedLine, [...path, String(index)], found));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const declarations: Located[] = [];
    for (const { node, file } of schemas) {
      const properties = node.properties;
      if (isRecord(properties) && properties[key] !== undefined) {
        declarations.push({ node: properties[key] as Schema, file });
      } else if (isRecord(node.additionalProperties)) {
        declarations.push({ node: node.additionalProperties, file });
      }
    }
    if (declarations.length === 0) continue;
    const current = declarations.filter(declaration => !declaredAfter(declaration, servedLine));
    if (current.length === 0) {
      found.push([...path, key]);
      continue;
    }
    collect(child, alternativesOf(current), servedLine, [...path, key], found);
  }
}

function fieldPaths(value: unknown, schemaFile: string, servedVersion: string): string[][] {
  const servedLine = releaseLine(servedVersion);
  if (!servedLine) return [];
  const found: string[][] = [];
  collect(value, alternatives(sourceSchemaDocument(schemaFile), schemaFile), servedLine, [], found);
  return found;
}

/**
 * Top-level properties of `schemaFile` that are added after
 * `servedVersion`'s release line, e.g. `installments` on
 * `core/canonical-product.json` for a 3.2 response.
 */
const addedProperties = new Map<string, ReadonlySet<string>>();

export function propertiesAddedAfterRelease(schemaFile: string, servedVersion: string): ReadonlySet<string> {
  const servedLine = releaseLine(servedVersion);
  if (!servedLine) return new Set();
  const key = `${schemaFile}\0${servedLine.join('.')}`;
  const cached = addedProperties.get(key);
  if (cached) return cached;
  const declarations = new Map<string, Located[]>();
  for (const { node, file } of alternatives(sourceSchemaDocument(schemaFile), schemaFile)) {
    if (!isRecord(node.properties)) continue;
    for (const [name, declaration] of Object.entries(node.properties)) {
      declarations.set(name, [...(declarations.get(name) ?? []), { node: declaration as Schema, file }]);
    }
  }
  const added = new Set([...declarations]
    .filter(([, located]) => located.every(declaration => declaredAfter(declaration, servedLine)))
    .map(([name]) => name));
  addedProperties.set(key, added);
  return added;
}

/**
 * JSON pointers of the fields in `value` that `schemaFile` (relative to
 * static/schemas/source, e.g. `core/canonical-product.json`) marks as added
 * after `servedVersion`'s release line.
 */
export function fieldsAddedAfterRelease(value: unknown, schemaFile: string, servedVersion: string): string[] {
  return fieldPaths(value, schemaFile, servedVersion)
    .map(path => `/${path.map(segment => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`);
}

/**
 * `value` without the fields `schemaFile` marks as added after
 * `servedVersion`'s release line. Returns `value` itself when nothing is
 * withheld, otherwise a copy; the input is never mutated.
 */
export function omitFieldsAddedAfterRelease<T>(value: T, schemaFile: string, servedVersion: string): T {
  const paths = fieldPaths(value, schemaFile, servedVersion);
  if (paths.length === 0) return value;
  const copy = structuredClone(value);
  for (const path of paths) {
    const parent = path.slice(0, -1).reduce<unknown>(
      (node, segment) => (isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[segment] : undefined),
      copy,
    );
    if (isRecord(parent)) delete parent[path[path.length - 1]];
  }
  return copy;
}

const servedEnums = new Map<string, ReadonlySet<string> | null>();

function enumValues(schemaRef: string, version: string): unknown {
  return (getSchemaDocumentByRef(schemaRef, version)?.schema as { enum?: unknown } | undefined)?.enum;
}

/**
 * Values the served release's own enum schema (`enums/specialism.json`)
 * allows. Unlike a field, an enum value carries no `x-added-in`, so the
 * served bundle is the source. A prerelease pin whose bundle the SDK does not
 * ship (`3.1-rc.15`, `3.2-rc.0`) is read from its release line's bundle, which
 * still rejects every value a later line adds. Null only when neither bundle
 * is available, in which case callers leave their list as is (the
 * compliance-scenarios precedent).
 */
export function servedReleaseEnum(schemaRef: string, servedVersion: string): ReadonlySet<string> | null {
  const key = `${servedVersion}\0${schemaRef}`;
  const cached = servedEnums.get(key);
  if (cached !== undefined) return cached;
  let values: unknown;
  try {
    values = enumValues(schemaRef, servedVersion);
  } catch {
    const line = /^(\d+\.\d+)-/.exec(servedVersion)?.[1];
    try {
      if (!line) return null;
      values = enumValues(schemaRef, line);
    } catch {
      // Retry on the next call: the bundle may be registered later.
      return null;
    }
  }
  const allowed = Array.isArray(values)
    ? new Set(values.filter((value): value is string => typeof value === 'string'))
    : null;
  servedEnums.set(key, allowed);
  return allowed;
}
