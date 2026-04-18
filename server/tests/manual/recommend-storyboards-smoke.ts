/**
 * Smoke test: Addie's recommend_storyboards handler end-to-end.
 *
 * Calls the tool handler directly against a live agent and prints the
 * markdown output the member would see. Use this to eyeball formatting
 * before shipping UI changes.
 *
 * Usage: npx tsx server/tests/manual/recommend-storyboards-smoke.ts [agent_url]
 */

import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';
import type { MemberContext } from '../../src/addie/member-context.js';
import { PUBLIC_TEST_AGENT } from '../../src/config/test-agent.js';

const agentUrl = process.argv[2] || PUBLIC_TEST_AGENT.url;

const mockCtx: MemberContext = {
  workos_user: {
    workos_user_id: 'smoke',
    email: 'smoke@test.local',
    first_name: 'Smoke',
    last_name: 'Test',
  },
  organization: null,
  member_profile: null,
  conversation_id: 'smoke',
  thread_id: null,
  relationship: null,
};

async function main() {
  const handlers = createMemberToolHandlers(mockCtx);
  const handler = handlers.get('recommend_storyboards');
  if (!handler) throw new Error('recommend_storyboards handler not registered');

  const output = await handler({ agent_url: agentUrl });
  console.log(output);
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
