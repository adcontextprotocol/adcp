/**
 * Validates an assembled adagents.json document against the published JSON
 * Schema (static/schemas/source/adagents.json), with all `/schemas/...` $refs
 * resolved from the local source tree.
 *
 * This is the authoritative wire-contract check — stronger than
 * AdAgentsManager.validateProposed, which only does shallow structural checks
 * (e.g. it does not require `params` on a `formats[]` entry). The community-
 * mirror publish path uses this so AAO never stores/serves a mirror that a
 * buyer SDK validating against the schema would reject.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('adagents-schema-validator');

// static/ is shipped in the image (Dockerfile COPY static ./static). Resolve
// the source schema tree relative to this module, mirroring the NODE_ENV split
// used for express.static in http.ts. This module lives one directory deeper
// (services/), hence the extra `..`.
const SOURCE_DIR =
  process.env.NODE_ENV === 'production'
    ? path.join(__dirname, '../../static/schemas/source')
    : path.join(__dirname, '../../../static/schemas/source');

let compiled: Promise<ValidateFunction> | null = null;

function loadLocalSchema(uri: string): object {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot resolve non-local $ref: ${uri}`);
  }
  const rel = uri.replace('/schemas/', '');
  return JSON.parse(readFileSync(path.join(SOURCE_DIR, rel), 'utf8'));
}

function getValidator(): Promise<ValidateFunction> {
  if (!compiled) {
    compiled = (async () => {
      const ajv = new Ajv({
        strict: false,
        allErrors: true,
        discriminator: true,
        loadSchema: async (uri: string) => loadLocalSchema(uri),
      });
      addFormats(ajv);
      const schema = JSON.parse(
        readFileSync(path.join(SOURCE_DIR, 'adagents.json'), 'utf8')
      );
      return ajv.compileAsync(schema);
    })().catch((err) => {
      // Allow a retry on a transient load/compile failure rather than caching
      // a rejected promise forever.
      compiled = null;
      logger.error({ err, SOURCE_DIR }, 'Failed to compile adagents.json schema validator');
      throw err;
    });
  }
  return compiled;
}

export async function validateAdagentsDocument(
  doc: unknown
): Promise<{ valid: boolean; errors: string[] }> {
  const validate = await getValidator();
  const valid = validate(doc) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map((e) => {
    const where = e.instancePath || '(root)';
    const params = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
    return `${where}: ${e.message ?? 'invalid'}${params}`;
  });
  return { valid: false, errors };
}
