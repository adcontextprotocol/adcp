import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fileFetch = vi.hoisted(() => vi.fn());
const resolve4 = vi.hoisted(() => vi.fn());
const resolve6 = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(), fetch: fileFetch,
}));
vi.mock('dns/promises', () => ({ default: { resolve4, resolve6 } }));

import { JSON_FILE_VALIDATION_TOOL, validateJsonFile } from '../../src/mcp/json-file-validation.js';
import { SCHEMA_TOOL_DEFINITIONS } from '../../src/mcp/exposed-tools.js';

const file = { download_url: 'https://files.example.com/upload.json?signature=private', file_id: 'fixture-upload' };
const args = { file, schema_path: 'adagents.json' };
const schemaFetch = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://adcontextprotocol.org') throw new Error('Unexpected schema host');
  return new Response(readFileSync(resolve(import.meta.dirname, '../../../dist', url.pathname.slice(1)), 'utf8'), {
    headers: { 'content-type': 'application/json' },
  });
});

beforeEach(() => {
  fileFetch.mockReset();
  resolve4.mockResolvedValue(['93.184.216.34']);
  resolve6.mockResolvedValue([]);
  vi.stubGlobal('fetch', schemaFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('complete-file MCP validation', () => {
  it.each(['https', 'http'])('validates the original large file including its %s URL at the end', async (protocol) => {
    const original = {
      $schema: 'https://adcontextprotocol.org/schemas/3.2.1/adagents.json',
      ext: { padding: Array.from({ length: 500 }, () => 'x'.repeat(60)) },
      authoritative_location: `${protocol}://publisher.example.com/adagents.json`,
    };
    const text = JSON.stringify(original, null, 2);
    fileFetch.mockResolvedValueOnce(new Response(text));
    const result = await validateJsonFile({ file });
    expect(result.structuredContent.byte_count).toBe(Buffer.byteLength(text));
    expect(result.structuredContent.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(result.structuredContent.validation).toContain(protocol === 'https' ? '✅ **Valid!' : '/authoritative_location: must match pattern');
    expect(fileFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).not.toContain('x'.repeat(60));
  });

  it('infers adagents.json from client filename and hashes the original UTF-8 bytes including BOM', async () => {
    const text = '\uFEFF' + JSON.stringify({ authoritative_location: 'https://publisher.example.com/adagents.json', ext: { label: 'café' } });
    fileFetch.mockResolvedValueOnce(new Response(text));
    const result = await validateJsonFile({ file: { ...file, file_name: 'adagents.json' } });
    expect(result.structuredContent.validation).toContain('✅ **Valid!');
    expect(result.structuredContent.byte_count).toBe(Buffer.byteLength(text));
    expect(result.structuredContent.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it.each(['{"authoritative_location":"https://publisher.example.com/adagents.json"} garbage', '\u0000', '\uFFFD'])('rejects malformed JSON without returning a partial validation result', async (text) => {
    fileFetch.mockResolvedValueOnce(new Response(text));
    await expect(validateJsonFile(args)).rejects.toThrow('valid UTF-8 JSON');
  });

  it('rejects invalid UTF-8 before JSON validation', async () => {
    fileFetch.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])));
    await expect(validateJsonFile(args)).rejects.toThrow('valid UTF-8 JSON');
  });

  it('does not claim a validation when no schema can be selected', async () => {
    fileFetch.mockResolvedValueOnce(new Response('{}'));
    await expect(validateJsonFile({ file })).rejects.toThrow('Cannot determine schema');
  });

  it('rejects an oversized declared body and cancels the download', async () => {
    const response = new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    fileFetch.mockResolvedValueOnce(response);
    await expect(validateJsonFile(args)).rejects.toThrow('5 MiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('enforces the byte cap while streaming even with a misleading content length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); },
      cancel,
    });
    fileFetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-length': '2' } }));
    await expect(validateJsonFile(args)).rejects.toThrow('5 MiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds stalled DNS preflight as well as body downloads', async () => {
    vi.useFakeTimers();
    resolve4.mockImplementationOnce(() => new Promise(() => {}));
    resolve6.mockImplementationOnce(() => new Promise(() => {}));
    const result = expect(validateJsonFile(args)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await result;
    expect(fileFetch).not.toHaveBeenCalled();
  });

  it('keeps the deadline active while the response body stalls', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fileFetch.mockImplementationOnce((_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) {
        signal!.addEventListener('abort', () => controller.error(new Error('aborted')));
      } }));
    });
    const result = expect(validateJsonFile(args)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it('follows a public HTTPS CDN redirect without sending Addie credentials', async () => {
    fileFetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://cdn.example.net/original.json' } }))
      .mockResolvedValueOnce(new Response('{"authoritative_location":"https://publisher.example.com/adagents.json"}'));
    await validateJsonFile(args);
    expect(fileFetch).toHaveBeenCalledTimes(2);
    expect(fileFetch.mock.calls[1][0]).toBe('https://cdn.example.net/original.json');
    for (const [, options] of fileFetch.mock.calls) expect(options.headers).not.toHaveProperty('Authorization');
  });

  it.each(['http://files.example.com/file', 'https://user:password@files.example.com/file', 'file:///tmp/adagents.json'])('rejects unsafe URL %s before fetching', async (download_url) => {
    await expect(validateJsonFile({ ...args, file: { ...file, download_url } })).rejects.toThrow('HTTPS');
    expect(fileFetch).not.toHaveBeenCalled();
  });

  it('rejects a public hostname that resolves to an internal address', async () => {
    resolve4.mockResolvedValueOnce(['127.0.0.1']);
    await expect(validateJsonFile(args)).rejects.toThrow('public host');
    expect(fileFetch).not.toHaveBeenCalled();
  });

  it.each(['https://127.0.0.1/private', 'http://files.example.com/downgrade', 'https://user:password@files.example.com/private'])('rejects unsafe redirect %s', async (location) => {
    fileFetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location } }));
    await expect(validateJsonFile(args)).rejects.toThrow();
    expect(fileFetch).toHaveBeenCalledTimes(1);
  });

  it('reports expired download links without exposing their contents or signatures', async () => {
    fileFetch.mockResolvedValueOnce(new Response('secret response', { status: 403 }));
    await expect(validateJsonFile(args)).rejects.toThrow('HTTP 403');
  });

  it('does not echo signed URLs from underlying network errors', async () => {
    fileFetch.mockRejectedValueOnce(new Error(`Failed fetch: ${file.download_url}`));
    await expect(validateJsonFile(args)).rejects.toThrow('Could not download the file.');
  });

  it('publishes the complete ChatGPT file contract without losing descriptor metadata', () => {
    const descriptor = SCHEMA_TOOL_DEFINITIONS.find(tool => tool.name === 'validate_json_file');
    expect(descriptor).toBe(JSON_FILE_VALIDATION_TOOL);
    expect(JSON_FILE_VALIDATION_TOOL._meta['openai/fileParams']).toEqual(['file']);
    const schema = JSON_FILE_VALIDATION_TOOL.inputSchema.properties.file;
    expect(Object.keys(schema.properties).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
    expect(schema.required).toEqual(['download_url', 'file_id']);
  });
});
