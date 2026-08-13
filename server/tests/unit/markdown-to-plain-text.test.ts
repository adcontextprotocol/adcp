import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';

const helperSource = readFileSync(
  join(process.cwd(), 'server/public/js/markdown-to-plain-text.js'),
  'utf8',
);

interface HelperWindow {
  document: Document;
  eval(source: string): unknown;
  marked: typeof marked;
  DOMPurify: { sanitize(dirty: string, config: unknown): string };
  markdownToPlainText(markdown: string): string;
}

function loadHelper(): { window: HelperWindow; sanitized: () => string } {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  const browserWindow = dom.window as unknown as HelperWindow;
  const purifier = createDOMPurify(dom.window);
  let sanitizedHtml = '';

  browserWindow.marked = marked;
  browserWindow.DOMPurify = {
    sanitize(dirty, config) {
      sanitizedHtml = String(purifier.sanitize(dirty, config as never));
      return sanitizedHtml;
    },
  };
  browserWindow.eval(helperSource);

  return { window: browserWindow, sanitized: () => sanitizedHtml };
}

describe('markdownToPlainText browser helper', () => {
  it('preserves readable block, table, break, and image-alt text', () => {
    const { window } = loadHelper();
    const result = window.markdownToPlainText(`# Growth

- First
- Second

| Outcome | Value |
| --- | --- |
| Brand | Strong |

![Council diagram](https://attacker.invalid/diagram.png)

line<br>break`);

    expect(result).toBe('Growth First Second Outcome Value Brand Strong Council diagram line break');
  });

  it('removes every resource-bearing tag and attribute before DOM insertion', () => {
    const { window, sanitized } = loadHelper();
    const result = window.markdownToPlainText(`
<video poster="https://attacker.invalid/poster.png"></video>
<svg><image href="https://attacker.invalid/image.png" xlink:href="https://attacker.invalid/xlink.png"></image></svg>
<div style="background:url(https://attacker.invalid/style.png)">Safe text</div>
<img alt="Useful alt" src="https://attacker.invalid/src.png" srcset="https://attacker.invalid/srcset.png 2x">
`);

    expect(result).toBe('Safe text Useful alt');
    expect(sanitized()).not.toMatch(/<(?:video|svg|image)\b/i);
    expect(sanitized()).not.toMatch(/\b(?:poster|href|xlink:href|style|src|srcset)\s*=/i);
    expect(sanitized()).toContain('<img alt="Useful alt">');
  });
});
