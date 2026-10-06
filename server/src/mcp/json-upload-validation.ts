import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SCHEMA_VERSION_OPTIONS } from '../addie/mcp/schema-tools.js';
import { ToolError } from '../addie/tool-error.js';
import { MAX_JSON_FILE_BYTES, validateJsonBytes, JSON_FILE_VALIDATION_TOOL } from './json-file-validation.js';

export const JSON_VALIDATOR_URL = 'https://agenticadvertising.org/adagents/validator';

/** Only fixed upload-integrity messages may be returned by the anonymous API. */
export class JsonUploadValidationError extends ToolError {
  constructor(public readonly publicMessage: string) {
    super(publicMessage);
  }
}
export const JSON_VALIDATOR_RESOURCE = {
  uri: 'ui://addie/json-validator.html',
  name: 'Original JSON file validator',
  mimeType: 'text/html;profile=mcp-app',
};
const schemaOptions = {
  schema_path: { type: 'string', maxLength: 255, description: 'Published schema path. Inferred from $schema or the adagents.json filename when omitted.' },
  version: { type: 'string', enum: SCHEMA_VERSION_OPTIONS, description: 'Optional published schema version.' },
};

export const OPEN_JSON_VALIDATOR_TOOL = {
  name: 'open_json_validator',
  description: 'Open a file picker to validate the original JSON bytes without reconstructing them in a tool argument. Use when an attachment has no accessible original-file download reference. Ask the user to select the original file once in the picker; existing chat attachments cannot be accessed automatically. Returns a standalone browser link for clients without MCP Apps. Schema validation only; does not check agent endpoints.',
  inputSchema: { type: 'object', properties: schemaOptions, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: JSON_VALIDATOR_RESOURCE.uri } },
};

export const JSON_UPLOAD_VALIDATION_TOOL = {
  name: 'validate_json_upload',
  description: 'File-picker transport only. Validate browser-encoded original file bytes after checking their browser-computed raw SHA-256 and byte count. Never manually reconstruct JSON or base64 to call this tool. Use open_json_validator to let the user select a file.',
  inputSchema: {
    type: 'object',
    properties: {
      ...schemaOptions,
      content_base64: { type: 'string', maxLength: 4 * Math.ceil(MAX_JSON_FILE_BYTES / 3), description: 'Canonical base64 encoded programmatically from the original file bytes.' },
      expected_file_sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'SHA-256 of the original raw file bytes computed by the picker before transfer.' },
      expected_byte_count: { type: 'integer', minimum: 1, maximum: MAX_JSON_FILE_BYTES },
      file_name: { type: 'string', maxLength: 255 },
    },
    required: ['content_base64', 'expected_file_sha256', 'expected_byte_count'],
    additionalProperties: false,
  },
  outputSchema: JSON_FILE_VALIDATION_TOOL.outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: { ui: { visibility: ['app'] } },
};

export async function openJsonValidator(input: Record<string, unknown>) {
  for (const field of ['schema_path', 'version']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || (input[field] as string).length > 255)) {
      throw new ToolError(`${field} must be a string no longer than 255 characters when provided.`);
    }
  }
  const url = new URL(JSON_VALIDATOR_URL);
  for (const field of ['schema_path', 'version']) if (input[field]) url.searchParams.set(field, input[field] as string);
  return {
    content: [{ type: 'text', text: `Select the original JSON file in the picker to validate its complete bytes. If the picker is unavailable, open ${url.href} in your browser and select the file there. No file has been validated yet. Files are not stored. This checks the published schema, not agent endpoint availability.` }],
    structuredContent: { validator_url: url.href },
  };
}

export async function readJsonValidatorResource() {
  const publicDir = resolve(process.cwd(), 'server/public');
  const [html, css] = await Promise.all([
    readFile(resolve(publicDir, 'json-validator-app.html'), 'utf8'),
    readFile(resolve(publicDir, 'design-system.css'), 'utf8'),
  ]);
  // Embed the shared design system so the sandbox needs no external resources.
  return { contents: [{
    ...JSON_VALIDATOR_RESOURCE,
    text: html.replace('<link rel="stylesheet" href="/design-system.css">', `<style>${css}</style>`),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
  }] };
}

export async function validateJsonUploadBytes(bytes: Buffer, input: Record<string, unknown>) {
  if (!bytes.length || bytes.length > MAX_JSON_FILE_BYTES) throw new JsonUploadValidationError('Select a nonempty JSON file no larger than 5 MiB.');
  if (typeof input.expected_file_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.expected_file_sha256)) {
    throw new JsonUploadValidationError('The original raw file SHA-256 is required. Select the original file in the picker again.');
  }
  if (!Number.isSafeInteger(input.expected_byte_count) || input.expected_byte_count !== bytes.length) {
    throw new JsonUploadValidationError('The uploaded byte count does not match the original file. Select the original file again.');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== input.expected_file_sha256.toLowerCase()) {
    throw new JsonUploadValidationError('The uploaded bytes do not match the original file SHA-256. No schema validation was performed. Select the original file again.');
  }
  return validateJsonBytes(bytes, input, 'uploaded');
}

export async function validateJsonUpload(input: Record<string, unknown>) {
  const encoded = input.content_base64;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_JSON_FILE_BYTES / 3) || encoded.length % 4 !== 0) {
    throw new ToolError('Provide canonical base64 for a nonempty file no larger than 5 MiB.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  // Node's decoder accepts malformed base64; require an exact canonical round trip.
  if (bytes.toString('base64') !== encoded) throw new ToolError('The uploaded file is not canonical base64.');
  return validateJsonUploadBytes(bytes, input);
}
