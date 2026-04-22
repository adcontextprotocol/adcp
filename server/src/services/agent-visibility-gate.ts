/**
 * Normalize a caller-supplied agents[] and enforce the visibility tier
 * gate. Non-API-access callers cannot set `visibility: 'public'`; any
 * such entries are downgraded to `members_only` and a structured warning
 * is emitted so the caller knows we coerced them. Shared between the
 * POST (create) and PUT (update) paths of /api/me/member-profile so
 * neither can be smuggled past the per-agent /publish tier check.
 */

import { isValidAgentVisibility } from '../types.js';
import type { AgentConfig, AgentVisibility } from '../types.js';

export interface VisibilityWarning {
  code: 'visibility_downgraded';
  agent_url: unknown;
  requested: 'public';
  applied: 'members_only';
  reason: 'tier_required';
  message: string;
}

export function gateAgentVisibilityForCaller(
  rawAgents: unknown,
  callerHasApi: boolean,
): { agents: AgentConfig[]; warnings: VisibilityWarning[] } {
  if (!Array.isArray(rawAgents)) return { agents: [], warnings: [] };
  const warnings: VisibilityWarning[] = [];
  const agents = rawAgents.map((raw: unknown) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const requested = a.visibility;
    let visibility: AgentVisibility;
    if (isValidAgentVisibility(requested)) {
      visibility = requested;
    } else if (a.is_public === true) {
      visibility = 'public';
    } else {
      visibility = 'private';
    }
    if (visibility === 'public' && !callerHasApi) {
      warnings.push({
        code: 'visibility_downgraded',
        agent_url: a.url,
        requested: 'public',
        applied: 'members_only',
        reason: 'tier_required',
        message: 'Publicly listing an agent requires Professional tier or higher; stored as members_only instead.',
      });
      visibility = 'members_only';
    }
    const cleaned: AgentConfig = {
      url: String(a.url ?? ''),
      visibility,
      ...(typeof a.name === 'string' ? { name: a.name } : {}),
      ...(typeof a.type === 'string' ? { type: a.type as AgentConfig['type'] } : {}),
    };
    return cleaned;
  });
  return { agents, warnings };
}
