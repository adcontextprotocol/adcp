import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

let cachedValidator: ValidateFunction | null = null;
let cachedSchema: Record<string, unknown> | null = null;

function schemaPath(ref: string): string {
  const relative = ref.startsWith('/schemas/') ? ref.slice('/schemas/'.length) : ref;
  return join(process.cwd(), 'static/schemas/source', relative);
}

function brandSchema(): Record<string, unknown> {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'static/schemas/source/brand.json'), 'utf8')
    ) as Record<string, unknown>;
  }
  return cachedSchema;
}

function preloadRefs(ajv: Ajv): void {
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = node as Record<string, unknown>;
    const ref = record.$ref;
    if (typeof ref === 'string' && ref.startsWith('/schemas/') && !seen.has(ref)) {
      seen.add(ref);
      const referenced = JSON.parse(readFileSync(schemaPath(ref), 'utf8')) as Record<string, unknown>;
      if (typeof referenced.$id !== 'string') referenced.$id = ref;
      ajv.addSchema(referenced, ref);
      visit(referenced);
    }
    Object.values(record).forEach(visit);
  };
  visit(brandSchema());
}

function validator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    preloadRefs(ajv);
    cachedValidator = ajv.compile(brandSchema());
  }
  return cachedValidator;
}

export function validateBrandJsonSchema(data: unknown): {
  valid: boolean;
  errors: ErrorObject[];
} {
  const validate = validator();
  return {
    valid: Boolean(validate(data)),
    errors: [...(validate.errors ?? [])],
  };
}
