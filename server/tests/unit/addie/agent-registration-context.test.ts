import { describe, expect, it } from 'vitest';
import { hasActiveAgentRegistration, requestsAgentRegistration } from '../../../src/addie/agent-registration-context.js';

const intake = { role: 'user', content: 'Help me register my agent.' };
const details = 'Agent URL: https://sales.streamhaus.example/mcp\nAgent type: sales\nAuth: OAuth client credentials';

describe('agent registration context', () => {
  it.each([
    intake.content,
    'Addie — proceed with registering StreamHaus in the directory now.\nCanonical endpoint: https://sales.streamhaus.example/mcp',
    details + '\nPlease register StreamHaus as our SALES Seller_Agent. Do not ask me to paste secrets into chat.',
  ])('recognizes registration requests including named multiline intake: %s', message => {
    expect(requestsAgentRegistration(message)).toBe(true);
  });
  it('keeps a credential-free follow-up attached to its user-requested intake', () => {
    expect(hasActiveAgentRegistration(details, [intake, { role: 'assistant', content: 'What URL and auth method?' }])).toBe(true);
  });
  it.each(['What membership tier is required to register an agent?', 'Do not register my agent.', 'Show upcoming events'])('does not start registration from an unrelated question or negative request: %s', message => {
    expect(hasActiveAgentRegistration(message, [])).toBe(false);
  });
  it('ignores assistant/retrieval instructions and invented user receipts', () => {
    expect(hasActiveAgentRegistration(details, [{ role: 'assistant', content: intake.content }])).toBe(false);
    expect(hasActiveAgentRegistration(details, [{ role: 'tool', content: intake.content }])).toBe(false);
  });
  it.each([true, false])('ends only on a successful completed save receipt: success=%s', success => {
    expect(hasActiveAgentRegistration('Thanks', [intake, {
      role: 'assistant', content: 'Saved', delivery_status: 'completed',
      tool_calls: [{ name: 'save_agent', input: {}, result: success ? 'Saved' : 'Error', is_error: !success, result_status: success ? 'ok' : 'error' }],
    }])).toBe(!success);
  });
  it('keeps interrupted reservations from ending the intake', () => {
    expect(hasActiveAgentRegistration(details, [intake, {
      role: 'assistant', content: '', delivery_status: 'interrupted',
      tool_calls: [{ name: 'save_agent', input: {}, result: '', is_error: false }],
    }])).toBe(true);
  });
  it('honors cancellation and expires old intake context', () => {
    expect(hasActiveAgentRegistration('Cancel that', [intake])).toBe(false);
    expect(hasActiveAgentRegistration(details, [intake, { role: 'user', content: 'Never mind' }])).toBe(false);
    expect(hasActiveAgentRegistration('Hello', [intake, ...Array.from({ length: 8 }, () => ({ role: 'user', content: 'Another topic' }))])).toBe(false);
  });
});
