/**
 * Carry a company rename into values that were derived from the old name.
 *
 * A member's name shows up in several independent places (organization name,
 * member profile display_name, agent labels). They are separate on purpose,
 * but when a value still equals the old name it was almost certainly
 * defaulted from it, so a rename should follow. Values someone set
 * deliberately (anything that differs from the old name) are left alone.
 * See #7851.
 */

import type { AgentConfig, MemberProfile } from '../types.js';
import type { MemberDatabase } from '../db/member-db.js';

function normalize(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalize(a);
  return left !== '' && left === normalize(b);
}

/**
 * Rename a label that equals the old name, or starts with it as a whole word
 * ("Acme Sales Agent" -> "NewCo Sales Agent"). Returns null when the label
 * was not derived from the old name.
 */
export function renameDefaultedLabel(label: string | undefined, oldName: string, newName: string): string | null {
  if (!label || !oldName.trim() || !newName.trim()) return null;
  const trimmed = label.trim();
  const old = oldName.trim();
  if (sameName(trimmed, old)) return newName.trim();
  if (trimmed.length > old.length && trimmed.slice(0, old.length).toLowerCase() === old.toLowerCase()
    && /\s/.test(trimmed[old.length])) {
    return `${newName.trim()}${trimmed.slice(old.length)}`;
  }
  return null;
}

export function renameDefaultedAgentLabels(
  agents: AgentConfig[],
  oldName: string,
  newName: string,
): { agents: AgentConfig[]; changed: number } {
  let changed = 0;
  const next = agents.map((agent) => {
    const renamed = renameDefaultedLabel(agent.name, oldName, newName);
    if (renamed === null || renamed === agent.name) return agent;
    changed++;
    return { ...agent, name: renamed };
  });
  return { agents: next, changed };
}

/**
 * After an organization rename: update the member profile's display_name when
 * it still equals the old organization name, and the agent labels that were
 * derived from that display_name.
 */
export async function cascadeOrganizationRename(
  memberDb: Pick<MemberDatabase, 'getProfileByOrgId' | 'updateProfileByOrgId'>,
  orgId: string,
  oldName: string | null | undefined,
  newName: string,
): Promise<{ displayNameUpdated: boolean; agentLabelsUpdated: number }> {
  const none = { displayNameUpdated: false, agentLabelsUpdated: 0 };
  if (!oldName || sameName(oldName, newName)) return none;
  const profile: MemberProfile | null = await memberDb.getProfileByOrgId(orgId);
  if (!profile || !sameName(profile.display_name, oldName)) return none;

  const { agents, changed } = renameDefaultedAgentLabels(profile.agents ?? [], profile.display_name, newName);
  await memberDb.updateProfileByOrgId(orgId, {
    display_name: newName,
    ...(changed > 0 && { agents }),
  });
  return { displayNameUpdated: true, agentLabelsUpdated: changed };
}
