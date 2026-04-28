import { describe, it, expect } from 'vitest';
import { matchRuleIdFromMessage } from '../../src/addie/home/builders/rules/prompt-rules.js';

describe('message_source CTA chip tagging', () => {
  it('detects known prompt-rule strings as CTA chips', () => {
    // These come from MEMBER_RULES / ADMIN_RULES and appear as suggested-prompt
    // buttons in the web UI and Slack home tab.
    expect(matchRuleIdFromMessage('What kinds of things can I ask you about?')).not.toBeNull();
    expect(matchRuleIdFromMessage("What's new at AgenticAdvertising.org?")).not.toBeNull();
    expect(matchRuleIdFromMessage('Pick up where I left off in certification.')).not.toBeNull();
  });

  it('returns null for organic (typed) messages', () => {
    expect(matchRuleIdFromMessage('How does the bid request flow work in practice?')).toBeNull();
    expect(matchRuleIdFromMessage('Can you show me an example storyboard YAML?')).toBeNull();
    expect(matchRuleIdFromMessage('My agent is returning a 401 on every task call')).toBeNull();
  });

  it('assigns cta_chip when a rule matches', () => {
    const ruleId = matchRuleIdFromMessage('What kinds of things can I ask you about?');
    const source = ruleId ? 'cta_chip' : 'typed';
    expect(source).toBe('cta_chip');
  });

  it('assigns typed when no rule matches', () => {
    const ruleId = matchRuleIdFromMessage('Walk me through the sync_accounts task parameters');
    const source = ruleId ? 'cta_chip' : 'typed';
    expect(source).toBe('typed');
  });

  it('handles null/empty input gracefully', () => {
    expect(matchRuleIdFromMessage(null)).toBeNull();
    expect(matchRuleIdFromMessage(undefined)).toBeNull();
    expect(matchRuleIdFromMessage('')).toBeNull();
    expect(matchRuleIdFromMessage('   ')).toBeNull();
  });
});
