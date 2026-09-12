import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';

const html = readFileSync(join(process.cwd(), 'server/public/chat.html'), 'utf8');
const helper = readFileSync(join(process.cwd(), 'server/public/chat-model-selection.js'), 'utf8');
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); });

function openChat(authenticated = true, geminiAvailable = true, storage: Record<string, string> = {}) {
  const requests: Array<Record<string, any>> = [];
  const infos: Array<Record<string, unknown>> = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  dom = new JSDOM(html, {
    url: 'https://example.test/chat', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.eval(helper);
      window.marked = marked;
      window.DOMPurify = createDOMPurify(window);
      window.TextDecoder = TextDecoder;
      window.matchMedia = (() => ({ matches: false, addEventListener() {} })) as any;
      Object.entries(storage).forEach(([key, value]) => window.localStorage.setItem(key, value));
      window.fetch = (async (input: string, options?: RequestInit) => {
        if (input === '/api/me') return json({ user: { id: 'member' } }, authenticated ? 200 : 401);
        if (input === '/api/addie/chat/status') return json({ ready: true, model_selection: { enabled: authenticated, gemini_available: geminiAvailable } });
        if (input.startsWith('/api/me/addie-home')) return json({ html: '', css: '' });
        if (input === '/api/addie/chat/threads') return json({ conversations: [] });
        if (input === '/api/si/sessions/user') return json({ sessions: [] });
        if (input === '/api/addie/chat/test-thread') return json({ model_preference: 'gemini',
          messages: [{ role: 'assistant', message_id: 'saved-answer', content: 'Saved answer',
            model_info: { selected: 'gemini', source: 'provider', model: 'claude-sonnet-4-6', fallback: true, latency_ms: 3000 } }] });
        if (input === '/api/addie/chat/stream') {
          const body = JSON.parse(String(options?.body));
          requests.push(body);
          const info = { selected: body.model_preference, source: 'provider',
            model: body.model_preference === 'sonnet' ? 'claude-sonnet-4-6' : 'gemini-3.7-flash', latency_ms: 1200, fallback: false };
          infos.push(info);
          const events = [ ['meta', { conversation_id: 'test-thread' }], ['text', { text: 'Verified answer.' }],
            ['done', { conversation_id: 'test-thread', message_id: `answer-${requests.length}`, model_info: info }] ];
          return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
            { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return json({}, 404);
      }) as typeof fetch;
    },
  });
  return { window: dom.window, requests, infos };
}

describe('Web chat model selector', () => {
  it('switches models for the next message in one chat and resets new chats to Default', async () => {
    const { window, requests } = openChat();
    const doc = window.document;
    const select = doc.getElementById('modelSelect') as HTMLSelectElement;
    const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
    await vi.waitFor(() => expect(doc.getElementById('modelSelector')?.hidden).toBe(false));
    for (const choice of ['gemini', 'sonnet', 'default']) {
      select.value = choice;
      select.dispatchEvent(new window.Event('change'));
      input.value = 'Explain AdCP';
      input.dispatchEvent(new window.Event('input'));
      doc.getElementById('sendButton')!.click();
      await vi.waitFor(() => expect(doc.querySelectorAll('.message-model')).toHaveLength(requests.length));
      await vi.waitFor(() => expect(select.disabled).toBe(false));
      expect(requests.at(-1)?.model_preference).toBe(choice);
    }
    expect(requests).toHaveLength(3);
    expect(requests[1].conversation_id).toBe('test-thread');
    expect([...doc.querySelectorAll('.message-model')].map(el => el.textContent))
      .toEqual(['Gemini 3.7 · 1.2s', 'Sonnet · 1.2s', 'Gemini 3.7 · 1.2s']);
    select.value = 'sonnet';
    select.dispatchEvent(new window.Event('change'));
    expect(JSON.parse(window.localStorage.getItem('addie_active_tabs')!)[0].modelPreference).toBe('sonnet');
    doc.getElementById('newChatBtn')!.click();
    expect(select.value).toBe('default');
  });

  it('restores the per-chat choice and the actual fallback model from history after reload', async () => {
    const { window } = openChat(true, true, {
      addie_current_tab: 'test-thread',
      addie_active_tabs: JSON.stringify([{ id: 'test-thread', title: 'Test chat', channel: 'web', modelPreference: 'sonnet' }]),
    });
    await vi.waitFor(() => expect(window.document.querySelector('.message-model')?.textContent).toBe('Gemini 3.7 → Sonnet · 3.0s'));
    expect((window.document.getElementById('modelSelect') as HTMLSelectElement).value).toBe('sonnet');
  });

  it('hides selection for anonymous users and disables Gemini when unavailable', async () => {
    const anonymous = openChat(false).window;
    await vi.waitFor(() => expect(anonymous.document.getElementById('anonymous-banner')?.classList.contains('active')).toBe(true));
    expect(anonymous.document.getElementById('modelSelector')?.hidden).toBe(true);
    anonymous.close();
    const { window } = openChat(true, false);
    await vi.waitFor(() => expect(window.document.getElementById('modelSelector')?.hidden).toBe(false));
    expect((window.document.querySelector('#modelSelect [value="gemini"]') as HTMLOptionElement).disabled).toBe(true);
  });

  it('renders provider strings as text without executing markup', () => {
    const { window } = openChat();
    const container = window.document.createElement('div');
    (window as any).AddieChatModels.appendInfo(container, {
      selected: 'default', source: 'provider', model: '<img src=x onerror=alert(1)>', fallback: false,
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('labels a provider-error fallback separately from the selected model', () => {
    const { window } = openChat();
    const container = window.document.createElement('div');
    (window as any).AddieChatModels.appendInfo(container, {
      selected: 'gemini', source: 'provider', model: 'claude-sonnet-5', fallback: true,
      fallback_reason: 'primary_unavailable', latency_ms: 3000,
    });
    expect(container.textContent).toBe('Gemini 3.7 → Sonnet · provider fallback · 3.0s');
  });
});
