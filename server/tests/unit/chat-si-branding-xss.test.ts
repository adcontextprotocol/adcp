import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const chatHtml = readFileSync(join(process.cwd(), 'server/public/chat.html'), 'utf8');

interface BrandHeaderElements {
  header: HTMLElement;
  icon: HTMLElement;
  title: HTMLElement;
  tagline: HTMLElement;
}

interface SiBranding {
  renderHeader: (
    elements: BrandHeaderElements,
    brand: { name?: unknown; tagline?: unknown; logo_url?: unknown; brand_color?: unknown } | null,
    fallbackName?: unknown,
  ) => void;
  safeLogoUrl: (value: unknown) => string | null;
  safeBrandColor: (value: unknown) => string | null;
}

interface SessionSummary {
  session_id: string;
  brand_name: string;
  status: string;
  message_count: number;
  last_activity_at: string;
  brand_color: unknown;
  brand_logo_url: unknown;
}

interface SessionDetail {
  brand: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
}

type ChatWindow = Window & typeof globalThis & {
  siBranding: SiBranding;
  fetch: typeof fetch;
  matchMedia: (query: string) => MediaQueryList;
  __ENABLE_SI_CHAT_TEST_HOOKS__: boolean;
  __siChatTestHooks: {
    openSession: (session: { session_id: string; brand_name: string }) => Promise<void>;
  };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname + input.search;
  return new URL(input.url).pathname + new URL(input.url).search;
}

function createDom(options: {
  sessions?: SessionSummary[];
  details?: Record<string, SessionDetail>;
} = {}): JSDOM {
  const sessions = options.sessions ?? [];
  const details = options.details ?? {};

  return new JSDOM(chatHtml, {
    url: 'https://example.test/chat.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      const chatWindow = window as unknown as ChatWindow;
      chatWindow.__ENABLE_SI_CHAT_TEST_HOOKS__ = true;
      chatWindow.fetch = (async (input: RequestInfo | URL) => {
        const path = requestPath(input);
        if (path === '/api/addie/chat/status') return jsonResponse({ ready: true });
        if (path === '/api/me') return jsonResponse({ user: { id: 'user_test', email: 'user@example.test' } });
        if (path.startsWith('/api/me/addie-home')) return jsonResponse({ css: '', html: '' });
        if (path === '/api/addie/chat/threads') return jsonResponse({ conversations: [] });
        if (path === '/api/si/sessions/user') return jsonResponse({ sessions });
        if (path.startsWith('/api/si/sessions/')) {
          const sessionId = path.split('/').pop()!;
          const detail = details[sessionId];
          return detail ? jsonResponse(detail) : jsonResponse({ error: 'Not found' }, 404);
        }
        return jsonResponse({ error: 'Not found' }, 404);
      }) as typeof fetch;
      chatWindow.matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    },
  });
}

async function waitForElement(document: Document, selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const element = document.querySelector(selector);
    if (element) return element;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

describe('Sponsored chat brand header XSS hardening', () => {
  let dom: JSDOM | null = null;

  afterEach(() => {
    dom?.window.close();
    dom = null;
  });

  it('renders quote-breaking and event-handler payloads as inert DOM properties', () => {
    dom = createDom();
    const window = dom.window as unknown as ChatWindow;
    const elements = {
      header: window.document.getElementById('siModalHeader')!,
      icon: window.document.getElementById('siModalIconEmoji')!,
      title: window.document.getElementById('siModalTitle')!,
      tagline: window.document.getElementById('siModalTagline')!,
    };
    const hostileName = 'Nova\"><img src=x onerror="window.__brandPwned=true">';

    window.siBranding.renderHeader(elements, {
      name: hostileName,
      tagline: '<svg onload="window.__taglinePwned=true">',
      logo_url: 'https://cdn.example.test/logo.png',
      brand_color: '#123456',
    });

    const image = elements.icon.querySelector('img');
    expect(elements.title.textContent).toBe(hostileName);
    expect(elements.tagline.textContent).toBe('<svg onload="window.__taglinePwned=true">');
    expect(image?.alt).toBe(hostileName);
    expect(image?.hasAttribute('onerror')).toBe(false);
    expect(elements.icon.querySelectorAll('svg, script')).toHaveLength(0);
    expect((window as unknown as { __brandPwned?: boolean }).__brandPwned).toBeUndefined();
  });

  it('executes legacy history rendering and resume without creating attacker-controlled DOM', async () => {
    const hostileName = '\"><img src=x onerror="window.__historyPwned=true">';
    const hostileTagline = '<svg onload="window.__taglinePwned=true">';
    dom = createDom({
      sessions: [{
        session_id: 'legacy-session',
        brand_name: hostileName,
        status: 'active',
        message_count: 1,
        last_activity_at: '2026-07-29T12:00:00.000Z',
        brand_color: '#123456\" onmouseover=\"window.__stylePwned=true',
        brand_logo_url: 'https://cdn.example.test/history.png" onerror="window.__logoPwned=true',
      }],
      details: {
        'legacy-session': {
          brand: {
            name: hostileName,
            tagline: hostileTagline,
            logo_url: 'https://cdn.example.test/resume.png" onerror="window.__resumePwned=true',
            brand_color: '#123456; background: url(javascript:alert(1))',
          },
          messages: [],
        },
      },
    });
    const window = dom.window as unknown as ChatWindow;
    const historyItem = await waitForElement(window.document, '.history-item.si-branded') as HTMLElement;

    expect(historyItem.querySelector('img, script, svg, [onerror], [onmouseover]')).toBeNull();
    expect(historyItem.querySelector('.si-brand-name')?.textContent).toBe(hostileName);
    expect(historyItem.style.length).toBe(1);
    expect(historyItem.style.getPropertyValue('--si-item-color')).toBe('var(--color-brand)');
    expect(historyItem.style.background).toBe('');

    historyItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const title = window.document.getElementById('siModalTitle')!;
    for (let attempt = 0; attempt < 100 && title.textContent !== hostileName; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const icon = window.document.getElementById('siModalIconEmoji')!;
    const tagline = window.document.getElementById('siModalTagline')!;
    const header = window.document.getElementById('siModalHeader')!;
    expect(title.textContent).toBe(hostileName);
    expect(tagline.textContent).toBe(hostileTagline);
    expect(icon.querySelector('img, script, svg, [onerror]')).toBeNull();
    expect(tagline.querySelector('svg, script, [onload]')).toBeNull();
    expect(header.style.getPropertyValue('--si-brand-color')).toBe('');
    expect((window as unknown as Record<string, unknown>).__historyPwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__stylePwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__resumePwned).toBeUndefined();
  });

  it('executes the new-session modal path and clears stale branding before the next brand', async () => {
    const hostileName = 'Hostile\"><img src=x onerror="window.__newSessionPwned=true">';
    dom = createDom({
      details: {
        'valid-session': {
          brand: {
            name: 'Nova',
            tagline: 'Helpful recommendations',
            logo_url: 'https://cdn.example.test/brand/logo.svg?theme=dark',
            brand_color: '#12Ab9F',
          },
          messages: [],
        },
        'hostile-session': {
          brand: {
            name: hostileName,
            tagline: '<svg onload="window.__newTaglinePwned=true">',
            logo_url: 'javascript:window.__newLogoPwned=true',
            brand_color: '#123456; background: red',
          },
          messages: [],
        },
      },
    });
    const window = dom.window as unknown as ChatWindow;
    const header = window.document.getElementById('siModalHeader')!;
    const icon = window.document.getElementById('siModalIconEmoji')!;
    const title = window.document.getElementById('siModalTitle')!;
    const tagline = window.document.getElementById('siModalTagline')!;

    await window.__siChatTestHooks.openSession({ session_id: 'valid-session', brand_name: 'Nova' });
    expect(header.style.getPropertyValue('--si-brand-color')).toBe('#12Ab9F');
    expect(icon.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.test/brand/logo.svg?theme=dark');

    await window.__siChatTestHooks.openSession({ session_id: 'hostile-session', brand_name: hostileName });
    expect(title.textContent).toBe(hostileName);
    expect(tagline.textContent).toBe('<svg onload="window.__newTaglinePwned=true">');
    expect(header.style.getPropertyValue('--si-brand-color')).toBe('');
    expect(icon.querySelector('img, script, svg, [onerror]')).toBeNull();
    expect(icon.textContent).toBe('H');
    expect(tagline.querySelector('svg, script, [onload]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__newSessionPwned).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__newLogoPwned).toBeUndefined();
  });
});
