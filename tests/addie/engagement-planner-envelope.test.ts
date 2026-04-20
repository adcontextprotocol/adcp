import { describe, test, expect, vi } from 'vitest';

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import {
  parseEnvelope,
  extractUserFacingMessage,
} from '../../server/src/addie/services/engagement-planner.js';

describe('parseEnvelope', () => {
  test('parses a clean JSON envelope', () => {
    const out = parseEnvelope('{"text": "Hello"}');
    expect(out).toEqual({ text: 'Hello' });
  });

  test('parses a JSON envelope with surrounding whitespace', () => {
    const out = parseEnvelope('\n\n  {"text": "Hello"}  \n');
    expect(out).toEqual({ text: 'Hello' });
  });

  test('picks the LAST valid envelope when model reconsiders', () => {
    // Exact shape from production thread a88ea720 — Claude returned a draft,
    // then a reflection paragraph, then a revised draft. The revised one
    // (final decision after reconsideration) should win.
    const raw =
      '{"text": "Hey Luk — you joined a working group but I don\'t see any activity yet. Which one did you land in?"}\n\n' +
      'Wait, let me reconsider — that violates rule #3 (open-ended question) and rule on unreplied (2 unreplied = lighter touch, pure value, no asks).\n\n' +
      '{"text": "The agentic ads protocol docs just got a solid update — good reference if you\'re building in this space. Want me to drop the link?"}';

    const out = parseEnvelope(raw);
    expect(out).toBeDefined();
    expect(out?.text).toContain('agentic ads protocol docs');
    expect(out?.text).not.toContain('working group');
  });

  test('extracts JSON preceded by short reasoning prefix', () => {
    const raw = 'Thinking about this one — lighter touch seems right.\n\n{"text": "Hope all is well!"}';
    const out = parseEnvelope(raw);
    expect(out).toEqual({ text: 'Hope all is well!' });
  });

  test('parses email envelopes with nested quoted braces', () => {
    const out = parseEnvelope('{"subject": "Update", "body": "Your code: `if (x) {return}` — done."}');
    expect(out?.subject).toBe('Update');
    expect(out?.body).toContain('if (x)');
  });

  test('returns null on plain prose with no JSON object', () => {
    expect(parseEnvelope('Just a regular message with no JSON.')).toBeNull();
  });

  test('returns null on malformed JSON with no valid top-level object', () => {
    expect(parseEnvelope('{text: broken')).toBeNull();
  });

  test('handles escaped quotes inside strings without breaking bracket count', () => {
    const out = parseEnvelope('{"text": "She said \\"hi\\" — so I replied."}');
    expect(out?.text).toBe('She said "hi" — so I replied.');
  });

  test('handles braces inside strings without breaking bracket count', () => {
    const out = parseEnvelope('{"text": "Use {placeholder} syntax for templates."}');
    expect(out?.text).toBe('Use {placeholder} syntax for templates.');
  });

  test('passes over a {"skip": ...} control payload verbatim', () => {
    const out = parseEnvelope('{"skip": true, "reason": "nothing meaningful to say"}');
    expect(out).toEqual({ skip: true, reason: 'nothing meaningful to say' });
  });
});

describe('extractUserFacingMessage — JSON envelope stripping', () => {
  test('strips a bare JSON envelope paragraph that slipped through', () => {
    // If a JSON envelope fragment reaches the fallback path, it should be
    // dropped rather than sent to the user.
    const raw = '{"text": "Hey there!"}\n\nAnd some follow-up prose that actually belongs in the message.';
    const out = extractUserFacingMessage(raw, 'slack');
    expect(out).toBe('And some follow-up prose that actually belongs in the message.');
  });

  test('leaves prose that merely starts with a brace untouched', () => {
    const raw = '{Brace used stylistically} — this is a real user-facing message.';
    const out = extractUserFacingMessage(raw, 'slack');
    expect(out).toBe(raw);
  });

  test('returns null when only JSON envelopes and reasoning remain', () => {
    const raw =
      '{"text": "Draft one"}\n\n' +
      'Thinking about this one — lighter touch seems right.\n\n' +
      '{"text": "Draft two"}';
    const out = extractUserFacingMessage(raw, 'slack');
    expect(out).toBeNull();
  });
});
