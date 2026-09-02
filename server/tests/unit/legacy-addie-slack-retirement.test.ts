import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('legacy Addie Slack retirement', () => {
  it('does not retain the legacy direct-response runtime or AAO event dispatch', () => {
    const addieIndex = readFileSync(new URL('../../src/addie/index.ts', import.meta.url), 'utf8');
    const aaoEvents = readFileSync(new URL('../../src/slack/events.ts', import.meta.url), 'utf8');

    expect(addieIndex).not.toContain("from './handler.js'");
    expect(aaoEvents).not.toMatch(/\b(isAddieReady|handleAssistantThreadStarted|handleAssistantMessage|handleAppMention)\b/);
    expect(aaoEvents).not.toContain("case 'assistant_thread_started'");
    expect(aaoEvents).not.toContain("case 'app_mention'");
  });

  it('keeps the active Addie Slack endpoint Bolt-owned', () => {
    const slackRoutes = readFileSync(new URL('../../src/routes/slack.ts', import.meta.url), 'utf8');

    expect(slackRoutes).toContain('getAddieBoltRouter()');
    expect(slackRoutes).toContain('boltRouter(req, res, next);');
    expect(slackRoutes).not.toContain("addie/handler");
  });
});
