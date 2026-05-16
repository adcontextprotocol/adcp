import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlPath = resolve(__dirname, '../../server/public/adagents-builder.html');
const htmlContent = readFileSync(htmlPath, 'utf-8');

interface BuilderWindow extends Window {
  displayValidationResults: (data: unknown) => void;
  displayAgentCardsResults: (cards: unknown[]) => void;
  escapeHtml: (s: string) => string;
  state: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

function createDOM(): JSDOM & { window: BuilderWindow } {
  const dom = new JSDOM(htmlContent, {
    url: 'https://example.test/adagents-builder.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  // Stub fetch (the page may call /api endpoints on load).
  (dom.window as unknown as BuilderWindow).fetch = () =>
    Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) as unknown as Promise<Response>;
  return dom as JSDOM & { window: BuilderWindow };
}

describe('adagents-builder: XSS hardening on imported markup', () => {
  let win: BuilderWindow;
  let dom: JSDOM;

  beforeEach(() => {
    dom = createDOM();
    win = (dom as JSDOM & { window: BuilderWindow }).window;
  });

  it('escapes script tags in agent card name field (displayValidationResults)', () => {
    const hostile = {
      domain: 'attacker.test',
      found: true,
      validation: {
        valid: true,
        url: 'https://attacker.test/.well-known/adagents.json',
        errors: [],
        warnings: [],
      },
      agent_cards: [
        {
          valid: true,
          agent_url: 'https://attacker.test/agent',
          card_data: {
            name: '<script>window.__pwned = true;</script>',
          },
          card_endpoint: 'https://attacker.test/agent/.well-known/agent-card.json',
          response_time_ms: 50,
          status_code: 200,
          errors: [],
        },
      ],
    };

    win.displayValidationResults(hostile);

    const results = win.document.getElementById('validation-results') as HTMLElement;
    // No <script> element should have been parsed into the DOM
    expect(results.querySelectorAll('script').length).toBe(0);
    // And the hostile global side-effect must not have fired
    expect((win as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    // The text content should still contain the escaped representation
    expect(results.textContent).toContain('<script>window.__pwned = true;</script>');
  });

  it('escapes event handlers in validation errors and warnings (displayValidationResults)', () => {
    const hostile = {
      domain: 'attacker.test',
      found: true,
      validation: {
        valid: false,
        url: 'https://attacker.test/.well-known/adagents.json',
        errors: [
          {
            field: '<img src=x onerror="window.__errPwned = true">',
            message: 'plain message',
          },
        ],
        warnings: [
          {
            field: 'warnField',
            message: '<img src=x onerror="window.__warnPwned = true">',
            suggestion: '<img src=x onerror="window.__sugPwned = true">',
          },
        ],
      },
      agent_cards: [],
    };

    win.displayValidationResults(hostile);

    const results = win.document.getElementById('validation-results') as HTMLElement;
    expect(results.querySelectorAll('img').length).toBe(0);
    const w = win as unknown as { __errPwned?: boolean; __warnPwned?: boolean; __sugPwned?: boolean };
    expect(w.__errPwned).toBeUndefined();
    expect(w.__warnPwned).toBeUndefined();
    expect(w.__sugPwned).toBeUndefined();
  });

  it('escapes hostile errors array in displayAgentCardsResults', () => {
    // The host div for this helper is no longer in the live HTML; inject one
    // so the function can render and we can assert on its output.
    const host = win.document.createElement('div');
    host.id = 'agent-cards-results';
    win.document.body.appendChild(host);

    const hostile = [
      {
        valid: false,
        agent_url: '<script>window.__cardsPwned = true;</script>',
        response_time_ms: 10,
        status_code: 500,
        errors: ['<img src=x onerror="window.__cardsErrPwned = true">'],
      },
    ];

    win.displayAgentCardsResults(hostile);

    expect(host.querySelectorAll('script').length).toBe(0);
    expect(host.querySelectorAll('img').length).toBe(0);
    const w = win as unknown as { __cardsPwned?: boolean; __cardsErrPwned?: boolean };
    expect(w.__cardsPwned).toBeUndefined();
    expect(w.__cardsErrPwned).toBeUndefined();
  });

  it('escapes hostile domain in the results heading', () => {
    const hostile = {
      domain: '<script>window.__domainPwned = true;</script>',
      found: false,
      validation: { valid: false, url: '', errors: [], warnings: [] },
      agent_cards: [],
    };

    win.displayValidationResults(hostile);

    const results = win.document.getElementById('validation-results') as HTMLElement;
    expect(results.querySelectorAll('script').length).toBe(0);
    expect((win as unknown as { __domainPwned?: boolean }).__domainPwned).toBeUndefined();
  });

  it('escapes hostile JSON in the raw data <pre> block', () => {
    const hostile = {
      domain: 'attacker.test',
      found: true,
      validation: {
        valid: true,
        url: 'https://attacker.test/.well-known/adagents.json',
        errors: [],
        warnings: [],
        raw_data: {
          authorized_agents: [
            {
              url: 'https://attacker.test/</pre><script>window.__rawPwned = true;</script><pre>',
            },
          ],
        },
      },
      agent_cards: [],
    };

    win.displayValidationResults(hostile);

    const results = win.document.getElementById('validation-results') as HTMLElement;
    // The <pre> block should not allow injected </pre><script>
    expect(results.querySelectorAll('script').length).toBe(0);
    expect((win as unknown as { __rawPwned?: boolean }).__rawPwned).toBeUndefined();
  });
});

describe('adagents-builder: legacy creator retired', () => {
  it('does not expose startCreating or updateUIForCreateOrUpdate on the window', () => {
    const { window } = createDOM();
    expect(typeof (window as unknown as Record<string, unknown>).startCreating).toBe('undefined');
    expect(typeof (window as unknown as Record<string, unknown>).updateUIForCreateOrUpdate).toBe('undefined');
  });
});
