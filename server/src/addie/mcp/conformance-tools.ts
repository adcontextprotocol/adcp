/**
 * Addie tools for the conformance Socket Mode channel.
 *
 * Two tools, both bound to the caller's WorkOS organization:
 *
 *   - `issue_conformance_token` — mint a fresh JWT the adopter pastes
 *     into their `@adcp/sdk/server` ConformanceClient config.
 *   - `run_conformance_against_my_agent` — once the adopter has
 *     connected, run a storyboard against their dev MCP server and
 *     return a markdown report.
 *
 * Both tools require the caller to be mapped to a WorkOS organization
 * (memberContext.organization). Anonymous chats can't issue tokens or
 * run storyboards because the org binding is what scopes the socket
 * to a single tenant.
 *
 * Gated behind CONFORMANCE_SOCKET_ENABLED=1 at registration time —
 * see bolt-app.ts. The env-gate is intentional: it lets us land the
 * server-side plumbing dark and turn on the chat surface separately.
 */

import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import {
  issueConformanceToken,
  conformanceSessions,
  runStoryboardViaConformanceSocket,
  ConformanceNotConnectedError,
  StoryboardNotFoundError,
} from '../../conformance/index.js';
import type { StoryboardResult } from '@adcp/sdk/testing';
import { createLogger } from '../../logger.js';

const logger = createLogger('addie-conformance-tools');

function publicWsUrl(): string {
  const explicit = process.env.CONFORMANCE_WS_PUBLIC_URL;
  if (explicit) return explicit;
  const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  return base.replace(/^http/, 'ws') + '/conformance/connect';
}

function resolveOrgId(memberContext: MemberContext): string | null {
  return memberContext.organization?.workos_organization_id ?? null;
}

function notMappedHint(): string {
  return [
    "**Can't issue a conformance token — you're not mapped to an organization.**",
    '',
    'The conformance Socket Mode channel scopes connections per WorkOS organization, so we need to know which org owns the dev environment that\'ll be on the other end of the socket.',
    '',
    'Sign in with your AAO account (or finish org provisioning if you just signed up) and try again.',
  ].join('\n');
}

function notConnectedHint(orgId: string): string {
  return [
    `**No conformance connection is live for your org (${orgId}).**`,
    '',
    'To run conformance against your dev agent:',
    '',
    '1. Get a fresh token by asking me to `issue_conformance_token` (or POST `/api/conformance/token`).',
    '2. In your dev environment, install `@adcp/sdk` ≥ 6.9 and start the conformance client:',
    '',
    '```ts',
    "import { ConformanceClient } from '@adcp/sdk/server';",
    "import { mcpServer } from './my-mcp-server';",
    '',
    'const client = new ConformanceClient({',
    `  url: '${publicWsUrl()}',`,
    '  token: process.env.ADCP_CONFORMANCE_TOKEN!,',
    '  server: mcpServer,',
    '});',
    'await client.start();',
    '```',
    '',
    '3. Once you see `status=connected` in your console, ask me to run conformance again.',
  ].join('\n');
}

function formatStoryboardResult(result: StoryboardResult): string {
  const overall = result.overall_passed ? '✅ PASSED' : '❌ FAILED';
  const lines = [
    `### Conformance result — ${result.storyboard_title} (${result.storyboard_id})`,
    '',
    `**Overall:** ${overall}`,
    `**Steps passed/failed/skipped:** ${result.passed_count} / ${result.failed_count} / ${result.skipped_count}`,
    `**Duration:** ${result.total_duration_ms} ms`,
    '',
  ];

  for (const phase of result.phases) {
    lines.push(`#### ${phase.passed ? '✓' : '✗'} ${phase.phase_title}`);
    for (const step of phase.steps) {
      const tag = step.skipped ? '⊘ skipped' : step.passed ? '✓ passed' : '✗ failed';
      lines.push(`- ${tag} — ${step.title}`);
      if (!step.passed && !step.skipped) {
        const errMsg = (step as unknown as { error?: string }).error;
        if (errMsg) {
          const trimmed = errMsg.length > 240 ? errMsg.slice(0, 240) + '…' : errMsg;
          lines.push(`  - error: ${trimmed}`);
        }
      }
    }
    lines.push('');
  }

  if (result.failed_count > 0) {
    lines.push('Run again after fixing the failing steps. Adopter-side disconnects in the middle of a run currently fail in-flight steps — restart the conformance client and re-run.');
  }

  return lines.join('\n');
}

export const CONFORMANCE_TOOLS: AddieTool[] = [
  {
    name: 'issue_conformance_token',
    description:
      "Issue a short-lived JWT (1h TTL) the adopter pastes into their `@adcp/sdk/server` ConformanceClient config to connect their dev/staging MCP server outbound to Addie's conformance channel. The token is bound to the caller's WorkOS organization. Use this when the user is building an AdCP agent and wants Addie to run conformance/compliance tests against their dev environment without exposing it publicly. Returns the token, the WebSocket URL, and the expiry time.",
    usage_hints:
      'use for "give me a conformance token", "I want to test my AdCP agent with Addie", "how do I connect my dev agent to you", or any "Addie pair-program my agent" framing. Pair with run_conformance_against_my_agent once the adopter has the client running.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_conformance_against_my_agent',
    description:
      'Run a compliance storyboard against the adopter MCP server connected to this Addie session via Socket Mode. The adopter must have started `@adcp/sdk/server` ConformanceClient with a token issued in this same chat session — the channel routes by WorkOS organization id. Returns a markdown report with phase/step pass/fail/skipped status and trimmed error text on failures. Use this after the user confirms their conformance client shows `status=connected`.',
    usage_hints:
      'use for "run conformance on my agent", "test my agent against media-buy storyboards", "check my creative agent compliance". Requires a live conformance connection — if there isn\'t one, the tool returns a hint pointing the user at issue_conformance_token first.',
    input_schema: {
      type: 'object',
      properties: {
        storyboard_id: {
          type: 'string',
          description:
            'The storyboard id to run (e.g. `media_buy_state_machine`). Use list_storyboards (in agent_testing) to discover available ids if the user is unsure.',
        },
      },
      required: ['storyboard_id'],
    },
  },
];

export function createConformanceToolHandlers(
  memberContext: MemberContext,
): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  handlers.set('issue_conformance_token', async () => {
    const orgId = resolveOrgId(memberContext);
    if (!orgId) return notMappedHint();

    let issued;
    try {
      issued = issueConformanceToken(orgId);
    } catch (err) {
      logger.error({ err, orgId }, 'issue_conformance_token failed');
      return [
        '**Error issuing token.**',
        '',
        'The conformance channel is not configured on this Addie instance (CONFORMANCE_JWT_SECRET is missing). Reach out in #aao-engineering.',
      ].join('\n');
    }

    const url = publicWsUrl();
    const expiresAtIso = new Date(issued.expiresAt * 1000).toISOString();
    return [
      '**Conformance token issued.** Bound to your organization, expires in 1h.',
      '',
      'Paste these into your dev environment and start the conformance client:',
      '',
      '```sh',
      `export ADCP_CONFORMANCE_URL=${url}`,
      `export ADCP_CONFORMANCE_TOKEN=${issued.token}`,
      '```',
      '',
      `Expires at: \`${expiresAtIso}\``,
      '',
      'Three-line integration with `@adcp/sdk` ≥ 6.9:',
      '',
      '```ts',
      "import { ConformanceClient } from '@adcp/sdk/server';",
      "import { mcpServer } from './my-mcp-server';",
      '',
      'const client = new ConformanceClient({',
      '  url: process.env.ADCP_CONFORMANCE_URL!,',
      '  token: process.env.ADCP_CONFORMANCE_TOKEN!,',
      '  server: mcpServer,',
      '});',
      'await client.start();',
      '```',
      '',
      'Once your console shows `status=connected`, ask me to run conformance against your agent.',
    ].join('\n');
  });

  handlers.set('run_conformance_against_my_agent', async (input) => {
    const orgId = resolveOrgId(memberContext);
    if (!orgId) return notMappedHint();

    const storyboardId = typeof input.storyboard_id === 'string' ? input.storyboard_id : '';
    if (!storyboardId) {
      return '**`storyboard_id` is required.** Try `media_buy_state_machine` for a sales agent or list storyboards via the `agent_testing` toolset.';
    }

    if (!conformanceSessions.get(orgId)) {
      return notConnectedHint(orgId);
    }

    try {
      const result = await runStoryboardViaConformanceSocket(orgId, storyboardId);
      return formatStoryboardResult(result);
    } catch (err) {
      if (err instanceof ConformanceNotConnectedError) {
        return notConnectedHint(orgId);
      }
      if (err instanceof StoryboardNotFoundError) {
        return [
          `**Unknown storyboard:** \`${storyboardId}\`.`,
          '',
          'I list available storyboards via the `agent_testing` toolset — try \`list_storyboards\` first if you\'re not sure which id to use.',
        ].join('\n');
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, orgId, storyboardId }, 'run_conformance_against_my_agent failed');
      return [
        `**Error running conformance:** ${message.slice(0, 500)}`,
        '',
        'If the adopter-side socket disconnected mid-run, restart the conformance client and try again.',
      ].join('\n');
    }
  });

  return handlers;
}
