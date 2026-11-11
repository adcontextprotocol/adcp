import { describe, expect, it } from 'vitest';
import { neutralizeCssResources, sanitizeSvg } from '../../src/services/brand-logo-service.js';

const NESTED = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}#p`;

const sanitize = (markup: string) => sanitizeSvg(Buffer.from(markup)).toString('utf8');
const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`;

/** Every url(...) left in the output, with its target unquoted. */
function urlTargets(markup: string): string[] {
  return [...markup.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)].map((m) => m[2].trim());
}

function expectNoExternalReference(markup: string) {
  for (const target of urlTargets(markup)) expect(target.startsWith('#')).toBe(true);
  expect(markup).not.toMatch(/@import/i);
  expect(markup).not.toMatch(/data:/i);
  // Namespace declarations are identifiers, not references.
  expect(markup.replace(/\sxmlns(?::\w+)?="[^"]*"/g, '')).not.toMatch(/https?:|file:/i);
}

describe('sanitizeSvg: CSS resource references', () => {
  it('neutralises a url(data:…) fill attribute', () => {
    const out = sanitize(wrap(`<rect width="100" height="100" fill="url(${NESTED})"/>`));
    expectNoExternalReference(out);
    expect(out).toContain('fill="none"');
  });

  it('neutralises url(data:…) and @import inside <style>, keeping the rest of the stylesheet', () => {
    const out = sanitize(
      wrap(
        `<style>@import url(https://cdn.example/a.css); @import "file:///etc/b.css";` +
          `.cls-1{fill:#fff}.cls-2{fill:url(${NESTED})}</style>` +
          '<rect class="cls-1" width="10" height="10"/><rect class="cls-2" width="10" height="10"/>',
      ),
    );
    expectNoExternalReference(out);
    expect(out).toContain('<style>');
    expect(out).toContain('.cls-1{fill:#fff}');
    expect(out).toContain('.cls-2{fill:none}');
  });

  it.each(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'])(
    'neutralises an external url() in the %s attribute',
    (attribute) => {
      const out = sanitize(wrap(`<path d="M0 0L10 10" ${attribute}="url(https://evil.example/x.svg#a)"/>`));
      expectNoExternalReference(out);
      expect(out).toContain(`${attribute}="none"`);
    },
  );

  it('neutralises url() in a style attribute', () => {
    const out = sanitize(wrap(`<rect width="10" height="10" style="fill:url('${NESTED}');stroke:#000"/>`));
    expectNoExternalReference(out);
    expect(out).toContain('stroke:#000');
  });

  it('neutralises quoted, upper-case and spaced forms', () => {
    const out = sanitize(
      wrap(
        `<rect fill="URL( '${NESTED}' )"/><rect fill='url("${NESTED}")'/>` +
          `<style>.a{fill:Url(  ${NESTED}  )}</style>`,
      ),
    );
    expectNoExternalReference(out);
  });

  it('neutralises url() and @import spelled with CSS escapes', () => {
    const out = sanitize(
      wrap(`<style>@im\\70 ort "x.css"; .a{fill:u\\72l(${NESTED})}</style><rect fill="\\75 rl(${NESTED})"/>`),
    );
    expectNoExternalReference(out);
  });

  it('neutralises a src() reference', () => {
    expectNoExternalReference(sanitize(wrap(`<style>.a{fill:src("${NESTED}")}</style>`)));
  });

  it('keeps same-document #fragment references in attributes and stylesheets', () => {
    const out = sanitize(
      wrap(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient>' +
          '<clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
          '<style>.a{fill:url(#g)} .b{fill:url("#g")}</style>' +
          '<rect class="a" width="10" height="10" fill="url(#g)" clip-path="url(\'#c\')"/>',
      ),
    );
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('clip-path="url(\'#c\')"');
    expect(out).toContain('.a{fill:url(#g)}');
    expect(out).toContain('.b{fill:url("#g")}');
  });

  it('leaves an ordinary class-filled logo unchanged in substance', () => {
    const out = sanitize(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 20"><defs><style>.cls-1{fill:#e61d2b;}</style></defs>' +
        '<path class="cls-1" d="M0 0h60v20H0z"/></svg>',
    );
    expect(out).toContain('<style>.cls-1{fill:#e61d2b;}</style>');
    expect(out).toContain('class="cls-1"');
  });
});

describe('neutralizeCssResources', () => {
  it.each([
    ['url(#a)', 'url(#a)'],
    ["url('#a')", "url('#a')"],
    ['url( "#a" )', 'url( "#a" )'],
    ['url(#)', 'none'],
    ['url()', 'none'],
    ['url(a.svg#b)', 'none'],
    ['url(//evil.example/x)', 'none'],
    ['url(data:image/png;base64,AAAA)', 'none'],
    ['URL(x)', 'none'],
    ['src("x")', 'none'],
    ['url(x', 'none'],
    ['@import "a.css"; .a{fill:#fff}', ' .a{fill:#fff}'],
    ['@IMPORT url(a.css);', ''],
    ['u\\72l(x)', 'none'],
    ['\\75 rl(x)', 'none'],
    ['@im\\70 ort "a.css";', ''],
    ['.a\\:b{fill:#fff}', '.a\\:b{fill:#fff}'],
    ['.a\\:b{fill:u\\72l(x)}', '.a:b{fill:none}'],
    ['url(\\23 a)', 'url(\\23 a)'],
    ['fill:#fff', 'fill:#fff'],
  ])('%s → %s', (input, expected) => {
    expect(neutralizeCssResources(input)).toBe(expected);
  });
});
