import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalize } from '@adcp/sdk';

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
    const compactPath = relativePath.endsWith('.json') ? relativePath.slice(0, -5) : relativePath;
    return `${compactPath}${fragment ? `#${fragment}` : ''}`;
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
        rewrittenRef = `${definitionRef(definitionPath)}${fragment}`;
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

function proposalSatisfiesBudgetConstraint(
  proposal: Record<string, unknown>,
  constraint: Record<string, unknown>,
): boolean {
  const commercialTerms = isRecord(proposal.commercial_terms) ? proposal.commercial_terms : undefined;
  const totalBudget = isRecord(commercialTerms?.total_budget) ? commercialTerms.total_budget : undefined;
  if (!totalBudget || typeof totalBudget.amount !== 'number' || typeof totalBudget.currency !== 'string') {
    return false;
  }
  if (totalBudget.currency !== constraint.currency) return false;
  if (typeof constraint.min === 'number' && totalBudget.amount < constraint.min) return false;
  if (typeof constraint.max === 'number' && totalBudget.amount > constraint.max) return false;
  return true;
}

function commercialTermsPurchases(proposal: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const commercialTerms = isRecord(proposal.commercial_terms) ? proposal.commercial_terms : undefined;
  const purchases = Array.isArray(commercialTerms?.purchases) ? commercialTerms.purchases : undefined;
  if (!purchases || purchases.length === 0 || !purchases.every(isRecord)) return undefined;
  return purchases as Record<string, unknown>[];
}

function proposalSatisfiesCpmConstraint(
  proposal: Record<string, unknown>,
  constraint: Record<string, unknown>,
): boolean {
  const purchases = commercialTermsPurchases(proposal);
  const maxRate = constraint.max;
  const currency = constraint.currency;
  if (!purchases || typeof maxRate !== 'number' || typeof currency !== 'string') return false;
  return purchases.every(purchase => {
    const pricing = isRecord(purchase.pricing) ? purchase.pricing : undefined;
    return pricing !== undefined
      && (pricing.pricing_model === 'cpm' || pricing.pricing_model === 'vcpm')
      && pricing.currency === currency
      && typeof pricing.fixed_price === 'number'
      && pricing.fixed_price <= maxRate;
  });
}

function proposalSatisfiesImpressionsConstraint(
  proposal: Record<string, unknown>,
  constraint: Record<string, unknown>,
): boolean {
  const purchases = commercialTermsPurchases(proposal);
  if (!purchases || typeof constraint.min !== 'number') return false;
  let total = 0;
  for (const purchase of purchases) {
    if (typeof purchase.impressions !== 'number') return false;
    total += purchase.impressions;
  }
  return total >= constraint.min;
}

function proposalSatisfiesFlightConstraint(
  proposal: Record<string, unknown>,
  constraint: Record<string, unknown>,
): boolean {
  const commercialTerms = isRecord(proposal.commercial_terms) ? proposal.commercial_terms : undefined;
  if (!commercialTerms) return false;
  if (typeof constraint.start_no_later_than === 'string') {
    if (typeof commercialTerms.start_time !== 'string' || commercialTerms.start_time === 'asap') return false;
    const start = Date.parse(commercialTerms.start_time);
    const bound = Date.parse(constraint.start_no_later_than);
    if (Number.isNaN(start) || Number.isNaN(bound) || start > bound) return false;
  }
  if (typeof constraint.end_no_earlier_than === 'string') {
    if (typeof commercialTerms.end_time !== 'string') return false;
    const end = Date.parse(commercialTerms.end_time);
    const bound = Date.parse(constraint.end_no_earlier_than);
    if (Number.isNaN(end) || Number.isNaN(bound) || end < bound) return false;
  }
  return true;
}

const refinementConstraintChecks: Array<[
  string,
  (proposal: Record<string, unknown>, constraint: Record<string, unknown>) => boolean,
]> = [
  ['total_budget', proposalSatisfiesBudgetConstraint],
  ['cpm', proposalSatisfiesCpmConstraint],
  ['impressions', proposalSatisfiesImpressionsConstraint],
  ['flight', proposalSatisfiesFlightConstraint],
];

function expectedTermsDigest(proposal: Record<string, unknown>): string | undefined {
  if (!isRecord(proposal.commercial_terms)) return undefined;
  return `sha256:${createHash('sha256').update(canonicalize(proposal.commercial_terms), 'utf8').digest('base64url')}`;
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
      const sourceProposalId = typeof result.source_proposal_id === 'string' ? result.source_proposal_id : undefined;
      const returnedProposals: Array<[Record<string, unknown>, string]> = [];
      if (Array.isArray(result.proposals)) {
        for (let proposalIndex = 0; proposalIndex < result.proposals.length; proposalIndex += 1) {
          const proposal = result.proposals[proposalIndex];
          if (!isRecord(proposal)) continue;
          returnedProposals.push([proposal, `results.${resultIndex}.proposals.${proposalIndex}`]);
        }
      }
      if (isRecord(result.proposal)) {
        returnedProposals.push([result.proposal, `results.${resultIndex}.proposal`]);
      }
      const canonicalTerms = new Set<string>();
      for (const [proposal, proposalField] of returnedProposals) {
        const expectedDigest = expectedTermsDigest(proposal);
        if (expectedDigest !== undefined && proposal.terms_digest !== expectedDigest) {
          return {
            message: 'Invalid refine_proposals_response: terms_digest must be the sha256 of the JCS-canonicalized commercial_terms',
            field: `${proposalField}.terms_digest`,
          };
        }
        if (isRecord(proposal.commercial_terms)) {
          const canonical = canonicalize(proposal.commercial_terms);
          if (canonicalTerms.has(canonical)) {
            return {
              message: 'Invalid refine_proposals_response: alternative proposals must have distinct commercial_terms',
              field: `${proposalField}.commercial_terms`,
            };
          }
          canonicalTerms.add(canonical);
        }
        if (sourceProposalId !== undefined && proposal.parent_proposal_id !== sourceProposalId) {
          return {
            message: 'Invalid refine_proposals_response: returned proposals must carry parent_proposal_id equal to source_proposal_id',
            field: `${proposalField}.parent_proposal_id`,
          };
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
      const alternatives = isRecord(requested.alternatives) ? requested.alternatives : undefined;
      const requestedAlternativeCount = alternatives && typeof alternatives.count === 'number'
        ? alternatives.count
        : undefined;
      if (result.reason_code === 'alternatives_unavailable') {
        const returnedProposalCount = Array.isArray(result.proposals) ? result.proposals.length : 0;
        if (requestedAlternativeCount === undefined || returnedProposalCount >= requestedAlternativeCount) {
          return {
            message: 'Invalid refine_proposals_response: alternatives_unavailable requires fewer proposals than requested',
            field: `results.${resultIndex}.reason_code`,
          };
        }
      }
      if (!Array.isArray(result.proposals)) continue;

      for (const [constraintKey, satisfiesConstraint] of refinementConstraintChecks) {
        const requestedConstraint = isRecord(requestedConstraints?.[constraintKey])
          ? requestedConstraints[constraintKey] as Record<string, unknown>
          : undefined;
        if (!requestedConstraint) continue;
        const unsatisfiedProposalIndex = result.proposals.findIndex(proposal => (
          isRecord(proposal) && !satisfiesConstraint(proposal, requestedConstraint)
        ));
        if (unsatisfiedProposalIndex === -1) continue;
        const field = `results.${resultIndex}.proposals.${unsatisfiedProposalIndex}.commercial_terms${
          constraintKey === 'total_budget' ? '.total_budget' : ''
        }`;
        if (result.outcome === 'revised') {
          return {
            message: `Invalid refine_proposals_response: revised proposal does not satisfy ${constraintKey}`,
            field,
          };
        }
        if (
          result.outcome === 'partial'
          && (
            result.reason_code !== 'constraint_unsatisfiable'
            || !Array.isArray(result.unsatisfied_constraints)
            || !result.unsatisfied_constraints.includes(constraintKey)
          )
        ) {
          return {
            message: `Invalid refine_proposals_response: an unsatisfied ${constraintKey} requires constraint_unsatisfiable and unsatisfied_constraints`,
            field,
          };
        }
      }

      const expectedCount = requestedAlternativeCount ?? 1;
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
