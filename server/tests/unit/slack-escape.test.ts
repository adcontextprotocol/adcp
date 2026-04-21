import { describe, it, expect } from 'vitest';
import { escapeSlackText } from '../../src/utils/slack-escape.js';

describe('escapeSlackText', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeSlackText('Hello world')).toBe('Hello world');
  });

  it('escapes angle brackets so Slack does not parse formatting commands', () => {
    // Without escaping, <!here> pings the channel. With escaping, it renders literally.
    expect(escapeSlackText('<!here> please review')).toBe('&lt;!here&gt; please review');
    expect(escapeSlackText('<!channel>')).toBe('&lt;!channel&gt;');
    expect(escapeSlackText('<@U12345>')).toBe('&lt;@U12345&gt;');
  });

  it('escapes ampersands to prevent double-unescaping', () => {
    expect(escapeSlackText('A & B')).toBe('A &amp; B');
    // Ampersand encoded first, so already-encoded entities become literals
    expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
  });

  it('truncates over-long strings with an ellipsis', () => {
    const long = 'a'.repeat(300);
    const result = escapeSlackText(long, 240);
    expect(result.length).toBe(241); // 240 chars + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not truncate strings within the limit', () => {
    const short = 'short title';
    expect(escapeSlackText(short, 240)).toBe('short title');
    expect(escapeSlackText(short, 240).endsWith('…')).toBe(false);
  });

  it('truncation counts escaped characters toward the limit', () => {
    // "<!here>" → "&lt;!here&gt;" (13 chars). If maxLength is 10, truncate.
    const result = escapeSlackText('<!here> please', 10);
    expect(result.length).toBe(11); // 10 + '…'
    expect(result.endsWith('…')).toBe(true);
  });
});
