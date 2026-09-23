import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';

const html = readFileSync('server/public/chat.html', 'utf8');
const models = readFileSync('server/public/chat-model-selection.js', 'utf8');
const csrf = readFileSync('server/public/csrf.js', 'utf8');
const id = 'a94c88c0-f379-4a1d-826d-4d9b251838e0';
let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.restoreAllMocks(); });
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const sse = (event: string, body: unknown) => new Response(
  `event: meta\ndata: {"conversation_id":"test-thread"}\n\nevent: ${event}\ndata: ${JSON.stringify(body)}\n\n`,
  { headers: { 'Content-Type': 'text/event-stream', 'X-Request-ID': id } },
);

async function openChat(reply: (attempt: number) => Response, organization?: string, csrfRetry = false) {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/chat', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.eval(models);
      window.marked = marked;
      window.DOMPurify = createDOMPurify(window);
      window.TextDecoder = TextDecoder;
      window.Headers = Headers;
      window.matchMedia = (() => ({ matches: false, addEventListener() {} })) as any;
      if (organization !== undefined) window.localStorage.setItem('selectedOrgId', organization);
      window.fetch = (async (url: string, options?: RequestInit) => {
        if (url === '/api/me') return json({ user: { id: 'member' } });
        if (url === '/api/addie/chat/status') return json({ ready: true, model_selection: { enabled: false } });
        if (url.startsWith('/api/me/addie-home')) return json({ html: '', css: '' });
        if (url === '/api/addie/chat/threads') return json({ conversations: [] });
        if (url === '/api/si/sessions/user') return json({ sessions: [] });
        if (url === '/api/addie/chat/stream') {
          requests.push({ body: JSON.parse(String(options?.body)), headers: new Headers(options?.headers) });
          return reply(requests.length);
        }
        return json({}, 404);
      }) as typeof fetch;
      if (csrfRetry) window.eval(csrf);
    },
  });
  const window = dom.window;
  const input = window.document.getElementById('chatInput') as HTMLTextAreaElement;
  await vi.waitFor(() => expect(input.disabled).toBe(false));
  input.value = 'Help me understand AdCP';
  input.dispatchEvent(new window.Event('input'));
  await vi.waitFor(() => expect((window.document.getElementById('sendButton') as HTMLButtonElement).disabled).toBe(false));
  window.document.getElementById('sendButton')!.click();
  await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
  return { document: window.document, requests };
}

describe('chat requests and actionable failure UI', () => {
  it.each([undefined, '', '   '])('omits an absent/empty organization selector (%s)', async (org) => {
    const { requests } = await openChat(() => json({}, 403), org);
    expect(requests[0].body).not.toHaveProperty('organization_id');
    expect(requests[0].headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[0].body.client_request_id).not.toBe(requests[0].headers.get('X-Request-ID'));
  });

  it('retains a selected organization without inferring another one', async () => {
    const { requests } = await openChat(() => json({}, 403), 'org_selected');
    expect(requests[0].body.organization_id).toBe('org_selected');
  });

  it.each([
    [401, { error: 'Invalid session' }, 'Your session has expired'],
    [403, { error: 'An unambiguous organization selection is required' }, 'Choose your organization again'],
    [403, { error: 'CSRF validation failed' }, 'Refresh this page'],
    [403, { message: 'Sign in to choose a model.' }, 'Sign in to choose a model.'],
    [401, { error: { message: 'Your session expired. Please sign in again.' } }, 'Your session expired. Please sign in again.'],
  ])('renders HTTP %s safely with a persistent support reference', async (status, body, text) => {
    const { document } = await openChat(() => json(body, status as number, { 'X-Request-ID': id }));
    await vi.waitFor(() => expect(document.querySelector('.chat-request-error')?.textContent).toContain(text));
    expect(document.querySelector('.chat-request-reference')?.textContent).toContain(id);
    if (status === 401) expect(document.querySelector('.chat-request-error a')?.getAttribute('href')).toBe('/auth/login?return_to=/chat');
  });

  it.each([
    () => json({ error: { stack: 'private stack', message: 'postgres://secret' }, message: 'private stack' }, 500),
    () => json({ message: '<script>private stack</script>', error: { stack: 'private stack' } }, 403),
    () => new Response('<html>private stack</html>', { status: 502 }),
    () => json(null, 401),
    () => json(['private stack'], 403),
  ])('does not render internal errors, HTML, or malformed error shapes', async (reply) => {
    const { document } = await openChat(reply);
    await vi.waitFor(() => expect(document.querySelector('.chat-request-error')).not.toBeNull());
    expect(document.querySelector('.chat-request-error')?.textContent).not.toMatch(/private stack|postgres|\[object Object\]/);
    expect(document.querySelector('.chat-request-error script')).toBeNull();
  });

  it('uses a valid body correlation ID and rejects unsafe IDs', async () => {
    const { document } = await openChat(() => json({ error: 'Invalid session', request_id: id }, 401));
    await vi.waitFor(() => expect(document.querySelector('.chat-request-reference')?.textContent).toContain(id));
  });

  it('replaces invalid server correlation IDs with the safe client attempt ID', async () => {
    const { document, requests } = await openChat(() => json({ request_id: '<script>secret</script>' }, 403, { 'X-Request-ID': 'sam@example.test' }));
    await vi.waitFor(() => expect(document.querySelector('.chat-request-reference')?.textContent).toContain(requests[0].headers.get('X-Request-ID')));
    expect(document.querySelector('.chat-request-reference')?.textContent).not.toMatch(/script|sam@/);
  });

  it('preserves recoverable SSE continuation and correlates each transport attempt', async () => {
    const { document, requests } = await openChat(() => sse('stream_error', { error: { message: 'private stack' }, recoverable: true }));
    await vi.waitFor(() => expect(document.querySelector('.reply-recovery__action')).not.toBeNull());
    expect(document.querySelector('.reply-recovery')?.textContent).not.toContain('private stack');
    expect(document.querySelector('.reply-recovery .chat-request-reference')?.textContent).toContain(id);
    (document.querySelector('.reply-recovery__action') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body).toMatchObject({ retry: true, client_request_id: requests[0].body.client_request_id });
    expect(requests[1].headers.get('X-Request-ID')).not.toBe(requests[0].headers.get('X-Request-ID'));
  });

  it('does not promote an explicitly nonrecoverable stream error into a retry', async () => {
    const { document } = await openChat(() => sse('stream_error', { reason: 'checkpoint_persistence_failed', recoverable: false }));
    await vi.waitFor(() => expect(document.querySelector('.chat-request-error')?.textContent).toContain('Review the action before trying again'));
    expect(document.querySelector('.reply-recovery__action')).toBeNull();
  });

  it('keeps network EOFs recoverable after a conversation was assigned', async () => {
    const { document } = await openChat(() => sse('text', { text: 'Partial reply' }));
    await vi.waitFor(() => expect(document.querySelector('.reply-recovery__action')).not.toBeNull());
    expect(document.querySelector('.chat-request-reference')?.textContent).toContain(id);
  });

  it('retries a CSRF cookie-expiry 403 once using its fresh token and preserves correlation', async () => {
    const token = 'a'.repeat(64);
    const { document, requests } = await openChat((attempt) => attempt === 1
      ? json({ error: 'CSRF validation failed', token }, 403, { 'X-CSRF-Retry': 'true' })
      : json({ error: 'An unambiguous organization selection is required' }, 403, { 'X-Request-ID': id }), undefined, true);
    await vi.waitFor(() => expect(document.querySelector('.chat-request-error')?.textContent).toContain('Choose your organization again'));
    expect(requests).toHaveLength(2);
    expect(requests[1].headers.get('X-CSRF-Token')).toBe(token);
    expect(requests[1].headers.get('X-Request-ID')).toBe(requests[0].headers.get('X-Request-ID'));
    expect(requests[1].body).toEqual(requests[0].body);
  });
});
