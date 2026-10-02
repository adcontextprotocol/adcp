import { describe, it, expect, vi } from 'vitest';
import {
  cascadeOrganizationRename,
  renameDefaultedAgentLabels,
  renameDefaultedLabel,
  sameName,
} from '../../src/services/identity-rename.js';
import type { AgentConfig } from '../../src/types.js';

describe('renameDefaultedLabel', () => {
  it('renames labels equal to the old name or starting with it as a whole word', () => {
    expect(renameDefaultedLabel('Acme', 'Acme', 'NewCo')).toBe('NewCo');
    expect(renameDefaultedLabel('  acme ', 'Acme', 'NewCo')).toBe('NewCo');
    expect(renameDefaultedLabel('Acme Sales Agent', 'Acme', 'NewCo')).toBe('NewCo Sales Agent');
  });

  it('leaves labels someone set deliberately', () => {
    expect(renameDefaultedLabel('Acmeville Sales', 'Acme', 'NewCo')).toBeNull();
    expect(renameDefaultedLabel('Sales by Acme', 'Acme', 'NewCo')).toBeNull();
    expect(renameDefaultedLabel(undefined, 'Acme', 'NewCo')).toBeNull();
    expect(renameDefaultedLabel('Acme', ' ', 'NewCo')).toBeNull();
  });
});

describe('renameDefaultedAgentLabels', () => {
  it('only touches derived labels and reports how many changed', () => {
    const agents = [
      { url: 'https://a.example/mcp', visibility: 'public', name: 'Acme' },
      { url: 'https://b.example/mcp', visibility: 'public', name: 'Custom Seller' },
      { url: 'https://c.example/mcp', visibility: 'public' },
    ] as AgentConfig[];
    const { agents: next, changed } = renameDefaultedAgentLabels(agents, 'Acme', 'NewCo');
    expect(changed).toBe(1);
    expect(next.map((a) => a.name)).toEqual(['NewCo', 'Custom Seller', undefined]);
    expect(agents[0].name).toBe('Acme');
  });
});

describe('cascadeOrganizationRename', () => {
  function db(profile: unknown) {
    return { getProfileByOrgId: vi.fn().mockResolvedValue(profile), updateProfileByOrgId: vi.fn().mockResolvedValue(profile) };
  }

  it('updates a display_name that still equals the old org name, plus its agent labels', async () => {
    const memberDb = db({ display_name: 'Acme', agents: [{ url: 'https://a.example/mcp', visibility: 'public', name: 'Acme Agent' }] });
    const result = await cascadeOrganizationRename(memberDb as any, 'org_1', 'Acme', 'NewCo');
    expect(result).toEqual({ displayNameUpdated: true, agentLabelsUpdated: 1 });
    expect(memberDb.updateProfileByOrgId).toHaveBeenCalledWith('org_1', {
      display_name: 'NewCo',
      agents: [{ url: 'https://a.example/mcp', visibility: 'public', name: 'NewCo Agent' }],
    });
  });

  it('leaves a display_name the member chose', async () => {
    const memberDb = db({ display_name: 'Acme Media Group', agents: [] });
    expect(await cascadeOrganizationRename(memberDb as any, 'org_1', 'Acme', 'NewCo')).toEqual({ displayNameUpdated: false, agentLabelsUpdated: 0 });
    expect(memberDb.updateProfileByOrgId).not.toHaveBeenCalled();
  });

  it('does nothing without a previous name or a profile', async () => {
    expect(await cascadeOrganizationRename(db(null) as any, 'org_1', 'Acme', 'NewCo')).toEqual({ displayNameUpdated: false, agentLabelsUpdated: 0 });
    expect(await cascadeOrganizationRename(db({ display_name: 'Acme' }) as any, 'org_1', null, 'NewCo')).toEqual({ displayNameUpdated: false, agentLabelsUpdated: 0 });
    expect(sameName('Acme', 'acme ')).toBe(true);
  });
});
