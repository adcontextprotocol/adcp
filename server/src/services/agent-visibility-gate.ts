/**
 * Normalize a caller-supplied agents[] and enforce the visibility tier
 * gate. Non-API-access callers cannot set `visibility: 'public'`; any
 * such entries are downgraded to `members_only` and a structured warning
 * is emitted so the caller knows we coerced them. Shared between the
 * POST (create) and PUT (update) paths of /api/me/member-profile so
 * neither can be smuggled past the per-agent /publish tier check.
 */

import { isValidAgentVisibility, isValidAgentType } from '../types.js';
import type { AgentConfig, AgentVisibility } from '../types.js';
import { validateExternalUrl } from '../utils/url-security.js';

export interface VisibilityWarning {
  code: 'visibility_downgraded';
  /**
   * String identifier for what got downgraded — an agent URL, or the
   * sentinel `'profile'` when the profile-level `is_public` flag was
   * the target. Coerced to string at emit time so the wire shape is
   * trustworthy for clients that render it.
   */
  agent_url: string;
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
    const url = typeof a.url === 'string' ? a.url : String(a.url ?? '');
    if (visibility === 'public' && !callerHasApi) {
      warnings.push({
        code: 'visibility_downgraded',
        agent_url: url,
        requested: 'public',
        applied: 'members_only',
        reason: 'tier_required',
        message: 'Publicly listing an agent requires Professional tier or higher; stored as members_only instead.',
      });
      visibility = 'members_only';
    }
    // Drop unknown `type` values instead of casting — the field flows
    // into brand.json (`agentEntry.type`) so an arbitrary tenant string
    // would become a durable artifact in other members' manifests.
    const typeValue = typeof a.type === 'string' && isValidAgentType(a.type) ? a.type : undefined;
    // Validate health_check_url through the same SSRF guard the OAuth
    // token-endpoint path uses. Cloud-metadata hosts are always blocked;
    // production also rejects loopback / RFC1918. The dial-time guard in
    // `safeFetch` re-validates at TCP connect to close the rebind window.
    // Invalid values are dropped silently — this is an optional probe hint,
    // not a privileged credential, and a malformed value would otherwise
    // just fail the fallback fetch.
    let healthCheckUrl: string | undefined;
    if (typeof a.health_check_url === 'string' && a.health_check_url.length > 0) {
      const validated = validateExternalUrl(a.health_check_url);
      if (validated) healthCheckUrl = validated;
    }
    const cleaned: AgentConfig = {
      url,
      visibility,
      ...(typeof a.name === 'string' ? { name: a.name } : {}),
      ...(typeValue ? { type: typeValue } : {}),
      ...(healthCheckUrl ? { health_check_url: healthCheckUrl } : {}),
    };
    return cleaned;
  });
  return { agents, warnings };
}
