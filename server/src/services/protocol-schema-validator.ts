import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_DIR = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '../../static/schemas/source')
  : path.join(__dirname, '../../../static/schemas/source');
const SOURCE_ROOT = path.resolve(SOURCE_DIR);

const validators = new Map<string, Promise<ValidateFunction>>();

function loadLocalSchema(uri: string): object {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot resolve non-local schema reference: ${uri}`);
  }
  const full = path.resolve(SOURCE_ROOT, uri.slice('/schemas/'.length));
  if (full !== SOURCE_ROOT && !full.startsWith(`${SOURCE_ROOT}${path.sep}`)) {
    throw new Error(`Refusing schema reference outside source tree: ${uri}`);
  }
  return JSON.parse(readFileSync(full, 'utf8')) as object;
}

function getValidator(schemaUri: string): Promise<ValidateFunction> {
  const existing = validators.get(schemaUri);
  if (existing) return existing;
  const compiling = (async () => {
    const ajv = new Ajv({
      strict: false,
      allErrors: true,
      discriminator: true,
      loadSchema: async (uri: string) => loadLocalSchema(uri),
    });
    addFormats(ajv);
    return ajv.compileAsync(loadLocalSchema(schemaUri));
  })().catch(error => {
    validators.delete(schemaUri);
    throw error;
  });
  validators.set(schemaUri, compiling);
  return compiling;
}

export async function validateProtocolSchema(
  schemaUri: string,
  value: unknown,
): Promise<{ valid: boolean; errors: ErrorObject[] }> {
  const validate = await getValidator(schemaUri);
  const valid = validate(value) as boolean;
  return { valid, errors: valid ? [] : [...(validate.errors ?? [])] };
}
