import { describe, it, expect } from 'vitest';
import {
  escapeSlackText,
  flattenToSingleLine,
  isSafeSlackLinkTarget,
  sanitizeSlackLine,
  sanitizeSlackLinkLabel,
} from '../../src/utils/slack-escape.js';

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

describe('flattenToSingleLine', () => {
  it('collapses newlines so untrusted text cannot forge extra message lines', () => {
    // Without flattening, an agent error of "boom\nStatus: passing" renders
    // as a second line the reader attributes to us.
    expect(flattenToSingleLine('boom\nStatus: passing')).toBe('boom Status: passing');
    expect(flattenToSingleLine('a\r\n\tb   c')).toBe('a b c');
  });

  it('strips control characters that hide structure from a human reader', () => {
    expect(flattenToSingleLine('a\u0000b\u001fc\u007fd')).toBe('a b c d');
  });

  it('does not escape — that is the caller surface\'s job', () => {
    expect(flattenToSingleLine('<!channel> & <b>')).toBe('<!channel> & <b>');
  });

  it('truncates after collapsing, so whitespace padding cannot push content out', () => {
    const padded = `${' '.repeat(500)}real content`;
    expect(flattenToSingleLine(padded, 20)).toBe('real content');
  });

  it('still finds the content when padding exceeds the fast-path window', () => {
    // The fast path only looks at maxLength * 32 characters. An agent that
    // prefixes its error with more padding than that would otherwise get an
    // empty string stored — choosing, in effect, what its own owner is told.
    const buried = `${' '.repeat(20_000)}ECONNREFUSED`;
    expect(flattenToSingleLine(buried, 50)).toBe('ECONNREFUSED');
    expect(flattenToSingleLine(`${'\u0000'.repeat(20_000)}ECONNREFUSED`, 50)).toBe('ECONNREFUSED');
  });

  it('caps inputs far past the limit', () => {
    const huge = 'x'.repeat(1_000_000);
    expect(flattenToSingleLine(huge, 50)).toBe(`${'x'.repeat(50)}…`);
  });

  it('returns empty for input that is only padding', () => {
    expect(flattenToSingleLine(' '.repeat(20_000), 50)).toBe('');
  });
});

describe('sanitizeSlackLinkLabel', () => {
  it('drops the pipe that escaping alone leaves able to restructure a link', () => {
    // `<url|label>`: a `|` inside the label starts another field, so
    // escaping angle brackets is not enough on its own.
    expect(sanitizeSlackLinkLabel('Post|https://evil.example')).toBe('Posthttps://evil.example');
    expect(sanitizeSlackLinkLabel('<!channel> title')).toBe('&lt;!\u200bchannel&gt; title');
  });
});

describe('isSafeSlackLinkTarget', () => {
  it('accepts ordinary http(s) targets', () => {
    expect(isSafeSlackLinkTarget('https://agenticadvertising.org/registry?tab=agents')).toBe(true);
    expect(isSafeSlackLinkTarget('https://zoom.us/j/123?pwd=abc')).toBe(true);
  });

  it('rejects anything that would break out of <url|label> syntax', () => {
    // A `>` closes the link and leaves the rest as top-level mrkdwn; a
    // `|` adds another field and relabels it.
    expect(isSafeSlackLinkTarget('https://ok.example/a>b')).toBe(false);
    expect(isSafeSlackLinkTarget('https://ok.example/a|b')).toBe(false);
    expect(isSafeSlackLinkTarget('https://ok.example/a b')).toBe(false);
    expect(isSafeSlackLinkTarget('javascript:alert(1)')).toBe(false);
    expect(isSafeSlackLinkTarget('')).toBe(false);
  });
});

describe('sanitizeSlackLine', () => {
  it('flattens and escapes in one step for text written straight into Slack', () => {
    // The zero-width space keeps the broadcast token defused even if
    // something downstream unescapes the angle brackets.
    expect(sanitizeSlackLine('<!channel>\nping')).toBe('&lt;!\u200bchannel&gt; ping');
  });

  it('never lets a forged link survive', () => {
    expect(sanitizeSlackLine('<https://evil.example|agenticadvertising.org>'))
      .toBe('&lt;https://evil.example|agenticadvertising.org&gt;');
  });
});

