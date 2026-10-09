import { createHash } from 'node:crypto';
import { createSchemaToolHandlers, SCHEMA_VERSION_OPTIONS } from '../addie/mcp/schema-tools.js';
import { ToolError } from '../addie/tool-error.js';
import { isNetworkPolicyRefusal, safeFetch } from '../utils/url-security.js';

export const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Public MCP file input; kept outside Addie's internal conversational tool set. */
export const JSON_FILE_VALIDATION_TOOL = {
  name: 'validate_json_file',
  description: 'Validate a complete uploaded JSON file against a published AdCP schema without copying or shortening its contents. Prefer this over validate_json when the client provides a file download reference. Downloads up to 5 MiB from a public HTTPS URL and returns the byte count, SHA-256 hash, and schema validation result. Does not contact publisher or agent URLs inside the file. For a local file without a download reference, do not invent a URL or claim this tool validated it.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'object',
        properties: {
          download_url: { type: 'string', description: 'Temporary HTTPS download URL supplied by the client for the original file.' },
          file_id: { type: 'string', description: 'The client-provided identifier of the uploaded file.' },
          mime_type: { type: 'string', description: 'Optional media type supplied by the client.' },
          file_name: { type: 'string', description: 'Optional original filename. adagents.json selects its schema when the file has no $schema.' },
        },
        required: ['download_url', 'file_id'],
        additionalProperties: false,
      },
      schema_path: { type: 'string', description: 'Published schema path, e.g. adagents.json. Inferred from $schema or the adagents.json filename when omitted.' },
      version: { type: 'string', enum: SCHEMA_VERSION_OPTIONS, description: 'Optional published schema version; uses the same selection rules as validate_json.' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      byte_count: { type: 'integer' },
      sha256: { type: 'string' },
      validation: { type: 'string' },
    },
    required: ['byte_count', 'sha256', 'validation'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: { 'openai/fileParams': ['file'] },
};

function requireDownloadUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new ToolError('The file download URL is invalid. Request a fresh file reference from the client.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ToolError('File downloads require an HTTPS URL without embedded credentials.');
  }
  return url;
}

async function downloadFile(url: URL, signal: AbortSignal): Promise<Buffer> {
  for (let hop = 0; hop <= 3; hop++) {
    const response = await safeFetch(url.toString(), {
      maxRedirects: 0,
      signal,
      headers: { Accept: 'application/json,text/plain,application/octet-stream', 'User-Agent': 'Addie/1.0' },
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (hop === 3 || !location) throw new ToolError('The file download returned too many redirects or a redirect without a location.');
      // Every hop goes through safeFetch, including its connect-time DNS checks.
      url = requireDownloadUrl(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ToolError(`File download returned HTTP ${response.status}. Request a fresh file download reference and retry.`);
    }
    if (Number(response.headers.get('content-length')) > MAX_JSON_FILE_BYTES) {
      await response.body?.cancel();
      throw new ToolError('The JSON file exceeds the 5 MiB download limit.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ToolError('The file download has no readable body.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > MAX_JSON_FILE_BYTES) {
          await reader.cancel();
          throw new ToolError('The JSON file exceeds the 5 MiB download limit.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  throw new ToolError('The file download could not be completed.');
}

export async function validateJsonFile(input: Record<string, unknown>) {
  const file = input.file;
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new ToolError('file must be a client-provided file reference.');
  const reference = file as Record<string, unknown>;
  for (const field of ['download_url', 'file_id']) {
    if (typeof reference[field] !== 'string' || !(reference[field] as string).trim()) {
      throw new ToolError(`file.${field} must be a nonempty string supplied by the client.`);
    }
  }
  for (const field of ['mime_type', 'file_name']) {
    if (reference[field] !== undefined && typeof reference[field] !== 'string') throw new ToolError(`file.${field} must be a string when provided.`);
  }
  for (const field of ['schema_path', 'version']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new ToolError(`${field} must be a string when provided.`);
  }
  const url = requireDownloadUrl(reference.download_url as string);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let bytes: Buffer;
  // Bound DNS preflight as well as headers and body consumption. safeFetch's
  // signal cancels the actual transfer even if preflight completes after timeout.
  let onAbort: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ToolError('The file download timed out. Request a fresh file reference and retry.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    bytes = await Promise.race([downloadFile(url, controller.signal), deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw new ToolError('The file download timed out. Request a fresh file reference and retry.');
    if (error instanceof ToolError) throw error;
    if (isNetworkPolicyRefusal(error)) throw new ToolError('The file download URL must resolve to a public host.');
    // Network errors can contain signed URLs; never echo or log those secrets.
    throw new ToolError('Could not download the file. Request a fresh file reference and retry.');
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort!);
  }
  return validateJsonBytes(bytes, { ...input, file_name: reference.file_name }, 'downloaded');
}

/** Shared schema validation of original bytes; callers establish their source. */
export async function validateJsonBytes(bytes: Buffer, input: Record<string, unknown>, source: 'downloaded' | 'uploaded') {
  if (!bytes.length || bytes.length > MAX_JSON_FILE_BYTES) throw new ToolError('Select a nonempty JSON file no larger than 5 MiB.');
  for (const field of ['file_name', 'schema_path', 'version']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || (input[field] as string).length > 255)) {
      throw new ToolError(`${field} must be a string no longer than 255 characters when provided.`);
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ToolError(`The ${source} file must contain valid UTF-8 JSON.`);
  }
  const schemaPath = input.schema_path ?? (
    input.file_name === 'adagents.json' && json && typeof json === 'object' && !('$schema' in json)
      ? 'adagents.json' : undefined
  );
  // This tool reads and hashes the original bytes itself; its receipt below
  // replaces the inline tool's warning about unverified source-file integrity.
  const validator = createSchemaToolHandlers({ includeSourceIntegrity: false }).get('validate_json')!;
  const validation = await validator({ json, schema_path: schemaPath, version: input.version });
  if (validation.startsWith('Cannot determine schema.')) throw new ToolError(validation);
  const structuredContent = { byte_count: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), validation };
  return {
    content: [{ type: 'text', text: `Validated the complete ${source} JSON file (${structuredContent.byte_count} bytes, SHA-256 ${structuredContent.sha256}). Schema validation only; no publisher or agent URLs inside the file were contacted.\n\n${validation}` }],
    structuredContent,
  };
}
