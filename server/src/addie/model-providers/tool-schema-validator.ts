import { types } from 'node:util';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { isJsonData } from './capabilities.js';

/**
 * Compiled tool input-schema validators shared across registrations.
 *
 * A validator depends only on its schema and the Ajv options, so evaluation
 * code that registers the same tool catalog for every trace, arm, preflight
 * and identity check can compile each schema once per process instead of
 * building a new Ajv instance (and recompiling the draft meta-schema) every
 * time.
 *
 * Only schemas without JSON Schema identity take this path: no $id, anchor or
 * reference outside the schema itself. Such a schema can neither collide with
 * nor resolve against another schema, so a shared instance validates it
 * exactly as a fresh per-registration instance does. A registration that has
 * any other schema keeps its own fresh Ajv instance (see
 * isCacheableToolRegistration).
 */

/** Closed set of Ajv configurations; the profile is part of every cache key. */
export type ToolSchemaValidatorProfile = 'tool_loop' | 'corpus_contract';

// Bound on retained validators. At the bound the cache stops inserting
// (nothing is evicted), and each further miss compiles in a fresh instance so
// the shared instances stop growing too.
const MAX_CACHED_VALIDATORS = 1024;
const IDENTITY_KEYWORDS = new Set(['$id', '$anchor', '$dynamicAnchor', '$recursiveAnchor']);
const REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

let validators = new Map<string, ValidateFunction>();
let sharedInstances = new Map<ToolSchemaValidatorProfile, Ajv>();
let lookups = 0;
let compiles = 0;

/** A fresh Ajv instance with the profile's options. */
export function newToolSchemaAjv(profile: ToolSchemaValidatorProfile): Ajv {
  if (profile === 'tool_loop') return new Ajv({ allErrors: false, strict: false });
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function hasSchemaIdentity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some(hasSchemaIdentity);
  for (const [key, nested] of Object.entries(value)) {
    if (IDENTITY_KEYWORDS.has(key)) return true;
    if (REFERENCE_KEYWORDS.has(key) && !(typeof nested === 'string' && nested.startsWith('#'))) return true;
    if (hasSchemaIdentity(nested)) return true;
  }
  return false;
}

function ownDataValue(target: unknown, key: string): { value: unknown } | undefined {
  if (typeof target !== 'object' || target === null || types.isProxy(target)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? { value: descriptor.value } : undefined;
}

/**
 * True when every definition's `schemaKey` schema may use the shared cache:
 * reachable through own data properties only (no getter or trap runs), plain
 * JSON data, and free of schema identity. A conservative false (for example a
 * property merely named "$id") only keeps today's per-registration path.
 */
export function isCacheableToolRegistration(
  definitions: readonly unknown[],
  schemaKey: string,
): boolean {
  if (!Array.isArray(definitions) || types.isProxy(definitions)) return false;
  const length = ownDataValue(definitions, 'length')?.value;
  if (typeof length !== 'number') return false;
  for (let index = 0; index < length; index++) {
    const definition = ownDataValue(definitions, String(index));
    const schema = definition && ownDataValue(definition.value, schemaKey);
    if (!schema || !isJsonData(schema.value) || hasSchemaIdentity(schema.value)) return false;
  }
  return true;
}

/**
 * The compiled validator for a schema that passed isCacheableToolRegistration.
 * The key is the schema's JSON text, which for plain JSON data determines Ajv's
 * behavior. Ajv compiles a private copy, so later changes to the caller's
 * object cannot reach the cached validator. A failed compile throws and
 * caches nothing, so an invalid schema fails on every call.
 */
export function compileToolInputSchema(
  schema: unknown,
  profile: ToolSchemaValidatorProfile,
): ValidateFunction {
  lookups++;
  const key = `${profile}\n${JSON.stringify(schema)}`;
  const cached = validators.get(key);
  if (cached) return cached;
  const full = validators.size >= MAX_CACHED_VALIDATORS;
  let ajv = full ? undefined : sharedInstances.get(profile);
  if (!ajv) {
    ajv = newToolSchemaAjv(profile);
    if (!full) sharedInstances.set(profile, ajv);
  }
  const validate = ajv.compile(structuredClone(schema) as object);
  compiles++;
  if (!full) validators.set(key, validate);
  return validate;
}

export function resetToolSchemaValidatorCacheForTests(): void {
  validators = new Map();
  sharedInstances = new Map();
  lookups = 0;
  compiles = 0;
}

export function toolSchemaValidatorStatsForTests(): { lookups: number; compiles: number } {
  return { lookups, compiles };
}
