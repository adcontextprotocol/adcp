import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonSchema = Record<string, unknown>;

const schemaRoot = join(process.cwd(), 'static/schemas/source');
const parsedSchemas = new Map<string, JsonSchema>();
const definitionAnnotationKeys = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'discriminator',
  'example',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

function readSchema(relativePath: string): JsonSchema {
  const cached = parsedSchemas.get(relativePath);
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(join(schemaRoot, relativePath), 'utf8')) as JsonSchema;
  parsedSchemas.set(relativePath, parsed);
  return parsed;
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function keepDefinitionKey(key: string): boolean {
  return key !== '$id'
    && key !== '$schema'
    && !key.startsWith('x-')
    && !definitionAnnotationKeys.has(key);
}

/** Build one self-contained schema without duplicating referenced schemas or
 * their absolute $ids. External AdCP refs become local refs into a shared
 * $defs map; refs local to a referenced document stay scoped to that entry. */
function bundleSchema(root: JsonSchema): JsonSchema {
  const definitions = new Map<string, JsonSchema>();

  function definitionRef(relativePath: string, fragment = ''): string {
    return `#/$defs/${pointerSegment(relativePath)}${fragment}`;
  }

  function ensureDefinition(relativePath: string): void {
    if (definitions.has(relativePath)) return;

    // Reserve the entry before descending so recursive schema graphs terminate.
    definitions.set(relativePath, {});
    definitions.set(relativePath, rewrite(readSchema(relativePath), relativePath) as JsonSchema);
  }

  function rewrite(value: unknown, definitionPath?: string): unknown {
    if (Array.isArray(value)) return value.map(entry => rewrite(entry, definitionPath));
    if (!value || typeof value !== 'object') return value;

    const record = value as JsonSchema;
    const ref = record.$ref;
    if (typeof ref === 'string') {
      let rewrittenRef = ref;
      if (ref.startsWith('/schemas/')) {
        const external = ref.slice('/schemas/'.length);
        const hashIndex = external.indexOf('#');
        const relativePath = hashIndex === -1 ? external : external.slice(0, hashIndex);
        const fragment = hashIndex === -1 ? '' : external.slice(hashIndex + 1);
        if (fragment && !fragment.startsWith('/')) {
          throw new Error(`Unsupported non-pointer schema fragment: ${ref}`);
        }
        ensureDefinition(relativePath);
        rewrittenRef = definitionRef(relativePath, fragment);
      } else if (definitionPath && ref.startsWith('#')) {
        const fragment = ref.slice(1);
        if (fragment && !fragment.startsWith('/')) {
          throw new Error(`Unsupported non-pointer local schema fragment: ${ref}`);
        }
        rewrittenRef = definitionRef(definitionPath, fragment);
      }

      const siblings = Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== '$ref' && (!definitionPath || keepDefinitionKey(key)))
          .map(([key, entry]) => [key, rewrite(entry, definitionPath)]),
      );
      if (Object.keys(siblings).length === 0) return { $ref: rewrittenRef };

      // Draft-07 ignores $ref siblings, so preserve their constraints via allOf.
      return { allOf: [{ $ref: rewrittenRef }, siblings] };
    }

    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !definitionPath || keepDefinitionKey(key))
        .map(([key, entry]) => [key, rewrite(entry, definitionPath)]),
    );
  }

  const bundled = rewrite(root) as JsonSchema;
  if (definitions.size > 0) {
    bundled.$defs = {
      ...((bundled.$defs as JsonSchema | undefined) ?? {}),
      ...Object.fromEntries(definitions),
    };
  }
  return bundled;
}

/** Load the normative source request schema and bundle every repository-local
 * reference for MCP tools/list consumers, which cannot resolve AdCP paths. */
export function loadProductDiscoveryInputSchema(fileName: string): JsonSchema {
  return bundleSchema(readSchema(`media-buy/${fileName}.json`));
}
