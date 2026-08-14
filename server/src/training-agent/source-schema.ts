import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const schemaRoot = join(process.cwd(), 'static/schemas/source');
const parsedSchemas = new Map<string, JsonSchema>();
const sourceValidators = new Map<string, ValidateFunction>();
let sourceAjv: Ajv | undefined;
const definitionAnnotationKeys = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'discriminator',
  'example',
  'examples',
  'enumDescriptions',
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

function resolveJsonPointer(document: JsonSchema, fragment: string): unknown {
  if (!fragment) return document;
  if (!fragment.startsWith('/')) {
    throw new Error(`Unsupported non-pointer schema fragment: #${fragment}`);
  }
  return fragment
    .slice(1)
    .split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== 'object' || !(segment in current)) {
        throw new Error(`Schema pointer not found: #${fragment}`);
      }
      return (current as JsonSchema)[segment];
    }, document);
}

function splitSchemaUri(uri: string): { relativePath: string; fragment: string } | undefined {
  if (!uri.startsWith('/schemas/')) return undefined;
  const external = uri.slice('/schemas/'.length);
  const hashIndex = external.indexOf('#');
  return {
    relativePath: hashIndex === -1 ? external : external.slice(0, hashIndex),
    fragment: hashIndex === -1 ? '' : external.slice(hashIndex + 1),
  };
}

function linkedSchemaType(uri: string): unknown {
  const location = splitSchemaUri(uri);
  if (!location) return undefined;
  const linked = resolveJsonPointer(readSchema(location.relativePath), location.fragment);
  return linked && typeof linked === 'object' ? (linked as JsonSchema).type : undefined;
}

function keepDefinitionKey(key: string): boolean {
  return key !== '$id'
    && key !== '$schema'
    && (key === 'x-adcp-schema-uri' || !key.startsWith('x-'))
    && !definitionAnnotationKeys.has(key);
}

/** Build one self-contained schema without duplicating referenced schemas or
 * their absolute $ids. External AdCP refs become local refs into a shared
 * $defs map; refs local to a referenced document stay scoped to that entry. */
function bundleSchema(root: JsonSchema): JsonSchema {
  const definitions = new Map<string, JsonSchema>();

  function definitionKey(relativePath: string, fragment = ''): string {
    return `${relativePath}${fragment ? `#${fragment}` : ''}`;
  }

  function definitionRef(relativePath: string, fragment = ''): string {
    return `#/$defs/${pointerSegment(definitionKey(relativePath, fragment))}`;
  }

  function ensureDefinition(relativePath: string, fragment = ''): void {
    const key = definitionKey(relativePath, fragment);
    if (definitions.has(key)) return;

    // Reserve the entry before descending so recursive schema graphs terminate.
    definitions.set(key, {});
    const source = resolveJsonPointer(readSchema(relativePath), fragment);
    definitions.set(key, rewrite(source, relativePath) as JsonSchema);
  }

  function rewrite(value: unknown, definitionPath?: string): unknown {
    if (Array.isArray(value)) return value.map(entry => rewrite(entry, definitionPath));
    if (!value || typeof value !== 'object') return value;

    const record = value as JsonSchema;
    const linkedSchemaUri = record['x-adcp-schema-uri'];
    if (typeof linkedSchemaUri === 'string') {
      const type = record.type ?? linkedSchemaType(linkedSchemaUri) ?? 'object';
      return {
        type,
        ...(typeof record.description === 'string' && { description: record.description }),
        'x-adcp-schema-uri': linkedSchemaUri,
        ...(type === 'object' && { additionalProperties: true }),
      };
    }
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
        ensureDefinition(relativePath, fragment);
        rewrittenRef = definitionRef(relativePath, fragment);
      } else if (definitionPath && ref.startsWith('#')) {
        const fragment = ref.slice(1);
        if (fragment && !fragment.startsWith('/')) {
          throw new Error(`Unsupported non-pointer local schema fragment: ${ref}`);
        }
        ensureDefinition(definitionPath);
        rewrittenRef = `#/$defs/${pointerSegment(definitionPath)}${fragment}`;
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
  const bundled = bundleSchema(readSchema(`media-buy/${fileName}.json`));
  const {
    $schema: _schema,
    $id: _id,
    title: _title,
    description: _description,
    'x-operation-family': _operationFamily,
    'x-added-in': _addedIn,
    'x-legacy-fallback': _legacyFallback,
    'x-mutates-state': _mutatesState,
    ...inputSchema
  } = bundled;
  return inputSchema;
}

function schemaFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return schemaFiles(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

function productDiscoverySourceValidator(fileName: string): ValidateFunction {
  const cached = sourceValidators.get(fileName);
  if (cached) return cached;

  if (!sourceAjv) {
    sourceAjv = new Ajv({ strict: false });
    addFormats(sourceAjv);
    for (const path of schemaFiles(schemaRoot)) {
      const schema = JSON.parse(readFileSync(path, 'utf8')) as JsonSchema;
      if (typeof schema.$id === 'string') sourceAjv.addSchema(schema, schema.$id);
    }
  }
  const validator = sourceAjv.getSchema(`/schemas/media-buy/${fileName}.json`);
  if (!validator) throw new Error(`Source schema validator not found: ${fileName}`);
  sourceValidators.set(fileName, validator);
  return validator;
}

function errorField(error: ErrorObject): string | undefined {
  const path = error.instancePath.replace(/^\//, '').replaceAll('/', '.');
  if (path) return path;
  const missing = (error.params as { missingProperty?: unknown }).missingProperty;
  return typeof missing === 'string' ? missing : undefined;
}

/** Validate the actual split-tool call against the normative source schema.
 * MCP tools/list intentionally projects large linked objects to compact type
 * hints, so dispatch must still enforce the complete canonical contract. */
export function validateProductDiscoverySourceInput(
  fileName: string,
  args: Record<string, unknown>,
): { message: string; field?: string } | undefined {
  const validator = productDiscoverySourceValidator(fileName);
  if (!validator(args)) {
    const error = validator.errors?.[0];
    const field = error && errorField(error);
    return {
      message: `Invalid ${fileName.replaceAll('-', '_')}${field ? ` at ${field}` : ''}: ${error?.message ?? 'schema validation failed'}`,
      ...(field && { field }),
    };
  }
  if (fileName === 'refine-proposals-request' && Array.isArray(args.refinements)) {
    for (let index = 0; index < args.refinements.length; index += 1) {
      const refinement = args.refinements[index];
      if (!isRecord(refinement) || !isRecord(refinement.constraints)) continue;
      const budget = refinement.constraints.total_budget;
      if (!isRecord(budget)) continue;
      if (typeof budget.min === 'number' && typeof budget.max === 'number' && budget.min > budget.max) {
        const field = `refinements.${index}.constraints.total_budget`;
        return {
          message: 'Invalid refine_proposals_request: total_budget min must be less than or equal to max',
          field,
        };
      }
    }
  }
  return undefined;
}

/** Validate a split-tool response against its normative source schema. This
 * is primarily used by the training-agent contract tests so a compatibility
 * handler cannot accidentally leak legacy shapes onto the compact wire. */
export function validateProductDiscoverySourceResponse(
  fileName: string,
  response: Record<string, unknown>,
  request?: Record<string, unknown>,
): { message: string; field?: string } | undefined {
  const validator = productDiscoverySourceValidator(fileName);
  if (!validator(response)) {
    const error = validator.errors?.[0];
    const field = error && errorField(error);
    return {
      message: `Invalid ${fileName.replaceAll('-', '_')}${field ? ` at ${field}` : ''}: ${error?.message ?? 'schema validation failed'}`,
      ...(field && { field }),
    };
  }
  if (fileName === 'refine-proposals-response' && Array.isArray(response.results)) {
    let requestedRefinements: Record<string, unknown>[] | undefined;
    if (request && Array.isArray(request.refinements)) {
      const validRefinements = request.refinements.filter(
        (refinement): refinement is Record<string, unknown> => (
          isRecord(refinement) && typeof refinement.proposal_id === 'string'
        ),
      );
      if (validRefinements.length === request.refinements.length) {
        requestedRefinements = validRefinements;
      }
    }
    if (requestedRefinements && response.results.length !== requestedRefinements.length) {
      return {
        message: 'Invalid refine_proposals_response: results must contain one ordered entry per requested refinement',
        field: 'results',
      };
    }
    for (let resultIndex = 0; resultIndex < response.results.length; resultIndex += 1) {
      const result = response.results[resultIndex];
      if (!isRecord(result)) continue;
      if (Array.isArray(result.proposals)) {
        const termsDigests = new Set<string>();
        for (let proposalIndex = 0; proposalIndex < result.proposals.length; proposalIndex += 1) {
          const proposal = result.proposals[proposalIndex];
          if (!isRecord(proposal) || typeof proposal.terms_digest !== 'string') continue;
          if (termsDigests.has(proposal.terms_digest)) {
            const field = `results.${resultIndex}.proposals.${proposalIndex}.terms_digest`;
            return {
              message: 'Invalid refine_proposals_response: alternative proposals must have unique terms_digest values',
              field,
            };
          }
          termsDigests.add(proposal.terms_digest);
        }
      }
      if (typeof result.source_proposal_id !== 'string') continue;
      const requested = requestedRefinements?.[resultIndex];
      if (!requested) continue;
      if (result.source_proposal_id !== requested.proposal_id) {
        const field = `results.${resultIndex}.source_proposal_id`;
        return {
          message: 'Invalid refine_proposals_response: result source proposal IDs must preserve request order',
          field,
        };
      }
      const requestedConstraints = isRecord(requested.constraints) ? requested.constraints : undefined;
      if (Array.isArray(result.unsatisfied_constraints)) {
        for (let constraintIndex = 0; constraintIndex < result.unsatisfied_constraints.length; constraintIndex += 1) {
          const constraint = result.unsatisfied_constraints[constraintIndex];
          if (typeof constraint === 'string' && !Object.hasOwn(requestedConstraints ?? {}, constraint)) {
            const field = `results.${resultIndex}.unsatisfied_constraints.${constraintIndex}`;
            return {
              message: 'Invalid refine_proposals_response: unsatisfied constraint was not present in the request',
              field,
            };
          }
        }
      }
      const requestedProductChanges = isRecord(requested.product_changes) ? requested.product_changes : undefined;
      if (isRecord(result.unsatisfied_product_changes)) {
        for (const [productId, action] of Object.entries(result.unsatisfied_product_changes)) {
          if (!requestedProductChanges || requestedProductChanges[productId] !== action) {
            const field = `results.${resultIndex}.unsatisfied_product_changes.${productId}`;
            return {
              message: 'Invalid refine_proposals_response: unsatisfied product change was not present in the request',
              field,
            };
          }
        }
      }
      if (!Array.isArray(result.proposals)) continue;
      const alternatives = isRecord(requested.alternatives) ? requested.alternatives : undefined;
      const expectedCount = alternatives && typeof alternatives.count === 'number' ? alternatives.count : 1;
      const invalidCount = result.outcome === 'revised'
        ? result.proposals.length !== expectedCount
        : result.outcome === 'partial' && result.proposals.length > expectedCount;
      if (invalidCount) {
        const field = `results.${resultIndex}.proposals`;
        return {
          message: result.outcome === 'revised'
            ? `Invalid refine_proposals_response: revised result requires exactly ${expectedCount} proposal${expectedCount === 1 ? '' : 's'}`
            : `Invalid refine_proposals_response: partial result permits at most ${expectedCount} proposal${expectedCount === 1 ? '' : 's'}`,
          field,
        };
      }
    }
  }
  return undefined;
}
