import { describe, expect, it } from 'vitest';
import { serializeInlineScriptJson } from '../../src/utils/inline-script-json.js';

describe('inline script JSON serialization', () => {
  it('preserves data while preventing script-tag and line-separator breakout', () => {
    const serialized = serializeInlineScriptJson({
      title: '</script><script>alert(document.domain)</script>',
      separators: '\u2028\u2029',
    });

    expect(serialized).not.toContain('</script>');
    expect(serialized).toContain('\\u003c/script>');
    expect(serialized).toContain('\\u2028\\u2029');
    expect(JSON.parse(serialized)).toEqual({
      title: '</script><script>alert(document.domain)</script>',
      separators: '\u2028\u2029',
    });
  });
});
