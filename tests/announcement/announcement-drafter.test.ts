import { describe, it, expect } from 'vitest';
import { parseDrafterResponse } from '../../server/src/services/announcement-drafter.js';

describe('parseDrafterResponse', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"slack_text":"Welcome Acme","linkedin_text":"Welcome Acme to AAO."}';
    const out = parseDrafterResponse(raw);
    expect(out.slackText).toBe('Welcome Acme');
    expect(out.linkedinText).toBe('Welcome Acme to AAO.');
  });

  it('tolerates a ```json fenced block', () => {
    const raw = '```json\n{"slack_text":"a","linkedin_text":"b"}\n```';
    const out = parseDrafterResponse(raw);
    expect(out.slackText).toBe('a');
    expect(out.linkedinText).toBe('b');
  });

  it('tolerates an unlabeled ``` fenced block', () => {
    const raw = '```\n{"slack_text":"a","linkedin_text":"b"}\n```';
    const out = parseDrafterResponse(raw);
    expect(out.slackText).toBe('a');
  });

  it('trims surrounding whitespace on the texts', () => {
    const raw = '{"slack_text":"  hi  ","linkedin_text":"\\n x \\n"}';
    const out = parseDrafterResponse(raw);
    expect(out.slackText).toBe('hi');
    expect(out.linkedinText).toBe('x');
  });

  it('throws on non-JSON', () => {
    expect(() => parseDrafterResponse('sure thing boss')).toThrow(/non-JSON/);
  });

  it('throws when fields are missing', () => {
    expect(() => parseDrafterResponse('{"slack_text":"a"}')).toThrow(/missing/);
  });

  it('throws when fields are non-string', () => {
    expect(() => parseDrafterResponse('{"slack_text":1,"linkedin_text":"b"}')).toThrow(/missing/);
  });

  it('throws on empty strings', () => {
    expect(() => parseDrafterResponse('{"slack_text":"  ","linkedin_text":"b"}')).toThrow(/empty/);
  });
});
