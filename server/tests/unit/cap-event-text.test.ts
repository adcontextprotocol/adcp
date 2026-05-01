import { describe, it, expect } from 'vitest';
import {
  buildMessageReceivedData,
  capEventText,
} from '../../src/db/person-events-db.js';

describe('capEventText', () => {
  it('returns short text unchanged', () => {
    const r = capEventText('hello world');
    expect(r.text).toBe('hello world');
    expect(r.truncated).toBe(false);
    expect(r.original_length).toBe(11);
  });

  it('returns the empty string unchanged', () => {
    const r = capEventText('');
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.original_length).toBe(0);
  });

  it('does not truncate text exactly at the byte cap', () => {
    const text = 'a'.repeat(64 * 1024); // 64KB ASCII = 64KB bytes
    const r = capEventText(text);
    expect(r.truncated).toBe(false);
    expect(r.text.length).toBe(64 * 1024);
    expect(r.original_length).toBe(64 * 1024);
  });

  it('truncates and flags when text exceeds the byte cap', () => {
    const text = 'a'.repeat(64 * 1024 + 100);
    const r = capEventText(text);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.original_length).toBe(64 * 1024 + 100);
  });

  it('preserves UTF-8 boundaries when truncating', () => {
    // 4-byte emoji × 20000 = 80,000 bytes (exceeds 64KB cap).
    // Note: JS string.length is UTF-16 code units, so '🎯'.length === 2.
    const text = '🎯'.repeat(20000);
    const r = capEventText(text);
    expect(r.truncated).toBe(true);
    // Round-trip through utf-8 must succeed (no broken multi-byte char)
    expect(() => Buffer.from(r.text, 'utf8').toString('utf8')).not.toThrow();
    expect(r.original_length).toBe(text.length);
  });

  it('reports original length via character count, not byte count', () => {
    // A 2-byte char × 100 chars = 200 bytes but 100 chars
    const text = 'é'.repeat(100);
    const r = capEventText(text);
    expect(r.original_length).toBe(100);
    expect(r.truncated).toBe(false);
  });
});

describe('buildMessageReceivedData', () => {
  it('builds the canonical shape for a short message', () => {
    const data = buildMessageReceivedData('hello there', 'dm');
    expect(data).toEqual({
      source: 'dm',
      text: 'hello there',
      text_length: 11,
    });
    expect(data).not.toHaveProperty('truncated');
  });

  it('flags truncated for an oversize message', () => {
    const data = buildMessageReceivedData('z'.repeat(70 * 1024), 'web_chat');
    expect(data.source).toBe('web_chat');
    expect(data.text_length).toBe(70 * 1024);
    expect(data.truncated).toBe(true);
    expect((data.text as string).length).toBeLessThanOrEqual(64 * 1024);
  });
});
