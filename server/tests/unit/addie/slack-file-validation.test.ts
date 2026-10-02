import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUrlToolHandlers } from '../../../src/addie/mcp/url-tools.js';

const fileUrl = 'https://files.slack.com/files-pri/T_TEST-F_UPLOAD/adagents.json';
const handlers = createUrlToolHandlers('test-bot-token');
let uploadedText = '';
let contentLength: string | undefined;
const schemaRequests: string[] = [];

beforeEach(() => {
  uploadedText = '';
  contentLength = undefined;
  schemaRequests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === fileUrl) {
      return new Response(uploadedText, {
        headers: { 'Content-Type': 'application/json', ...(contentLength && { 'Content-Length': contentLength }) },
      });
    }
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://adcontextprotocol.org');
    schemaRequests.push(parsed.pathname);
    return new Response(readFileSync(new URL(`../../../..${parsed.pathname.replace('/schemas/', '/dist/schemas/')}`, import.meta.url)), {
      headers: { 'Content-Type': 'application/json' },
    });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('uploaded adagents.json validation', () => {
  it('validates the whole document against the published schema without copying a truncated preview', async () => {
    uploadedText = JSON.stringify({
      $schema: 'https://adcontextprotocol.org/schemas/3.2.1/adagents.json',
      authoritative_location: 'https://publisher.example.com/adagents.json',
      padding: 'x'.repeat(30_000),
    });
    const result = await handlers.read_slack_file({ file_url: fileUrl, file_name: 'adagents.json' });
    expect(result).toContain('Complete uploaded adagents.json schema validation');
    expect(result).toContain('✅ **Valid!**');
    expect(result).toContain('/schemas/3.2.1/adagents.json');
    expect(result).toContain(`${Buffer.byteLength(uploadedText)} bytes checked`);
    expect(result).toContain('agent endpoint reachability and live publisher authorization were not checked');
    expect(result).not.toContain('[Content truncated');
    expect(result.length).toBeLessThan(10_000);
    expect(schemaRequests).toContain('/schemas/3.2.1/adagents.json');
    expect(fetch).toHaveBeenCalledWith(fileUrl, expect.objectContaining({ headers: { Authorization: 'Bearer test-bot-token' } }));
  });

  it('catches a schema error beyond the previous 10,000-character cutoff', async () => {
    uploadedText = JSON.stringify({ padding: 'x'.repeat(30_000), authoritative_location: 'http://publisher.example.com/adagents.json' });
    const result = await handlers.read_slack_file({ file_url: fileUrl, file_name: 'adagents.json' });
    expect(result).toContain('❌ **Invalid.**');
    expect(result).toContain('/authoritative_location');
  });

  it('reports malformed JSON at the end of a large upload', async () => {
    uploadedText = `{"padding":"${'x'.repeat(30_000)}",}`;
    await expect(handlers.read_slack_file({ file_url: fileUrl, file_name: 'adagents.json' }))
      .rejects.toThrow('not valid JSON');
  });

  it.each([undefined, '1'])('enforces the streaming size limit with content-length %s', async length => {
    contentLength = length;
    uploadedText = 'x'.repeat(500 * 1024 + 1);
    await expect(handlers.read_slack_file({ file_url: fileUrl, file_name: 'adagents.json' }))
      .rejects.toThrow('exceeded 500KB limit');
  });

  it('preserves ordinary text-file reading', async () => {
    uploadedText = 'Publisher configuration notes';
    expect(await handlers.read_slack_file({ file_url: fileUrl, file_name: 'notes.txt' })).toBe(`File content:\n\n${uploadedText}`);
  });

  it('infers the filename from a private download URL when it was not supplied', async () => {
    uploadedText = JSON.stringify({ authoritative_location: 'https://publisher.example.com/adagents.json' });
    expect(await handlers.read_slack_file({ file_url: fileUrl })).toContain('✅ **Valid!**');
  });

  it('keeps the timeout active when a text download stalls after response headers', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockImplementationOnce(async (_url, options) => new Response(new ReadableStream({
        start(controller) {
          options?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
        },
      }), { headers: { 'Content-Type': 'application/json' } }));
      const failure = expect(handlers.read_slack_file({ file_url: fileUrl, file_name: 'adagents.json' }))
        .rejects.toThrow('Request timed out after 10 seconds');
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });
});
