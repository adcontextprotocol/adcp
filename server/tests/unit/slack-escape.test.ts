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

  it('truncation caps raw input — escape expansion does not eat budget', () => {
    // Attacker stuffs 1000 `<` characters. Raw length is 1000, so we
    // truncate to 240 `<` before escaping. Escaped output is
    // 240 * len('&lt;') + '…' = 240*4 + 1 = 961. Without
    // truncate-first, a 240-char output cap would leave only ~60
    // attacker characters visible; an attacker could pad content with
    // cheap chars to push real content past the cutoff.
    const evil = '<'.repeat(1000);
    const result = escapeSlackText(evil, 240);
    expect(result).toBe('&lt;'.repeat(240) + '…');
    expect(result.length).toBe(240 * 4 + 1);
  });

  it('escape is applied after truncation, so short inputs are not mangled', () => {
    // "<!here>" is 7 chars, well under 240 — should escape cleanly
    // without losing characters to truncation.
    expect(escapeSlackText('<!here>', 240)).toBe('&lt;!here&gt;');
  });
});
