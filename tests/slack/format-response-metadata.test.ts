import { describe, it, expect } from 'vitest';
import { formatSlackResponseMetadata } from '../../server/src/slack/client.js';

describe('formatSlackResponseMetadata', () => {
  it('joins messages into a parenthesised suffix', () => {
    // Slack returns the only diagnosis of *which* field/block failed
    // inside `response_metadata.messages`. Without surfacing this the
    // worker logs a bare "Slack API error: invalid_blocks" and we
    // have no way to tell whether the header was over the 150-char
    // cap, an image_url was unreachable, or a section text overran.
    const out = formatSlackResponseMetadata({
      ok: false,
      error: 'invalid_blocks',
      response_metadata: {
        messages: [
          '[ERROR] must be no longer than 150 characters [json-pointer:/blocks/0/text/text]',
        ],
      },
    });
    expect(out).toBe(
      ' ([ERROR] must be no longer than 150 characters [json-pointer:/blocks/0/text/text])',
    );
  });

  it('joins multiple messages with semicolons', () => {
    const out = formatSlackResponseMetadata({
      response_metadata: { messages: ['first', 'second', 'third'] },
    });
    expect(out).toBe(' (first; second; third)');
  });

  it('returns an empty string when there is no metadata', () => {
    expect(formatSlackResponseMetadata({})).toBe('');
    expect(formatSlackResponseMetadata({ response_metadata: {} })).toBe('');
    expect(formatSlackResponseMetadata({ response_metadata: { messages: [] } })).toBe('');
    expect(formatSlackResponseMetadata(null)).toBe('');
    expect(formatSlackResponseMetadata(undefined)).toBe('');
  });

  it('ignores non-string entries in messages', () => {
    const out = formatSlackResponseMetadata({
      response_metadata: { messages: ['ok', 42, null, 'fine'] },
    });
    expect(out).toBe(' (ok; fine)');
  });

  it('caps the summary so pathological responses can\'t flood Error.message', () => {
    // Many blocks failing at once can return very long messages; we
    // don't want multi-KB text traveling through `logger.error` into
    // #admin-errors.
    const longMsg = 'x'.repeat(2000);
    const out = formatSlackResponseMetadata({
      response_metadata: { messages: [longMsg] },
    });
    // 2 chars for the wrapping " ()" + capped summary
    expect(out.length).toBeLessThanOrEqual(1024 + 3);
    expect(out.endsWith('…)')).toBe(true);
  });
});
