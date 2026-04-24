import { describe, it, expect } from 'vitest';
import {
  summarizeAgents,
  buildReviewBlocks,
  sanitizeDraftForSlack,
} from '../../server/src/addie/jobs/announcement-trigger.js';

describe('summarizeAgents', () => {
  it('pulls agents from top-level array', () => {
    const manifest = {
      agents: [
        { type: 'sales_agent', description: 'CTV inventory' },
        { type: 'signals_agent' },
      ],
    };
    expect(summarizeAgents(manifest)).toEqual([
      { type: 'sales_agent', description: 'CTV inventory' },
      { type: 'signals_agent', description: null },
    ]);
  });

  it('pulls agents from nested brands[].agents', () => {
    const manifest = {
      brands: [
        { agents: [{ type: 'buyer_agent' }] },
        { agents: [{ type: 'creative_agent', description: 'HTML5 factory' }] },
      ],
    };
    expect(summarizeAgents(manifest)).toEqual([
      { type: 'buyer_agent', description: null },
      { type: 'creative_agent', description: 'HTML5 factory' },
    ]);
  });

  it('combines top-level and nested', () => {
    const manifest = {
      agents: [{ type: 'a' }],
      brands: [{ agents: [{ type: 'b' }] }],
    };
    expect(summarizeAgents(manifest).map((x) => x.type)).toEqual(['a', 'b']);
  });

  it('drops entries without a type', () => {
    const manifest = { agents: [{ description: 'x' }, { type: 'ok' }] };
    expect(summarizeAgents(manifest)).toEqual([{ type: 'ok', description: null }]);
  });

  it('returns [] for null or empty manifest', () => {
    expect(summarizeAgents(null)).toEqual([]);
    expect(summarizeAgents({})).toEqual([]);
  });
});

describe('buildReviewBlocks', () => {
  const base = {
    orgName: 'Acme Ad Tech',
    workosOrganizationId: 'org_123',
    slackText: 'Welcome Acme. They build buyer agents.',
    linkedinText: 'Welcome Acme to AAO.\n\n#AdvertisingAgents',
    visual: {
      url: 'https://cdn.example/acme.png',
      altText: 'Acme logo',
      source: 'brand_logo' as const,
    },
    profileSlug: 'acme',
  };

  it('includes a header, image block, and both drafts', () => {
    const { text, blocks } = buildReviewBlocks(base);
    expect(text).toContain('Acme Ad Tech');

    const header = blocks.find((b) => b.type === 'header');
    expect(header?.text?.text).toContain('Acme Ad Tech');

    const image = blocks.find((b) => b.type === 'image');
    expect(image?.image_url).toBe('https://cdn.example/acme.png');
    expect(image?.alt_text).toBe('Acme logo');

    const sections = blocks.filter((b) => b.type === 'section');
    const slackBlock = sections.find((s) => s.text?.text?.includes('Slack draft'));
    expect(slackBlock?.text?.text).toContain('Welcome Acme. They build buyer agents.');

    const liBlock = sections.find((s) => s.text?.text?.includes('LinkedIn draft'));
    expect(liBlock?.text?.text).toContain('```');
    expect(liBlock?.text?.text).toContain('#AdvertisingAgents');
  });

  it('emits three action buttons with the expected action_ids + org value', () => {
    const { blocks } = buildReviewBlocks(base);
    const actions = blocks.find((b) => b.type === 'actions');
    const ids = (actions?.elements ?? []).map((e) => (e as { action_id?: string }).action_id);
    expect(ids).toEqual([
      'announcement_approve_slack',
      'announcement_mark_linkedin',
      'announcement_skip',
    ]);
    for (const el of actions?.elements ?? []) {
      expect((el as { value?: string }).value).toBe('org_123');
    }
  });

  it('marks approve primary and skip danger', () => {
    const { blocks } = buildReviewBlocks(base);
    const actions = blocks.find((b) => b.type === 'actions');
    const byId = new Map<string, { style?: string }>();
    for (const el of actions?.elements ?? []) {
      const e = el as { action_id?: string; style?: string };
      if (e.action_id) byId.set(e.action_id, e);
    }
    expect(byId.get('announcement_approve_slack')?.style).toBe('primary');
    expect(byId.get('announcement_skip')?.style).toBe('danger');
    expect(byId.get('announcement_mark_linkedin')?.style).toBeUndefined();
  });

  it('neutralizes @channel, user tags, and backticks injected into drafts', () => {
    const hostile = {
      ...base,
      slackText: 'Welcome <!channel> — meet <@U12345> from <#C67890|random>!',
      linkedinText: 'Welcome `rm -rf` friends. ```evil``` #AAO',
    };
    const { blocks } = buildReviewBlocks(hostile);
    const sections = blocks.filter((b) => b.type === 'section');
    const slackBlock = sections.find((s) => s.text?.text?.includes('Slack draft'))!;
    expect(slackBlock.text!.text).not.toMatch(/<!channel>/);
    expect(slackBlock.text!.text).toMatch(/\[channel\]/);
    expect(slackBlock.text!.text).toMatch(/@user/);
    expect(slackBlock.text!.text).toMatch(/#channel/);

    const liBlock = sections.find((s) => s.text?.text?.includes('LinkedIn draft'))!;
    const inside = liBlock.text!.text.split('```')[1] ?? '';
    expect(inside).not.toMatch(/`/);
  });
});

describe('sanitizeDraftForSlack', () => {
  it('replaces channel/here/everyone mentions case-insensitively', () => {
    const out = sanitizeDraftForSlack('hey <!channel> and <!HERE> and <!Everyone>');
    expect(out).toBe('hey [channel] and [here] and [everyone]');
  });

  it('replaces user and channel mentions', () => {
    const out = sanitizeDraftForSlack('ping <@UABC123> in <#C9XYZ|general>');
    expect(out).toBe('ping @user in #channel');
  });

  it('only strips backticks when forFencedBlock is true', () => {
    expect(sanitizeDraftForSlack('a `b` c')).toBe('a `b` c');
    expect(sanitizeDraftForSlack('a `b` c', { forFencedBlock: true })).toBe("a 'b' c");
  });

  it('leaves regular text untouched', () => {
    const clean = 'Welcome to AAO — Acme builds buyer agents.';
    expect(sanitizeDraftForSlack(clean)).toBe(clean);
  });

  it('neutralizes user-group (subteam) pings', () => {
    expect(sanitizeDraftForSlack('cc <!subteam^S012ABC|@oncall>')).toBe('cc @group');
    expect(sanitizeDraftForSlack('cc <!subteam^S012ABC>')).toBe('cc @group');
  });

  it('handles enterprise-grid W-prefixed user mentions', () => {
    expect(sanitizeDraftForSlack('ping <@W012ABC>')).toBe('ping @user');
  });

  it('strips the label off linkified URLs so the raw URL is visible', () => {
    expect(
      sanitizeDraftForSlack('check <https://evil.example|totally legit aao.org> now'),
    ).toBe('check https://evil.example now');
    expect(sanitizeDraftForSlack('<https://agenticadvertising.org|AAO>')).toBe(
      'https://agenticadvertising.org',
    );
  });
});
