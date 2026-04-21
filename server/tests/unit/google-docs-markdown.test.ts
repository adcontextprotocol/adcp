import { describe, it, expect } from 'vitest';
import { extractMarkdownFromDocsResponse } from '../../src/addie/mcp/google-docs.js';

/**
 * Unit tests for the Google Docs API → markdown converter.
 * Feeds fixture Docs API response shapes through the converter and
 * asserts the markdown output preserves structure a reviewer expects.
 */

function paragraph(
  text: string,
  opts: {
    heading?: 'TITLE' | 'SUBTITLE' | `HEADING_${1|2|3|4|5|6}` | 'NORMAL_TEXT';
    bold?: boolean;
    italic?: boolean;
    link?: string;
    bullet?: { listId: string; nestingLevel?: number };
  } = {}
) {
  return {
    paragraph: {
      elements: [{
        textRun: {
          content: text,
          textStyle: {
            ...(opts.bold && { bold: true }),
            ...(opts.italic && { italic: true }),
            ...(opts.link && { link: { url: opts.link } }),
          },
        },
      }],
      paragraphStyle: { namedStyleType: opts.heading ?? 'NORMAL_TEXT' },
      ...(opts.bullet && { bullet: opts.bullet }),
    },
  };
}

describe('extractMarkdownFromDocsResponse', () => {
  it('renders a title and body as markdown', () => {
    const md = extractMarkdownFromDocsResponse({
      title: 'My Doc',
      body: { content: [
        paragraph('Launch', { heading: 'HEADING_1' }),
        paragraph('Body paragraph.\n'),
      ] },
    });
    expect(md).toContain('# Launch');
    expect(md).toContain('Body paragraph.');
  });

  it('renders all six heading levels', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [
        paragraph('H1', { heading: 'HEADING_1' }),
        paragraph('H2', { heading: 'HEADING_2' }),
        paragraph('H3', { heading: 'HEADING_3' }),
        paragraph('H4', { heading: 'HEADING_4' }),
        paragraph('H5', { heading: 'HEADING_5' }),
        paragraph('H6', { heading: 'HEADING_6' }),
      ] },
    });
    expect(md).toMatch(/^# H1$/m);
    expect(md).toMatch(/^## H2$/m);
    expect(md).toMatch(/^### H3$/m);
    expect(md).toMatch(/^#### H4$/m);
    expect(md).toMatch(/^##### H5$/m);
    expect(md).toMatch(/^###### H6$/m);
  });

  it('renders TITLE and SUBTITLE styles', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [
        paragraph('The Title', { heading: 'TITLE' }),
        paragraph('The Subtitle', { heading: 'SUBTITLE' }),
      ] },
    });
    expect(md).toMatch(/^# The Title$/m);
    expect(md).toMatch(/^## The Subtitle$/m);
  });

  it('preserves inline bold and italic', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [{
        paragraph: {
          elements: [
            { textRun: { content: 'hello ', textStyle: {} } },
            { textRun: { content: 'bold', textStyle: { bold: true } } },
            { textRun: { content: ' and ', textStyle: {} } },
            { textRun: { content: 'italic', textStyle: { italic: true } } },
            { textRun: { content: ' end\n', textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      }] },
    });
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
    expect(md).toContain('hello **bold** and *italic* end');
  });

  it('preserves links', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [{
        paragraph: {
          elements: [{
            textRun: {
              content: 'click here',
              textStyle: { link: { url: 'https://example.com' } },
            },
          }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      }] },
    });
    expect(md).toContain('[click here](https://example.com)');
  });

  it('stacks bold + link correctly', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [{
        paragraph: {
          elements: [{
            textRun: {
              content: 'bold link',
              textStyle: { bold: true, link: { url: 'https://example.com' } },
            },
          }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      }] },
    });
    expect(md).toContain('[**bold link**](https://example.com)');
  });

  it('renders bullet lists with unordered marker', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [
        paragraph('Item 1', { bullet: { listId: 'L1', nestingLevel: 0 } }),
        paragraph('Item 2', { bullet: { listId: 'L1', nestingLevel: 0 } }),
      ] },
      lists: { L1: { listProperties: { nestingLevels: [{ glyphType: 'GLYPH_TYPE_UNSPECIFIED' }] } } },
    });
    expect(md).toContain('- Item 1');
    expect(md).toContain('- Item 2');
  });

  it('renders ordered lists with numeric marker when glyph is DECIMAL', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [
        paragraph('First', { bullet: { listId: 'L1', nestingLevel: 0 } }),
        paragraph('Second', { bullet: { listId: 'L1', nestingLevel: 0 } }),
      ] },
      lists: { L1: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } },
    });
    expect(md).toContain('1. First');
    expect(md).toContain('1. Second');
  });

  it('indents nested list items by 2 spaces per level', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [
        paragraph('Top', { bullet: { listId: 'L1', nestingLevel: 0 } }),
        paragraph('Nested', { bullet: { listId: 'L1', nestingLevel: 1 } }),
        paragraph('Deep', { bullet: { listId: 'L1', nestingLevel: 2 } }),
      ] },
      lists: { L1: { listProperties: { nestingLevels: [
        { glyphType: 'BULLET' },
        { glyphType: 'BULLET' },
        { glyphType: 'BULLET' },
      ] } } },
    });
    expect(md).toMatch(/^- Top$/m);
    expect(md).toMatch(/^  - Nested$/m);
    expect(md).toMatch(/^    - Deep$/m);
  });

  it('renders tables as GFM pipe tables', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [{
        table: {
          tableRows: [
            { tableCells: [
              { content: [paragraph('Name')] },
              { content: [paragraph('Value')] },
            ] },
            { tableCells: [
              { content: [paragraph('Width')] },
              { content: [paragraph('100')] },
            ] },
          ],
        },
      }] },
    });
    expect(md).toContain('| Name | Value |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Width | 100 |');
  });

  it('escapes pipe characters in table cells', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [{
        table: {
          tableRows: [
            { tableCells: [
              { content: [paragraph('Header')] },
            ] },
            { tableCells: [
              { content: [paragraph('a|b')] },
            ] },
          ],
        },
      }] },
    });
    expect(md).toContain('| a\\|b |');
  });

  it('escapes backslashes before pipes in table cells (codeql 1304)', () => {
    // Without backslash-first escaping, `a\|b` becomes `a\\|b` which GFM
    // reads as "escaped backslash + literal pipe" and splits the cell.
    // With correct escaping, it becomes `a\\\|b` → "escaped backslash +
    // escaped pipe" which renders as the literal `a\|b` the user typed.
    const md = extractMarkdownFromDocsResponse({
      body: { content: [{
        table: {
          tableRows: [
            { tableCells: [
              { content: [paragraph('Header')] },
            ] },
            { tableCells: [
              { content: [paragraph('a\\|b')] },
            ] },
          ],
        },
      }] },
    });
    expect(md).toContain('| a\\\\\\|b |');
  });

  it('handles empty documents gracefully', () => {
    const md = extractMarkdownFromDocsResponse({ title: 'Empty', body: { content: [] } });
    expect(md).toBe('');
  });

  it('collapses runs of 3+ newlines to keep markdown compact', () => {
    const md = extractMarkdownFromDocsResponse({
      body: { content: [
        paragraph('One'),
        paragraph(''),
        paragraph(''),
        paragraph(''),
        paragraph('Two'),
      ] },
    });
    expect(md).not.toMatch(/\n{3,}/);
  });
});
