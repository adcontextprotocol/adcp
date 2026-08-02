import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async () => ({ rows: [{ agent_url: 'https://creative.example/mcp' }] })),
}));

vi.mock('../../src/db/client.js', () => ({ query: queryMock }));

import { AgentSnapshotDatabase } from '../../src/db/agent-snapshot-db.js';

describe('AgentSnapshotDatabase.filterCreativeAgents', () => {
  beforeEach(() => queryMock.mockClear());

  it('matches all exact-publisher predicates against one supported_formats entry', async () => {
    const db = new AgentSnapshotDatabase();
    const result = await db.filterCreativeAgents({
      format_kinds: ['video_hosted'],
      publisher_domain: 'Shorts.StreamHaus.Example',
      format_option_id: 'vertical_video',
      operations: ['build'],
    });

    expect(result).toEqual(new Set(['https://creative.example/mcp']));
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("jsonb_array_elements(creative_capabilities_json->'supported_formats') AS entry");
    expect(sql).toContain("entry->'format'->>'format_kind'");
    expect(sql).toContain("LOWER(entry->'format'->>'publisher_domain')");
    expect(sql).toContain("entry->'format'->>'format_option_id'");
    expect(sql).toContain("entry ? 'capability_id'");
    expect(sql).toContain("entry->'operations' ?|");
    expect(params).toEqual([
      ['video_hosted'],
      'shorts.streamhaus.example',
      'vertical_video',
      ['build'],
    ]);
  });

  it('filters by an agent-local capability ID', async () => {
    const db = new AgentSnapshotDatabase();
    await db.filterCreativeAgents({ capability_id: 'vertical_video_builder' });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("entry->>'capability_id'");
    expect(params).toEqual(['vertical_video_builder']);
  });
});

describe('AgentSnapshotDatabase.upsertCapabilities', () => {
  beforeEach(() => queryMock.mockClear());

  it('preserves the last good creative catalog when a later probe fails', async () => {
    const db = new AgentSnapshotDatabase();
    await db.upsertCapabilities({
      agent_url: 'https://creative.example/mcp',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: '2026-07-31T12:00:00.000Z',
      creative_capabilities_probe_failed: true,
    }, 'creative');

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WHEN $16::boolean THEN agent_capabilities_snapshot.creative_capabilities_json');
    expect(params[15]).toBe(true);
  });
});
