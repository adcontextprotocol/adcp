import { describe, it, expect } from 'vitest';
import { detectHallucinatedAction, HALLUCINATION_PATTERNS } from '../../../src/addie/hallucination-detect.js';

const NO_TOOLS: Array<{ tool_name: string; is_error: boolean }> = [];

function succeeded(tool_name: string) {
  return [{ tool_name, is_error: false }];
}

function failed(tool_name: string) {
  return [{ tool_name, is_error: true }];
}

describe('detectHallucinatedAction — null when clean', () => {
  it('returns null for text with no action claim', () => {
    expect(detectHallucinatedAction('Let me look into that for you.', NO_TOOLS)).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(detectHallucinatedAction('', NO_TOOLS)).toBeNull();
  });
});

describe('detectHallucinatedAction — ticket/issue creation patterns (#3720)', () => {
  const cases = [
    "I've created a ticket",
    "I've created ticket #228",
    "I've opened a ticket",
    "I created a ticket for you",
    "I've filed an issue",
    "I've opened an issue",
  ];

  for (const text of cases) {
    it(`fires on "${text}" when no tool succeeded`, () => {
      expect(detectHallucinatedAction(text, NO_TOOLS)).not.toBeNull();
    });

    it(`clear on "${text}" when escalate_to_admin succeeded`, () => {
      expect(detectHallucinatedAction(text, succeeded('escalate_to_admin'))).toBeNull();
    });

    it(`clear on "${text}" when create_github_issue succeeded`, () => {
      expect(detectHallucinatedAction(text, succeeded('create_github_issue'))).toBeNull();
    });
  }

  it('does NOT fire on bare ticket number reference (no creation verb)', () => {
    expect(detectHallucinatedAction("I don't see ticket #228 in the system.", NO_TOOLS)).toBeNull();
    expect(detectHallucinatedAction("Your reference number is ticket #45.", NO_TOOLS)).toBeNull();
  });
});

describe('detectHallucinatedAction — team-notified patterns (#3720)', () => {
  const firingCases = [
    "I've notified the team",
    "I notified the team",
    "I've alerted the team",
    "the team has been notified",
    "The team has been notified and will follow up.",
  ];

  for (const text of firingCases) {
    it(`fires on "${text}" when no tool succeeded`, () => {
      expect(detectHallucinatedAction(text, NO_TOOLS)).not.toBeNull();
    });

    it(`clear on "${text}" when escalate_to_admin succeeded`, () => {
      expect(detectHallucinatedAction(text, succeeded('escalate_to_admin'))).toBeNull();
    });
  }

  it('does NOT fire on future-tense team notification promise', () => {
    expect(detectHallucinatedAction("The team will be notified once the invoice is found.", NO_TOOLS)).toBeNull();
  });
});

describe('detectHallucinatedAction — flagged/escalated patterns (#3720)', () => {
  const firingCases = [
    "I've flagged this",
    "I've flagged the issue",
    "I've escalated this",
    "I've escalated the matter",
    "I've escalated the team",
    "I've notified the team",
  ];

  for (const text of firingCases) {
    it(`fires on "${text}" when no tool succeeded`, () => {
      expect(detectHallucinatedAction(text, NO_TOOLS)).not.toBeNull();
    });

    it(`clear on "${text}" when escalate_to_admin succeeded`, () => {
      expect(detectHallucinatedAction(text, succeeded('escalate_to_admin'))).toBeNull();
    });

    it(`clear on "${text}" when send_member_dm succeeded`, () => {
      expect(detectHallucinatedAction(text, succeeded('send_member_dm'))).toBeNull();
    });
  }
});

describe('detectHallucinatedAction — existing patterns still work', () => {
  it('fires on "invoice resent successfully" without tool', () => {
    expect(detectHallucinatedAction('Invoice resent successfully!', NO_TOOLS)).not.toBeNull();
  });

  it('clear on "invoice resent successfully" when send_invoice succeeded', () => {
    expect(detectHallucinatedAction('Invoice resent successfully!', succeeded('send_invoice'))).toBeNull();
  });

  it('fires on DM claim without tool', () => {
    expect(detectHallucinatedAction("I've sent a DM to that member.", NO_TOOLS)).not.toBeNull();
  });
});

describe('detectHallucinatedAction — failed tool does not clear the flag', () => {
  it('fires even when the expected tool was called but errored', () => {
    const text = "I've created a ticket";
    expect(detectHallucinatedAction(text, failed('escalate_to_admin'))).not.toBeNull();
  });
});

describe('HALLUCINATION_PATTERNS coverage', () => {
  it('contains all expected patterns', () => {
    expect(HALLUCINATION_PATTERNS.length).toBeGreaterThanOrEqual(12);
  });
});
