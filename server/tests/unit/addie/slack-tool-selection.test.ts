import { describe, expect, it } from 'vitest';
import {
  ADMIN_CHANNEL_WG_SLUG,
  hasActiveCertificationProgress,
  resolveRequiredSlackChannelContext,
  resolveSlackChannelPrivacy,
  selectSlackToolSets,
  SYSTEM_CHANNEL_TOOL_SETS,
  type SystemChannelRole,
} from '../../../src/addie/slack-tool-selection.js';

describe('Slack tool-set selection policy', () => {
  it('distinguishes an active module from the no-module certification warning', () => {
    expect(hasActiveCertificationProgress([])).toBe(false);
    expect(hasActiveCertificationProgress([{ status: 'completed' }])).toBe(false);
    expect(hasActiveCertificationProgress([{ status: 'in_progress' }])).toBe(true);
  });

  it.each([
    ['member DM', { source: 'dm', isAdmin: false }, ['knowledge']],
    ['admin DM', { source: 'dm', isAdmin: true }, ['knowledge']],
    ['private admin channel', { source: 'channel', isAdmin: true }, ['knowledge']],
    ['public admin channel', { source: 'channel', isAdmin: true }, ['knowledge']],
    [
      'admin working group',
      { source: 'channel', isAdmin: true, workingGroupSlug: ADMIN_CHANNEL_WG_SLUG },
      ['knowledge'],
    ],
  ] as const)('applies the normal %s policy', (_label, input, expected) => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['knowledge'],
      routerAvailable: true,
      ...input,
    })).toEqual(expected);
  });

  it('overrides router and admin sets for an active certification DM', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['billing', 'admin'],
      routerAvailable: true,
      source: 'dm',
      isAdmin: true,
      hasActiveCertification: true,
    })).toEqual(['certification', 'knowledge']);
  });

  it('applies the certification override when the router is unavailable', () => {
    expect(selectSlackToolSets({
      routerAvailable: false,
      source: 'dm',
      isAdmin: true,
      hasActiveCertification: true,
    })).toEqual(['certification', 'knowledge']);
  });

  it('does not treat a non-DM certification context as a routing override', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['knowledge'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      workingGroupSlug: ADMIN_CHANNEL_WG_SLUG,
      hasActiveCertification: true,
    })).toEqual(['knowledge']);
  });

  it.each(Object.entries(SYSTEM_CHANNEL_TOOL_SETS) as Array<[SystemChannelRole, readonly string[]]>) (
    'adds the exact %s system-channel sets for admins',
    (systemRole, requiredSets) => {
      expect(selectSlackToolSets({
        routerSelectedSets: ['knowledge'],
        routerAvailable: true,
        source: 'channel',
        isAdmin: true,
        systemRole,
      })).toEqual(['knowledge', ...requiredSets]);
    },
  );

  it('never grants server-owned admin sets to a non-admin', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['knowledge'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      workingGroupSlug: ADMIN_CHANNEL_WG_SLUG,
      systemRole: 'billing',
    })).toEqual(['knowledge']);
  });

  it('deduplicates router and server-owned sets without reordering them', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['billing'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      systemRole: 'billing',
    })).toEqual(['billing']);
  });

  it('adds Sponsored Intelligence tools for a relevant retrieval or active session', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['directory'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      hasSponsoredIntelligenceContext: true,
    })).toEqual(['directory', 'sponsored_intelligence']);

    expect(selectSlackToolSets({
      routerSelectedSets: ['sponsored_intelligence'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      hasSponsoredIntelligenceContext: true,
    })).toEqual(['sponsored_intelligence']);

    expect(selectSlackToolSets({
      routerAvailable: false,
      source: 'dm',
      isAdmin: false,
      hasSponsoredIntelligenceContext: true,
    })).toEqual(['knowledge', 'sponsored_intelligence']);
  });

  it('preserves an already-created legacy admin plan for continuity', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['admin'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
    })).toEqual(['admin']);
  });

  it('returns verified channel context from the required resolver', async () => {
    const context = { viewing_channel_is_private: false };
    await expect(resolveRequiredSlackChannelContext(
      'C123',
      async () => context,
    )).resolves.toBe(context);
    await expect(resolveRequiredSlackChannelContext(
      'C456',
      async () => ({ viewing_channel_is_private: true }),
    )).resolves.toEqual({ viewing_channel_is_private: true });
  });

  it.each([
    ['DM', { is_im: true }, true],
    ['multi-person DM', { is_mpim: true }, true],
    ['public channel', { is_private: false }, false],
    ['private channel', { is_private: true }, true],
    ['unclassified partial response', { name: 'unknown' }, null],
  ] as const)('normalizes %s privacy', (_label, channel, expected) => {
    expect(resolveSlackChannelPrivacy(channel)).toBe(expected);
  });

  it('fails closed when channel privacy is absent from partial context', async () => {
    await expect(resolveRequiredSlackChannelContext(
      'C123',
      async () => ({ viewing_channel_name: 'general' }),
    )).resolves.toBeNull();
  });

  it('fails closed when required channel context cannot be resolved', async () => {
    await expect(resolveRequiredSlackChannelContext(
      'C123',
      async () => { throw new Error('private resolver detail'); },
    )).resolves.toBeNull();
  });
});
