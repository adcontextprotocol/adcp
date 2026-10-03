import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.hoisted(() => ({ blocked: false }));
vi.mock('../../src/middleware/rate-limit.js', () => ({
  jsonUploadValidationRateLimiter: (_req: unknown, res: express.Response, next: () => void) => {
    if (limit.blocked) res.status(429).json({ error: 'Too many file validations.' });
    else next();
  },
}));
import { validateJsonUpload, readJsonValidatorResource, openJsonValidator, JSON_UPLOAD_VALIDATION_TOOL } from '../../src/mcp/json-upload-validation.js';
import { createJsonValidationRouter } from '../../src/routes/json-validation.js';
import { MAX_JSON_FILE_BYTES } from '../../src/mcp/json-file-validation.js';
import { SCHEMA_TOOL_DEFINITIONS, createStatelessToolHandlers } from '../../src/mcp/exposed-tools.js';
import { SCHEMA_TOOLS } from '../../src/addie/mcp/schema-tools.js';
import { csrfProtection } from '../../src/middleware/csrf.js';

const schemaFetch = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://adcontextprotocol.org') throw new Error('Unexpected schema host');
  return new Response(readFileSync(resolve(import.meta.dirname, '../../../dist', url.pathname.slice(1)), 'utf8'));
});
function fixture(protocol = 'https') {
  return Buffer.from(JSON.stringify({
    $schema: 'https://adcontextprotocol.org/schemas/3.2.1/adagents.json',
    ext: { padding: Array.from({ length: 500 }, () => 'x'.repeat(60)) },
    authoritative_location: `${protocol}://publisher.example.com/adagents.json`,
  }, null, 2) + '\n');
}
function metadata(bytes: Buffer) {
  return { expected_file_sha256: createHash('sha256').update(bytes).digest('hex'), expected_byte_count: bytes.length };
}
function input(bytes: Buffer) {
  return { ...metadata(bytes), content_base64: bytes.toString('base64'), file_name: 'adagents.json' };
}
function makeApp(csrf = false) {
  const app = express();
  app.use(express.json());
  if (csrf) { app.use(cookieParser()); app.use(csrfProtection); app.get('/picker', (_req, res) => res.send('picker')); }
  app.use('/api', createJsonValidationRouter());
  return app;
}
beforeEach(() => { limit.blocked = false; schemaFetch.mockClear(); vi.stubGlobal('fetch', schemaFetch); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('original-byte picker transfer', () => {
  it.each(['https', 'http'])('checks all 500 entries and the final %s URL', async (protocol) => {
    const bytes = fixture(protocol);
    const result = await validateJsonUpload(input(bytes));
    expect(result.structuredContent).toMatchObject({ byte_count: bytes.length, sha256: metadata(bytes).expected_file_sha256 });
    expect(result.structuredContent.validation).toContain(protocol === 'https' ? '✅ **Valid!' : '/authoritative_location: must match pattern');
    expect(result.content[0].text).not.toContain('Source integrity: unverified');
    expect(result.content[0].text).not.toContain('x'.repeat(60));
  });
  it.each([510, 650])('rejects a reconstructed %i-entry payload before any schema request', async (count) => {
    const original = fixture();
    const json = JSON.parse(original.toString());
    json.ext.padding = Array.from({ length: count }, () => 'x'.repeat(60));
    const changed = Buffer.from(JSON.stringify(json));
    await expect(validateJsonUpload({ ...input(changed), expected_file_sha256: metadata(original).expected_file_sha256 })).rejects.toThrow('do not match');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('rejects incorrect byte counts independently from hashes', async () => {
    const bytes = fixture();
    await expect(validateJsonUpload({ ...input(bytes), expected_byte_count: bytes.length - 1 })).rejects.toThrow('byte count');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it.each([undefined, 'invalid', '', 'f'.repeat(65)])('requires the original raw checksum (%s)', async (hash) => {
    await expect(validateJsonUpload({ ...input(fixture()), expected_file_sha256: hash })).rejects.toThrow('SHA-256 is required');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it.each(['!!!!', 'YQ', 'YQ==\n', 'YR==', '===='])('rejects noncanonical base64 %s before schema validation', async (encoded) => {
    await expect(validateJsonUpload({ ...input(fixture()), content_base64: encoded })).rejects.toThrow(/base64/);
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('bounds encoded and decoded file sizes', async () => {
    await expect(validateJsonUpload(input(Buffer.alloc(MAX_JSON_FILE_BYTES + 1)))).rejects.toThrow('5 MiB');
    await expect(validateJsonUpload({ ...input(fixture()), content_base64: 'A'.repeat(4 * Math.ceil(MAX_JSON_FILE_BYTES / 3) + 4) })).rejects.toThrow('5 MiB');
    await expect(validateJsonUpload(input(Buffer.alloc(0)))).rejects.toThrow('nonempty');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it.each([Buffer.from([0xff]), Buffer.from('{"broken":')])('rejects invalid UTF-8 or JSON bytes', async (bytes) => {
    await expect(validateJsonUpload(input(bytes))).rejects.toThrow('valid UTF-8 JSON');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('preserves BOM and multibyte characters in the receipt and infers the filename schema', async () => {
    const bytes = Buffer.from('\uFEFF{"authoritative_location":"https://publisher.example.com/adagents.json","ext":{"label":"café"}}\n');
    const result = await validateJsonUpload(input(bytes));
    expect(result.structuredContent).toMatchObject({ byte_count: bytes.length, sha256: metadata(bytes).expected_file_sha256 });
    expect(result.structuredContent.validation).toContain('✅ **Valid!');
  });
  it('does not produce a validation receipt without a schema', async () => {
    const bytes = Buffer.from('{"ext":{}}');
    await expect(validateJsonUpload({ ...input(bytes), file_name: 'other.json' })).rejects.toThrow('Cannot determine schema');
  });
  it('registers the picker and app-only transport without changing internal Addie descriptors', async () => {
    expect(SCHEMA_TOOL_DEFINITIONS).toContain(JSON_UPLOAD_VALIDATION_TOOL);
    expect(JSON_UPLOAD_VALIDATION_TOOL._meta.ui.visibility).toEqual(['app']);
    const handlers = createStatelessToolHandlers();
    expect(handlers.has('open_json_validator')).toBe(true);
    expect(handlers.has('validate_json_upload')).toBe(true);
    expect(SCHEMA_TOOLS.some((tool) => tool.name === 'validate_json_upload')).toBe(false);
    const result = await openJsonValidator({ schema_path: 'adagents.json', version: 'v3' });
    expect(result.content[0].text).toContain('No file has been validated yet');
    expect(result.structuredContent.validator_url).toBe('https://agenticadvertising.org/adagents/validator?schema_path=adagents.json&version=v3');
  });
  it('serves a self-contained MCP Apps resource with restrictive network permissions', async () => {
    const { contents: [resource] } = await readJsonValidatorResource();
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource.text).toContain('ui/initialize');
    expect(resource.text).not.toContain('<link rel="stylesheet"');
    expect(resource._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
  });
});

describe('standalone multipart validator', () => {
  it.each(['https', 'http'])('validates original %s bytes with a matching receipt', async (protocol) => {
    const bytes = fixture(protocol);
    const res = await request(makeApp()).post('/api/json/validate-upload')
      .field('expected_file_sha256', metadata(bytes).expected_file_sha256).field('expected_byte_count', String(bytes.length))
      .attach('file', bytes, 'adagents.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.structuredContent).toMatchObject({ byte_count: bytes.length, sha256: metadata(bytes).expected_file_sha256 });
    expect(res.body.structuredContent.validation).toContain(protocol === 'https' ? '✅ **Valid!' : '/authoritative_location: must match pattern');
  });
  it('rejects altered multipart bytes before schema requests', async () => {
    const original = fixture();
    const changed = fixture('http');
    const res = await request(makeApp()).post('/api/json/validate-upload')
      .field('expected_file_sha256', metadata(original).expected_file_sha256).field('expected_byte_count', String(changed.length))
      .attach('file', changed, 'adagents.json');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('do not match');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('does not expose raw schema diagnostics through the anonymous API', async () => {
    const bytes = fixture();
    const res = await request(makeApp()).post('/api/json/validate-upload')
      .field('expected_file_sha256', metadata(bytes).expected_file_sha256).field('expected_byte_count', String(bytes.length))
      .field('version', 'synthetic-private-diagnostic').attach('file', bytes, 'adagents.json');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('published AdCP schema');
    expect(res.body.error).not.toContain('synthetic-private-diagnostic');
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('accepts both explicit schema options with the required integrity metadata', async () => {
    const bytes = fixture();
    const res = await request(makeApp()).post('/api/json/validate-upload')
      .field('expected_file_sha256', metadata(bytes).expected_file_sha256).field('expected_byte_count', String(bytes.length))
      .field('schema_path', 'adagents.json').field('version', 'v3').attach('file', bytes, 'adagents.json');
    expect(res.status).toBe(200);
    expect(res.body.structuredContent.sha256).toBe(metadata(bytes).expected_file_sha256);
  });
  it('rejects oversized uploads, excess fields, and additional files', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/json/validate-upload').attach('file', Buffer.alloc(MAX_JSON_FILE_BYTES + 1), 'adagents.json')).status).toBe(413);
    expect((await request(app).post('/api/json/validate-upload').field('a', 'a').field('b', 'b').field('c', 'c').field('d', 'd').field('e', 'e')).status).toBe(400);
    expect((await request(app).post('/api/json/validate-upload').attach('file', fixture(), 'a.json').attach('file', fixture(), 'b.json')).status).toBe(400);
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('requires a file, multipart transport, and both integrity fields', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/json/validate-upload').send({ json: {} })).status).toBe(400);
    expect((await request(app).post('/api/json/validate-upload').field('expected_byte_count', '1')).status).toBe(400);
    expect((await request(app).post('/api/json/validate-upload').attach('file', fixture(), 'adagents.json')).status).toBe(400);
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('applies its rate limiter before validation', async () => {
    limit.blocked = true;
    expect((await request(makeApp()).post('/api/json/validate-upload').attach('file', fixture(), 'adagents.json')).status).toBe(429);
    expect(schemaFetch).not.toHaveBeenCalled();
  });
  it('keeps CSRF protection and accepts the browser cookie/header pair', async () => {
    const app = makeApp(true);
    const agent = request.agent(app);
    const page = await agent.get('/picker');
    const cookies = page.headers['set-cookie'] as unknown as string[];
    const token = cookies[0].split(';')[0].slice('csrf-token='.length);
    const bytes = fixture();
    const denied = await agent.post('/api/json/validate-upload').attach('file', bytes, 'adagents.json');
    expect(denied.status).toBe(403);
    const accepted = await agent.post('/api/json/validate-upload').set('X-CSRF-Token', token)
      .field('expected_file_sha256', metadata(bytes).expected_file_sha256).field('expected_byte_count', String(bytes.length))
      .attach('file', bytes, 'adagents.json');
    expect(accepted.status).toBe(200);
    expect(accepted.body.structuredContent.sha256).toBe(metadata(bytes).expected_file_sha256);
  });
});
