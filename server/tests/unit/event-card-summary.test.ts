import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';

const publicDir = join(process.cwd(), 'server/public');
const plainTextHelper = readFileSync(join(publicDir, 'js/markdown-to-plain-text.js'), 'utf8');
const summaryHelper = readFileSync(join(publicDir, 'js/event-summary.js'), 'utf8');

interface EventWindow {
  eval(source: string): unknown;
  marked?: typeof marked;
  DOMPurify?: { sanitize(dirty: string, config?: unknown): string };
  eventCardSummary(event: Record<string, unknown>, max?: number): string;
}

function loadHelpers(withLibraries = true): EventWindow {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  const win = dom.window as unknown as EventWindow;
  if (withLibraries) {
    const purifier = createDOMPurify(dom.window);
    win.marked = marked;
    win.DOMPurify = { sanitize: (dirty, config) => String(purifier.sanitize(dirty, config as never)) };
  }
  win.eval(plainTextHelper);
  win.eval(summaryHelper);
  return win;
}

const MARKDOWN_DESCRIPTION = `## Agenda

Join **AAO members** for a [live walkthrough](https://example.org/agenda) of agentic buying, then stay for questions about infrastructure and activation workflows across the industry.

- Item one
- Item two`;

describe('/events card summary', () => {
  it('renders markdown to text instead of showing raw syntax', () => {
    const win = loadHelpers();
    const summary = win.eventCardSummary({ description: MARKDOWN_DESCRIPTION }, 500);
    expect(summary).toContain('Join AAO members for a live walkthrough of agentic buying');
    expect(summary).not.toMatch(/\*\*|##|\]\(|https:\/\/example\.org/);
  });

  it('truncates on a word boundary with an ellipsis', () => {
    const win = loadHelpers();
    const summary = win.eventCardSummary({ description: MARKDOWN_DESCRIPTION }, 150);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(151);
    const lastWord = summary.slice(0, -1).split(' ').pop()!;
    expect(MARKDOWN_DESCRIPTION).toMatch(new RegExp(`\\b${lastWord}\\b`));
  });

  it('prefers the short description and leaves short text whole', () => {
    const win = loadHelpers();
    expect(win.eventCardSummary({ short_description: 'A *short* one.', description: MARKDOWN_DESCRIPTION })).toBe('A short one.');
    expect(win.eventCardSummary({})).toBe('');
  });

  it('drops markup an attacker could put in a description', () => {
    const win = loadHelpers();
    const summary = win.eventCardSummary({ description: 'Hello <img src=x onerror=alert(1)> <script>alert(2)</script>world' });
    expect(summary).not.toContain('<');
    expect(summary).not.toContain('onerror');
    expect(summary).toContain('Hello');
  });

  it('strips markdown even when the CDN libraries failed to load', () => {
    const win = loadHelpers(false);
    const summary = win.eventCardSummary({ description: 'Join **us** for a [walkthrough](https://x.example).' });
    expect(summary).toBe('Join us for a walkthrough.');
  });

  it('events.html uses the helper instead of slicing raw markdown', () => {
    const html = readFileSync(join(publicDir, 'events.html'), 'utf8');
    expect(html).toContain('/js/event-summary.js');
    expect(html).toContain('eventCardSummary(event, 150)');
    expect(html).not.toContain('description?.substring(0, 150)');
  });
});
