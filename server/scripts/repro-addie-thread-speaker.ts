#!/usr/bin/env npx tsx
/**
 * Repro: Addie thread-speaker identity bug.
 *
 * Replays the bug report transcript:
 *   Chris (non-member) shares feedback in #council-broadcast.
 *   Addie offers to draft a GitHub issue. Chris says "I'm not on github".
 *   Brian (admin) replies in the same thread: "@Addie can you make it a
 *   github issue please".
 *   Addie addressed the response to Chris and offered to escalate, instead
 *   of recognising Brian and calling create_github_issue.
 *
 * The script prints what the LLM saw before and after the fix so the
 * regression is visible without standing up the full Slack stack. With
 * `--execute` it also runs the prompt past Anthropic and prints which tool
 * the model decided to call.
 *
 * Usage:
 *   npx tsx scripts/repro-addie-thread-speaker.ts            # dry run
 *   npx tsx scripts/repro-addie-thread-speaker.ts --execute  # hits Anthropic
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env.local') });

import { buildMessageTurnsWithMetadata, type ThreadContextEntry } from '../src/addie/prompts.js';

const SHOULD_EXECUTE = process.argv.includes('--execute');

const CURRENT_USER_MESSAGE = '@Addie can you make it a github issue please';

const OLD_HISTORY: ThreadContextEntry[] = [
  { user: 'User', text: 'My feedback: structured brief / plan execution interface, JIC signal composition, measurement accreditation, seller reputation layer.' },
  { user: 'Addie', text: 'Substantive points. Want me to draft GitHub issues for #1 and #3?' },
  { user: 'User', text: '#1 is high priority — managing reach and frequency at the campaign planning level is significant.' },
  { user: 'Addie', text: 'Here is a draft. Click through to create it.' },
  { user: 'User', text: "ummm I'm not on github" },
  { user: 'Addie', text: 'No worries — I can post it on your behalf, or to the working group instead.' },
];

const NEW_HISTORY: ThreadContextEntry[] = OLD_HISTORY.map(entry =>
  entry.user === 'Addie'
    ? entry
    : { ...entry, user: 'Chris Williams' }
);

console.log('Repro: thread-speaker identity bug');
console.log('Current user message:', JSON.stringify(CURRENT_USER_MESSAGE));

const beforeResult = buildMessageTurnsWithMetadata(
  CURRENT_USER_MESSAGE,
  OLD_HISTORY,
  {},
);
console.log('\n=== BEFORE FIX (every turn labelled "user", no speaker hint) ===');
for (const turn of beforeResult.messages) {
  const tag = turn.role === 'user' ? 'USER' : 'ADDIE';
  console.log(`[${tag}] ${turn.content}`);
}

const afterResult = buildMessageTurnsWithMetadata(
  CURRENT_USER_MESSAGE,
  NEW_HISTORY,
  { currentSpeakerName: 'Brian OKelley' },
);
console.log('\n=== AFTER FIX (named speakers, current speaker stamped) ===');
for (const turn of afterResult.messages) {
  const tag = turn.role === 'user' ? 'USER' : 'ADDIE';
  console.log(`[${tag}] ${turn.content}`);
}

if (!SHOULD_EXECUTE) {
  console.log('\n(skipping live Anthropic call — pass --execute to hit the API)');
  process.exit(0);
}

const ANTHROPIC_API_KEY = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('\nERROR: ANTHROPIC_API_KEY (or ADDIE_ANTHROPIC_API_KEY) is required for --execute');
  process.exit(1);
}

const Anthropic = (await import('@anthropic-ai/sdk')).default;
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM = `You are Addie, an AI assistant for the AdCP protocol community.
Available tools:
- draft_github_issue: build a pre-filled github.com URL for the user to click and submit themselves. Use ONLY when the speaker can submit it themselves on GitHub.
- create_github_issue: file an issue on adcontextprotocol/adcp directly under the speaker's own GitHub account via OAuth. Requires the speaker to have GitHub connected.
- escalate_to_admin: hand off to a human admin. Use when the speaker says they cannot or will not file the issue themselves AND you do not believe create_github_issue will succeed for this speaker (e.g. they said they have no GitHub account).

Address your reply to the speaker who sent the most recent user message. Use their name if you can identify it.`;

const TOOLS = [
  {
    name: 'draft_github_issue',
    description: 'Generate a pre-filled github.com/issues/new URL for the user to click.',
    input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
  },
  {
    name: 'create_github_issue',
    description: 'File a GitHub issue directly under the speakers own GitHub account.',
    input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
  },
  {
    name: 'escalate_to_admin',
    description: 'Hand off to a human admin when no tool can fulfil the request.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
];

async function callClaude(label: string, turns: { role: 'user' | 'assistant'; content: string }[]) {
  console.log(`\n--- LIVE: ${label} ---`);
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM,
    tools: TOOLS,
    messages: turns,
  });
  for (const block of resp.content) {
    if (block.type === 'text') {
      console.log('TEXT:', block.text.slice(0, 600));
    } else if (block.type === 'tool_use') {
      console.log('TOOL_USE:', block.name, JSON.stringify(block.input).slice(0, 300));
    }
  }
  console.log('stop_reason:', resp.stop_reason);
}

await callClaude('BEFORE FIX', beforeResult.messages.map(m => ({ role: m.role, content: m.content })));
await callClaude('AFTER FIX', afterResult.messages.map(m => ({ role: m.role, content: m.content })));
