import { decodeHtmlEntities } from '../../server/src/utils/html-entities.js';

describe('decodeHtmlEntities', () => {
  it('decodes hex character references', () => {
    expect(decodeHtmlEntities("&#x27;")).toBe("'");
    expect(decodeHtmlEntities("&#x22;")).toBe('"');
    expect(decodeHtmlEntities("IAB warns industry chasing &#x27;shiny pennies&#x27;")).toBe(
      "IAB warns industry chasing 'shiny pennies'"
    );
  });

  it('decodes decimal character references', () => {
    expect(decodeHtmlEntities("&#39;")).toBe("'");
    expect(decodeHtmlEntities("&#34;")).toBe('"');
    // High code point: right single quote (U+2019) - common in Adweek titles
    expect(decodeHtmlEntities("&#8217;")).toBe('\u2019');
    expect(decodeHtmlEntities("Read All of ADWEEK&#8217;s Year-Ahead")).toBe(
      "Read All of ADWEEK\u2019s Year-Ahead"
    );
  });

  it('decodes named entities', () => {
    expect(decodeHtmlEntities("&apos;")).toBe("'");
    expect(decodeHtmlEntities("&quot;")).toBe('"');
    expect(decodeHtmlEntities("&amp;")).toBe("&");
    expect(decodeHtmlEntities("&lt;")).toBe("<");
    expect(decodeHtmlEntities("&gt;")).toBe(">");
    expect(decodeHtmlEntities("&nbsp;")).toBe(" ");
  });

  it('decodes typographic entities', () => {
    expect(decodeHtmlEntities("&ndash;")).toBe('\u2013');
    expect(decodeHtmlEntities("&mdash;")).toBe('\u2014');
    expect(decodeHtmlEntities("&lsquo;")).toBe('\u2018');
    expect(decodeHtmlEntities("&rsquo;")).toBe('\u2019');
    expect(decodeHtmlEntities("&ldquo;")).toBe('\u201C');
    expect(decodeHtmlEntities("&rdquo;")).toBe('\u201D');
    expect(decodeHtmlEntities("&hellip;")).toBe('\u2026');
  });

  it('handles mixed content', () => {
    expect(
      decodeHtmlEntities("Tom &amp; Jerry said &ldquo;Hello&#x27;s World&rdquo;")
    ).toBe("Tom & Jerry said \u201CHello's World\u201D");
  });

  it('handles null and empty strings', () => {
    expect(decodeHtmlEntities('')).toBe('');
    // @ts-expect-error testing null handling
    expect(decodeHtmlEntities(null)).toBe(null);
    // @ts-expect-error testing undefined handling
    expect(decodeHtmlEntities(undefined)).toBe(undefined);
  });

  it('preserves strings without entities', () => {
    expect(decodeHtmlEntities("Hello World")).toBe("Hello World");
    expect(decodeHtmlEntities("No entities here!")).toBe("No entities here!");
  });

  it('handles emoji and high code points', () => {
    // Emoji encoded as decimal
    expect(decodeHtmlEntities("&#128512;")).toBe("😀");
    // Emoji encoded as hex
    expect(decodeHtmlEntities("&#x1F600;")).toBe("😀");
  });
});
