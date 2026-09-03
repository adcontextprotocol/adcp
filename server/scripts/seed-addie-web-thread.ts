#!/usr/bin/env npx tsx
/**
 * Seed a populated web chat thread.
 *
 * Local dev has no ANTHROPIC_API_KEY in docker-compose, so /chat can render
 * the shell but never a conversation. This writes a realistic thread straight
 * through ThreadService — same path the live chat uses — so the transcript UI,
 * the sidebar history, per-message feedback controls, and the admin
 * conversation viewer all have something to show.
 *
 * Usage (run on the host against the docker Postgres; scripts/ is not compiled
 * into dist/, so this only runs under tsx):
 *   DATABASE_URL="postgresql://adcp:localdev@localhost:$(docker compose port postgres 5432 | cut -d: -f2)/adcp_registry" \
 *     ./node_modules/.bin/tsx server/scripts/seed-addie-web-thread.ts
 *
 *   --user <key>    dev user that owns the thread (default: admin)
 *   --title <text>  thread title shown in the sidebar
 */

import { randomUUID } from 'crypto';
import { initializeDatabase, closeDatabase } from '../src/db/client.js';
import { getThreadService } from '../src/addie/thread-service.js';
import type { ModelExecution } from '../src/addie/model-providers/model-provider.js';

// Mirrors DEV_USERS in server/src/middleware/auth.ts. Duplicated rather than
// imported so this script doesn't pull in the WorkOS SDK or the prod-boot guard.
const DEV_USER_IDS: Record<string, { id: string; name: string }> = {
  admin: { id: 'user_dev_admin_001', name: 'Admin' },
  member: { id: 'user_dev_member_001', name: 'Member' },
  personal: { id: 'user_dev_personal_001', name: 'Personal' },
  nonmember: { id: 'user_dev_nonmember_001', name: 'Visitor' },
  leader: { id: 'user_dev_leader_001', name: 'Committee' },
};

const MODEL = 'claude-sonnet-5';

const EXECUTION: ModelExecution = {
  source: 'provider',
  requested_provider: 'anthropic',
  requested_model: MODEL,
  provider: 'anthropic',
  model: MODEL,
  model_resolution: 'exact',
  fallback_reason: null,
};

interface SeedTurn {
  user: string;
  assistant: string;
  tools?: string[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

const TURNS: SeedTurn[] = [
  {
    user: 'What is AdCP, and how is it different from OpenRTB?',
    assistant:
      "AdCP is an open standard for **advertising automation** — it gives AI agents a common vocabulary for discovering inventory, buying media, building creatives, and activating audiences.\n\nThe cleanest way to see the difference is by layer:\n\n| | OpenRTB | AdCP |\n|---|---|---|\n| **When** | Impression time (~100ms budget) | Planning time, then serve time |\n| **Who talks** | Exchange ↔ bidder | Agent ↔ agent |\n| **Shape** | One bid request, one response | Conversational tasks with state |\n\nAdCP spans two layers. The **negotiation layer** (Media Buy, Creative, Signals, Accounts, Governance, Brand) runs over MCP and A2A — that's where `get_products`, `create_media_buy`, and `build_creative` live. The **decisioning and serving layer** is the Trusted Match HTTP profile, which is where the impression-time latency budget actually applies.\n\nSo they aren't competitors. OpenRTB decides which bid wins; AdCP is how a buying agent got to the point of having something to bid on.",
    tools: ['search_docs'],
    latencyMs: 6420,
    tokensIn: 12840,
    tokensOut: 412,
  },
  {
    user: 'Which tasks would a buyer agent need to implement first?',
    assistant:
      "Start with the discovery-to-buy spine — four tasks get you a working buyer agent:\n\n1. **`get_products`** — inventory discovery. Send a brief, get back products that match. This is the one to build first because everything downstream depends on the product IDs it returns.\n2. **`create_media_buy`** — commits to packages. Note that it's async: you get a task back and poll or receive a webhook, you don't get a confirmed buy synchronously.\n3. **`get_media_buy_delivery`** — reporting. Needed sooner than teams expect, because without it you can't tell whether step 2 actually did anything.\n4. **`get_adcp_capabilities`** — capability negotiation. Cheap to implement, and it stops you from calling tasks the sell-side agent doesn't support.\n\nCreative is a separate surface (`build_creative`, `preview_creative`) and you can defer it if you're bringing your own hosted assets.\n\nOne thing worth deciding early: MCP or A2A transport. Both are normative, but the ergonomics differ — MCP if you're plugging into an existing agent client, A2A if you're running agent-to-agent with long-lived tasks.",
    tools: ['search_docs', 'ask_about_adcp_task'],
    latencyMs: 8910,
    tokensIn: 18220,
    tokensOut: 538,
  },
  {
    user: 'Is there a reference implementation I can read?',
    assistant:
      "Yes — a few, and they serve different purposes:\n\n- **Sell-side reference** is maintained by the [Prebid](https://www.prebid.org/) community. Spec governance (AgenticAdvertising.org) and reference-implementation development (Prebid) are deliberately separate organizations, so the reference doesn't get to define the spec by accident.\n- **`server/`** in the adcp repo is an illustrative registry/API/MCP implementation. Useful to read, explicitly *not* normative — the schemas in `static/schemas/source/` and the docs in `docs/` are the contract.\n- **Conformance** is measured independently by the grader and storyboards in `dist/compliance/`. If you want to know whether your agent is actually correct, run that rather than diffing against anyone's implementation.\n\nWant me to walk through the compliance runner setup for a buyer agent?",
    tools: ['search_repos', 'search_docs'],
    latencyMs: 5730,
    tokensIn: 21460,
    tokensOut: 356,
  },
];

function parseArgs(): { userKey: string; title: string } {
  const args = process.argv.slice(2);
  let userKey = 'admin';
  let title = 'AdCP vs OpenRTB, and where to start';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' && args[i + 1]) userKey = args[++i];
    else if (args[i] === '--title' && args[i + 1]) title = args[++i];
  }
  return { userKey, title };
}

async function main(): Promise<void> {
  const { userKey, title } = parseArgs();

  const devUser = DEV_USER_IDS[userKey];
  if (!devUser) {
    console.error(`Unknown dev user "${userKey}". Options: ${Object.keys(DEV_USER_IDS).join(', ')}`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    console.error('Local docker stack: DATABASE_URL=postgresql://adcp:localdev@localhost:$(docker compose port postgres 5432 | cut -d: -f2)/adcp_registry');
    process.exit(1);
  }

  initializeDatabase({ connectionString, ssl: false, maxPoolSize: 2 });

  const threads = getThreadService();
  const conversationId = randomUUID();

  const thread = await threads.getOrCreateThread({
    channel: 'web',
    external_id: conversationId,
    user_type: 'workos',
    user_id: devUser.id,
    user_display_name: devUser.name,
    context: { referrer: 'https://agenticadvertising.org/', user_agent: 'seed-addie-web-thread' },
    title,
  });

  for (const turn of TURNS) {
    await threads.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: turn.user,
      user_id: devUser.id,
      user_display_name: devUser.name,
      message_source: 'typed',
    });

    await threads.addMessage({
      thread_id: thread.thread_id,
      role: 'assistant',
      content: turn.assistant,
      model: MODEL,
      model_execution: EXECUTION,
      tools_used: turn.tools,
      latency_ms: turn.latencyMs,
      tokens_input: turn.tokensIn,
      tokens_output: turn.tokensOut,
      timing: {
        system_prompt_ms: 180,
        total_llm_ms: Math.round(turn.latencyMs * 0.7),
        total_tool_ms: Math.round(turn.latencyMs * 0.25),
        iterations: turn.tools ? turn.tools.length + 1 : 1,
      },
    });
  }

  await threads.updateThreadTitle(thread.thread_id, title);
  await closeDatabase();

  console.log('Seeded web chat thread');
  console.log(`  owner:           ${devUser.id} (dev user "${userKey}")`);
  console.log(`  conversation_id: ${conversationId}`);
  console.log(`  messages:        ${TURNS.length * 2}`);
  console.log('');
  console.log('To view it:');
  console.log('  1. Sign in at http://localhost:3000/dev-login.html as the matching dev user');
  console.log('  2. Open http://localhost:3000/chat');
  console.log('  3. Pick the thread from the sidebar History list');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
