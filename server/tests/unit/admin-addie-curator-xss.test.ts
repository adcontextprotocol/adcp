import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing section: ${start}`);
  return source.slice(startIndex, endIndex);
}

function loadUrlHelpers() {
  const source = readFileSync(join(process.cwd(), 'server/public/admin-addie.html'), 'utf8');
  const helperSource = section(source, 'function getSafeHttpUrl(value)', 'function copyThreadId(');
  const dom = new JSDOM('<body></body>');
  return new Function(
    'document',
    `${helperSource}\nreturn { getSafeHttpUrl, renderSafeHttpLink };`,
  )(dom.window.document) as {
    getSafeHttpUrl: (value: unknown) => string | null;
    renderSafeHttpLink: (value: unknown, label: unknown) => string;
  };
}

describe('admin Addie curator URL rendering', () => {
  it.each([
    'javascript:globalThis.__curatorXss = true',
    'data:text/html,<script>globalThis.__curatorXss = true</script>',
    'https://user:secret@example.com/private',
  ])('does not render a hostile stored URL as a link: %s', (url) => {
    const { getSafeHttpUrl, renderSafeHttpLink } = loadUrlHelpers();
    expect(getSafeHttpUrl(url)).toBeNull();
    expect(renderSafeHttpLink(url, url)).toBe('');
  });

  it('encodes quote-breaking URL text without creating event attributes', () => {
    const { renderSafeHttpLink } = loadUrlHelpers();
    const html = renderSafeHttpLink(
      'https://safe.example/\" onmouseover=\"globalThis.__curatorXss = true',
      'Source',
    );
    const dom = new JSDOM(`<body>${html}</body>`);
    const anchor = dom.window.document.querySelector('a');

    expect(anchor).not.toBeNull();
    expect(anchor?.hasAttribute('onmouseover')).toBe(false);
    expect(anchor?.href).toContain('%22%20onmouseover');
  });

  it('programmatically renders valid HTTP(S) URLs with inert labels', () => {
    const { renderSafeHttpLink } = loadUrlHelpers();
    const html = renderSafeHttpLink(
      'https://safe.example/article?a=1&b=2',
      '<img src=x onerror=globalThis.__curatorXss=true>',
    );
    const dom = new JSDOM(`<body>${html}</body>`);
    const anchor = dom.window.document.querySelector('a');

    expect(anchor?.href).toBe('https://safe.example/article?a=1&b=2');
    expect(anchor?.rel).toContain('noopener');
    expect(anchor?.querySelector('img')).toBeNull();
    expect(anchor?.textContent).toBe('<img src=x onerror=globalThis.__curatorXss=true>');
  });

  it('escapes relevance tags at the stored-content render sink', () => {
    const source = readFileSync(join(process.cwd(), 'server/public/admin-addie.html'), 'utf8');
    expect(source).toContain('Tags: ${escapeHtml(tags)}');
    expect(source).not.toContain('Tags: ${tags}');
  });
});
